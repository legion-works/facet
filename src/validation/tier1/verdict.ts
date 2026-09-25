/**
 * Tier 1 verdict taxonomy.
 *
 * `deriveVerdict` is the SOLE component that decides a `RenderStatus`
 * from the raw probe surface. It is pure: no IO, no time, no random
 * ids. Every other layer depends on this contract, so the decision
 * tree is exhaustively unit-tested in `tests/unit/verdict.test.ts`.
 *
 * Trust ordering:
 *   protocol observation (CDP DOMSnapshot / DOM.getDocument)
 *   > isolated-world observation (Runtime.evaluate)
 *   > page-shim self-report (UNTRUSTED — page JavaScript can lie)
 *
 * A divergence between any pair up-ranks to the higher-authority
 * channel's view; when shim contradicts protocol, status is `tampered`.
 * Lifecycle failures (`renderComplete: false`) win over content
 * comparisons — a verifier that never observed the render-complete
 * barrier cannot honestly report `ok`, so the answer is `timeout`.
 *
 * Layout observability is its own axis: a renderer that produced
 * SVGs with zeroed viewBoxes (visible bounds of 0×0) cannot have its
 * layout verified. That is `partial:layout_unverified`, NOT `ok`,
 * even when the counts match the lexical expectation.
 */

import type {
  LexicalCounters,
  ProtocolObservation,
  RenderStatus,
} from "../../shared/contracts/validation";
import {
  HTML_OBSERVED_COUNT_KEYS,
  OBSERVED_COUNT_KEYS,
} from "../../shared/contracts/observed-counts";

// Re-export the protocol observation shape so the verdict tests can
// typecheck without re-importing the validation contract.
export type { ProtocolObservation };

/**
 * The page shim's self-reported counts. UNTRUSTED — page JavaScript
 * can monkey-patch `document.querySelectorAll` and report whatever it
 * likes. The verifier treats shim counts as advisory only.
 */
export type PageShim = Pick<
  ProtocolObservation,
  (typeof COUNT_COMPARISON_KEYS)[number] | "html" | "errorCount" | "emptyRendererRoot"
>;

export type CountsLike = Pick<
  ProtocolObservation,
  (typeof COUNT_COMPARISON_KEYS)[number] | "html" | "errorCount" | "emptyRendererRoot"
>;

const COUNT_COMPARISON_KEYS = OBSERVED_COUNT_KEYS;

/**
 * Which optional probe channels produced a usable observation. The
 * protocol channel is always populated (a missing protocol result is
 * a system-level failure, not a verdict-level one); shim and isolated
 * are best-effort and may legitimately be null.
 */
export interface ChannelSummary {
  readonly shim: boolean;
  readonly isolated: boolean;
}

/**
 * Lifecycle events observed before / during the verifier barrier.
 * `bootReady` is the bundle's own boot handshake (i.e. the bundle
 * emitted "boot-ready" on its control port). `renderComplete` is
 * the renderer's "render-complete" barrier — without it, the verdict
 * cannot trust the renderer finished settling.
 *
 * `structureChanged` (D11) is the result of the second observation
 * Tier 1 takes for interactive TSX runs: the structure observed at
 * the render barrier compared against the structure observed after
 * a bounded stability window. `true` means a structure mismatch was
 * detected, which earns `partial:unstable`. Non-interactive TSX runs
 * and every other artifact type omit the field; the verdict treats
 * undefined as `false` so the legacy code path is unchanged.
 */
export interface LifecycleSummary {
  readonly bootReady: boolean;
  readonly renderComplete: boolean;
  readonly structureChanged?: boolean;
  /** A protocol or isolated-world authority channel diverged at either observation. */
  readonly channelDivergence?: boolean;
  /** Interactive TSX has no lexical HTML prediction and no trusted outer shim. */
  readonly interactive?: boolean;
  /** Only TSX has a renderer-root emptiness claim from Tier 1. */
  readonly tsx?: boolean;
}

/**
 * Compute the final `RenderStatus`. Precedence, highest first:
 * timeout → channel divergence/tampered → missing channels → protocol
 * errors or lexical mismatch → missing TSX content observation →
 * unstable → empty TSX root → missing declared opaque content/error →
 * opaque content → external resources → unobservable SVG layout → ok.
 *
 * A changing page cannot support any single-snapshot content claim,
 * including emptiness. HTML/TSX has no SVG viewBox axis, while TSX
 * emptiness needs agreement from the two protocol paths and isolated
 * world; the outer page shim has no authority to make that claim.
 */
