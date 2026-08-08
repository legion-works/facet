/**
 * Placeholder verdict shim — Task 8 ships the SHELL + CHANNELS, not
 * the renderer. The bootstrap reports an empty verdict via the control
 * channel so the shell can still demonstrate end-to-end wiring without
 * a real renderer; the next task replaces this with the typed
 * per-artifact renderer (mermaid/markdown/svg/chart) and the verifier
 * becomes the Tier-1 source of truth.
 */

export interface VerdictShimObserved {
  readonly rendererRootSvgCount: number;
  readonly graphCount: number;
  readonly mermaidNodeCount: number;
  readonly visibleSvgCount: number;
  readonly errorCount: number;
}

export interface VerdictShimReport {
  readonly status: "shim_only";
  readonly observed: VerdictShimObserved;
}

/**
 * Compute the placeholder verdict. The real verifier runs out-of-frame
 * (Tier 1 chrome-headless-shell) and is the source of truth — this
 * shim is intentionally empty.
 */
export function computeVerdictShim(): VerdictShimReport {
  return {
    status: "shim_only",
    observed: {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      errorCount: 0,
    },
  };
}
