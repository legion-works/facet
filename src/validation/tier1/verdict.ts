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
  readonly errorCount: number;
}

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
 */
export interface LifecycleSummary {
  readonly bootReady: boolean;
  readonly renderComplete: boolean;
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
 *   9. Layout observability: protocol visibleSvgCount === 0 AND every
 *      viewBox is zeroed → `partial:layout_unverified`
 *  10. Counts: protocol discriminativeErrors non-empty → `error`
 *  11. Counts: protocol observed !== expected lexical → `error`
 *  12. Otherwise → `ok`
 *
 * Tampered wins over partial: a forge attempt that hides layout
 * observability (no viewBoxes) is still a forge attempt.
 */
export function deriveVerdict(
  expected: LexicalCounters,
  protocolObservation: ProtocolObservation,
  isolatedObservation: ProtocolObservation | null,
  pageShim: PageShim | null,
  lifecycle: LifecycleSummary,
): RenderStatus {
  if (!lifecycle.renderComplete) return "timeout";

  if (pageShim !== null && shimDiverges(pageShim, protocolObservation)) return "tampered";
  if (isolatedObservation !== null && countsDiffer(isolatedObservation, protocolObservation)) {
    return "tampered";
  }

  const shimAvailable = pageShim !== null;
  const isolatedAvailable = isolatedObservation !== null;
  if (!shimAvailable && !isolatedAvailable) return "probe_only";
  if (!shimAvailable) return "probe_only";
  if (!isolatedAvailable) return "shim_only";

  if (expected.opaqueRegionCount > 0 && protocolObservation.opaqueRegionCount === 0) {
    return "error";
  }
  if (protocolObservation.opaqueRegionCount > 0) return "partial:opaque_content";

  if (!layoutObservable(protocolObservation)) return "partial:layout_unverified";

  if (protocolObservation.discriminativeErrors.length > 0) return "error";

  if (!matchesExpected(expected, protocolObservation)) return "error";

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

function shimDiverges(shim: PageShim, protocol: ProtocolObservation): boolean {
  return (
    shim.rendererRootSvgCount !== protocol.rendererRootSvgCount ||
    shim.graphCount !== protocol.graphCount ||
    shim.mermaidNodeCount !== protocol.mermaidNodeCount ||
    shim.errorCount !== protocol.errorCount ||
    shim.visibleSvgCount !== protocol.visibleSvgCount ||
    shim.opaqueRegionCount !== protocol.opaqueRegionCount
  );
}

function countsDiffer(left: ProtocolObservation, right: ProtocolObservation): boolean {
  return (
    left.rendererRootSvgCount !== right.rendererRootSvgCount ||
    left.graphCount !== right.graphCount ||
    left.mermaidNodeCount !== right.mermaidNodeCount ||
    left.visibleSvgCount !== right.visibleSvgCount ||
    left.errorCount !== right.errorCount ||
    left.opaqueRegionCount !== right.opaqueRegionCount
  );
}

function matchesExpected(expected: LexicalCounters, protocol: ProtocolObservation): boolean {
  if (expected.rendererRootSvgCount !== protocol.rendererRootSvgCount) return false;
  if (expected.mermaidNodeCount !== protocol.mermaidNodeCount) return false;
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