export function deriveVerdict(
  expected: LexicalCounters,
  protocolObservation: ProtocolObservation,
  isolatedObservation: ProtocolObservation | null,
  pageShim: PageShim | null,
  lifecycle: LifecycleSummary,
): RenderStatus {
  if (!lifecycle.renderComplete) return "timeout";

  if (
    lifecycle.channelDivergence === true ||
    protocolObservation.discriminativeErrors.some((error) => error.code === "protocol_divergence")
  ) {
    return "tampered";
  }
  if (!lifecycle.interactive && pageShim !== null && countsDiffer(pageShim, protocolObservation)) {
    return "tampered";
  }
  if (isolatedObservation !== null && countsDiffer(isolatedObservation, protocolObservation)) {
    return "tampered";
  }

  const shimAvailable = pageShim !== null;
  const isolatedAvailable = isolatedObservation !== null;
  if (lifecycle.interactive) {
    if (!isolatedAvailable) return "probe_only";
  } else {
    if (!shimAvailable && !isolatedAvailable) return "probe_only";
    if (!shimAvailable) return "probe_only";
    if (!isolatedAvailable) return "shim_only";
  }

  if (protocolObservation.discriminativeErrors.length > 0) return "error";
  if (!lifecycle.interactive && !matchesExpected(expected, protocolObservation)) return "error";
  if (
    lifecycle.tsx &&
    (protocolObservation.emptyRendererRoot === undefined ||
      isolatedObservation?.emptyRendererRoot === undefined)
  )
    return "probe_only";
  // D11: structure changed between the barrier and the stability
  // window. This is the only path that does not also depend on a
  // single observation — it depends on TWO observations, so it
  // dominates the single-snapshot partial statuses below.
  if (lifecycle.structureChanged === true) return "partial:unstable";
  if (lifecycle.tsx && protocolObservation.emptyRendererRoot === true)
    return "partial:empty_render";
  if (expected.opaqueRegionCount > 0 && protocolObservation.opaqueRegionCount === 0) {
    return "error";
  }
  if (protocolObservation.opaqueRegionCount > 0) return "partial:opaque_content";
  // `externalImageCount` is the type-agnostic counter — markdown surfaces
  // it from native `![](https://…)` token walks, HTML surfaces it from
  // image elements, every other type carries 0 because their Tier 0
  // policies already reject external references. Reading it at the top
  // level keeps the verdict from depending on the HTML-shaped subfield.
  if (protocolObservation.externalImageCount > 0) {
    return "partial:external_resources";
  }
  if (
    !lifecycle.interactive &&
    expected.html === undefined &&
    !layoutObservable(protocolObservation)
  ) {
    return "partial:layout_unverified";
  }
  return "ok";
}

/** A renderer-owned root whose visible bounds are real, not degenerate. */
function layoutObservable(protocol: ProtocolObservation): boolean {
  if (protocol.visibleSvgCount > 0) return true;
  if (protocol.viewBoxes.length === 0) return false;
  return protocol.viewBoxes.some((vb) => !isDegenerateViewBox(vb));
}

function isDegenerateViewBox(viewBox: string): boolean {
  const parts = viewBox
    .trim()
    .split(/[\s,]+/)
    .map((segment) => Number.parseFloat(segment));
  if (parts.length !== 4) return true;
  const [, , width, height] = parts as [number, number, number, number];
  if (!Number.isFinite(width) || !Number.isFinite(height)) return true;
  return width <= 0 || height <= 0;
}

// The top-level external-image count is compared with the other protocol
// counts, preserving the existing single comparison for this duplicated value.
const HTML_COUNT_KEYS = HTML_OBSERVED_COUNT_KEYS.filter((key) => key !== "externalImageCount");

function htmlCountsDiffer(
  left: ProtocolObservation["html"],
  right: ProtocolObservation["html"],
): boolean {
  if (left === undefined || right === undefined) return left !== right;
  return HTML_COUNT_KEYS.some((key) => left[key] !== right[key]);
}

export function countsDiffer(left: CountsLike, right: CountsLike): boolean {
  return (
    COUNT_COMPARISON_KEYS.some((key) => left[key] !== right[key]) ||
    (left.emptyRendererRoot !== undefined &&
      right.emptyRendererRoot !== undefined &&
      left.emptyRendererRoot !== right.emptyRendererRoot) ||
    left.errorCount !== right.errorCount ||
    htmlCountsDiffer(left.html, right.html)
  );
}

function matchesExpected(expected: LexicalCounters, protocol: ProtocolObservation): boolean {
  if (expected.rendererRootSvgCount !== protocol.rendererRootSvgCount) return false;
  if (expected.mermaidNodeCount !== null && expected.mermaidNodeCount !== protocol.mermaidNodeCount)
    return false;
  if (expected.html !== undefined && htmlCountsDiffer(expected.html, protocol.html)) return false;
  // opaqueRegionCount is not compared here: expected > 0 / observed 0 returns
  // error above, observed > 0 returns partial:opaque_content above, and 0 / 0
  // is the only reachable ordinary path.
  // visibleSvgCount is a protocol-only observation; the lexical
  // counter for markdown/mermaid sources is 0 (the dispatcher does
  // not count it). The verdict cannot punish the renderer for
  // surfacing a layout-observable SVG when the lexical expectation
  // explicitly leaves the field unset.
  return true;
}
