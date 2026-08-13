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

// Re-export the protocol observation shape so the verdict tests can
// typecheck without re-importing the validation contract.
export type { ProtocolObservation };

/**
 * The page shim's self-reported counts. UNTRUSTED — page JavaScript
 * can monkey-patch `document.querySelectorAll` and report whatever it
 * likes. The verifier treats shim counts as advisory only.
 */
export interface PageShim {
  readonly rendererRootSvgCount: number;
  readonly graphCount: number;
  readonly mermaidNodeCount: number;
  readonly visibleSvgCount: number;
  readonly opaqueRegionCount: number;
  readonly externalImageCount: number;
  readonly errorCount: number;
  readonly html?: ProtocolObservation["html"];
}

export type CountsLike = Pick<ProtocolObservation, (typeof COUNT_COMPARISON_KEYS)[number] | "html">;

const COUNT_COMPARISON_KEYS = [
  "rendererRootSvgCount",
  "graphCount",
  "mermaidNodeCount",
  "visibleSvgCount",
  "errorCount",
  "opaqueRegionCount",
  "externalImageCount",
] as const;

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
  /** Interactive TSX has no lexical HTML prediction and no trusted outer shim. */
  readonly interactive?: boolean;
}

/**
 * Compute the final `RenderStatus`. Order of precedence:
 *
 *   1. Lifecycle: `renderComplete === false` → `timeout`
 *   2. Trust: shim disagrees with protocol → `tampered`
 *   3. Trust: isolated disagrees with protocol → `tampered`
 *   4. Channel availability: both shim AND isolated missing → `probe_only`
 *   5. Channel availability: only shim missing → `probe_only`
 *   6. Channel availability: only isolated missing → `shim_only`
 *   7. Opaque content: expected > 0 but protocol observed 0 → `error`
 *   8. Opaque content: protocol observed > 0 → `partial:opaque_content`
 *   9. External resources: expected external images > 0 → `partial:external_resources`
 *  10. Layout observability (non-HTML only): protocol visibleSvgCount === 0
 *      AND every viewBox is zeroed → `partial:layout_unverified`. The
 *      branch is gated on `expected.html === undefined` because HTML
 *      artifacts carry no viewBox axis — they have no SVG layout to
 *      verify against, so `partial:layout_unverified` is structurally
 *      unreachable for HTML. A clean HTML artifact with zero
 *      `visibleSvgCount` and zero `viewBoxes` returns `ok` when its
 *      counts match.
 *  11. Counts: protocol discriminativeErrors non-empty → `error`
 *  12. Counts: protocol observed !== expected lexical → `error`
 *  13. Otherwise → `ok`
 *
 * Tampered wins over partial: a forge attempt that hides layout
 * observability (no viewBoxes) is still a forge attempt.
 *
 * D11 addition: `partial:unstable` slots between step 6 and step 7,
 * i.e. AFTER the catastrophic statuses (timeout, tampered, channel
 * availability) and the count-mismatch error, but BEFORE the
 * single-snapshot partials (opaque_content, external_resources,
 * layout_unverified). The reasoning: when structure is changing
 * between the two observation snapshots, the verifier cannot
 * honestly claim "this artifact has structure X" — every
 * single-snapshot claim is moot. Unstable is a meta-claim about the
 * page's runtime behavior that dominates the structural claims.
 * Tampered stays above it because channel divergence (the page
 * contradicting protocol authority) is the more catastrophic
 * reading of the page's behavior.
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
  // D11: structure changed between the barrier and the stability
  // window. This is the only path that does not also depend on a
  // single observation — it depends on TWO observations, so it
  // dominates the single-snapshot partial statuses below.
  if (lifecycle.structureChanged === true) return "partial:unstable";
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

const HTML_COUNT_KEYS = [
  "rendererRootCount",
  "headingCount",
  "tableCount",
  "listCount",
  "imageCount",
  "canvasCount",
] as const;

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
    htmlCountsDiffer(left.html, right.html)
  );
}

function matchesExpected(expected: LexicalCounters, protocol: ProtocolObservation): boolean {
  if (expected.rendererRootSvgCount !== protocol.rendererRootSvgCount) return false;
  if (expected.mermaidNodeCount !== protocol.mermaidNodeCount) return false;
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
