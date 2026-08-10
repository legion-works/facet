/**
 * Placeholder verdict shim — Task 8 ships the SHELL + CHANNELS, not
 * the renderer. The bootstrap reports an empty verdict via the control
 * channel so the shell can still demonstrate end-to-end wiring without
 * a real renderer; the next task replaces this with the typed
 * per-artifact renderer (mermaid/markdown/svg/chart) and the verifier
 * becomes the Tier-1 source of truth.
 */

/**
 * Placeholder verdict shim — the shell + channels ship without the
 * per-type renderer. The bootstrap reports an empty verdict via the
 * control channel so the shell can still demonstrate end-to-end
 * wiring without a real renderer; the typed per-artifact renderer
 * (mermaid/markdown/svg/chart/html) replaces this and the verifier
 * becomes the Tier-1 source of truth.
 */

export interface VerdictShimObserved {
  readonly rendererRootSvgCount: number;
  readonly graphCount: number;
  readonly mermaidNodeCount: number;
  readonly visibleSvgCount: number;
  readonly externalImageCount: number;
  readonly errorCount: number;
  readonly html?: {
    readonly rendererRootCount: number;
    readonly headingCount: number;
    readonly tableCount: number;
    readonly listCount: number;
    readonly imageCount: number;
    readonly canvasCount: number;
    readonly externalImageCount: number;
  };
}

export interface VerdictShimReport {
  readonly status: "shim_only";
  readonly observed: VerdictShimObserved;
}

export function computeVerdictShim(): VerdictShimReport {
  return {
    status: "shim_only",
    observed: {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      externalImageCount: 0,
      errorCount: 0,
    },
  };
}
