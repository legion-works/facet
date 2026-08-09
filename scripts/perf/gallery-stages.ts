import type { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";

type BrowserTarget = Awaited<ReturnType<PuppeteerTier1Browser["launch"]>>;

export interface GalleryStageTimestamps {
  readonly sseHandledAt: number | null;
  readonly frameBuiltAt: number | null;
  readonly bootstrapLoadedAt: number | null;
  readonly bootReadyAt: number | null;
  readonly renderCompleteAt: number | null;
  readonly visibleAt: number | null;
}

const INSTRUMENTATION_SOURCE = `(() => {
  const empty = () => ({
    sseHandledAt: null,
    frameBuiltAt: null,
    bootstrapLoadedAt: null,
    bootReadyAt: null,
    renderCompleteAt: null,
    visibleAt: null,
  });
  window.__facetPerf = { targetRevision: '', stages: empty(), observerReady: false };
  const install = () => {
    window.__facetPerf.observerReady = true;
    const inspect = () => {
      const state = window.__facetPerf;
      if (!state || state.targetRevision === '') return;
      const now = Date.now();
      const status = document.querySelector('#facet-status-line')?.textContent ?? '';
      if (status === 'swapping' && state.stages.sseHandledAt === null) state.stages.sseHandledAt = now;
      const frames = Array.from(document.querySelectorAll('iframe'));
      if (frames.length > 1 && state.stages.frameBuiltAt === null) state.stages.frameBuiltAt = now;
      for (const frame of frames) {
        if (frame.dataset.perfLoadObserved === '1') continue;
        frame.dataset.perfLoadObserved = '1';
        frame.addEventListener('load', () => {
          const current = window.__facetPerf;
          if (current?.targetRevision && current.stages.bootstrapLoadedAt === null) {
            current.stages.bootstrapLoadedAt = Date.now();
          }
        }, { once: true });
      }
      const width = document.querySelector('#facet-swapbar .bar')?.style.width ?? '';
      if (width === '80%' && state.stages.bootReadyAt === null) state.stages.bootReadyAt = now;
      if (width === '100%' && state.stages.renderCompleteAt === null) state.stages.renderCompleteAt = now;
      const revision = document.querySelector('#facet-revision')?.textContent ?? '';
      const visibleFrames = frames.filter((frame) => frame.style.visibility === 'visible');
      if (status === 'displayed' && revision === state.targetRevision && visibleFrames.length === 1 && state.stages.visibleAt === null) {
        state.stages.visibleAt = now;
      }
    };
    new MutationObserver(inspect).observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    inspect();
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();`;

export async function installGalleryStageInstrumentation(target: BrowserTarget): Promise<void> {
  await target.session.send("Runtime.evaluate", {
    expression: INSTRUMENTATION_SOURCE,
  });
}

export async function armGalleryStageInstrumentation(
  target: BrowserTarget,
  revisionSha: string,
): Promise<void> {
  const evaluation = await target.session.send<{ result?: { value?: boolean } }>(
    "Runtime.evaluate",
    {
      returnByValue: true,
      expression: `(() => {
        if (!window.__facetPerf?.observerReady) return false;
        window.__facetPerf.targetRevision = ${JSON.stringify(revisionSha.slice(0, 12))};
        window.__facetPerf.stages = {
        sseHandledAt: null,
        frameBuiltAt: null,
        bootstrapLoadedAt: null,
        bootReadyAt: null,
        renderCompleteAt: null,
        visibleAt: null,
        };
        return true;
      })()`,
    },
  );
  if (evaluation.result?.value !== true) throw new Error("gallery stage observer is not ready");
}

export async function readGalleryStageInstrumentation(
  target: BrowserTarget,
): Promise<GalleryStageTimestamps> {
  const evaluation = await target.session.send<{ result?: { value?: GalleryStageTimestamps } }>(
    "Runtime.evaluate",
    { returnByValue: true, expression: "window.__facetPerf?.stages ?? null" },
  );
  const stages = evaluation.result?.value;
  if (stages === undefined) throw new Error("gallery stage instrumentation is unavailable");
  return stages;
}
