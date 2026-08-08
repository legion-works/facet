/**
 * Double-buffered HMR swap plan — pure state machine.
 *
 * The shell calls `run()` on each step in order. The steps are a
 * tagged union so callers can introspect the plan without re-deriving
 * it from a state machine.
 *
 * Ordering invariant: `new-frame-ready` < `swap` < `apply-view-state`
 * < `close-old-control` < `remove-old`. If the new frame fails to
 * reach ready within the wait window, the plan stops short of `swap` /
 * `remove-old` — the old frame stays visible with an error badge.
 */

export type SwapPlanStep =
  | { readonly name: "build-new"; readonly run: () => void; readonly frameId: string }
  | { readonly name: "open-new-control"; readonly run: () => void; readonly frameId: string }
  | { readonly name: "new-frame-ready"; readonly run: () => void; readonly frameId: string }
  | { readonly name: "swap"; readonly run: () => void }
  | { readonly name: "apply-view-state"; readonly run: () => void; readonly zoom: number }
  | { readonly name: "close-old-control"; readonly run: () => void; readonly frameId: string }
  | { readonly name: "remove-old"; readonly run: () => void; readonly frameId: string };

export interface PlanSwapOptions {
  readonly currentFrameId: string;
  readonly nextFrameId: string;
  readonly viewState: { readonly zoom: number };
  readonly failNewFrameReady?: boolean;
  readonly onStep?: (step: SwapPlanStep) => void;
}

const NOOP = (): void => {};

export function planSwap(options: PlanSwapOptions): readonly SwapPlanStep[] {
  const { currentFrameId, nextFrameId, viewState, failNewFrameReady, onStep } = options;
  const emit = (s: SwapPlanStep): SwapPlanStep => {
    onStep?.(s);
    return s;
  };
  const steps: SwapPlanStep[] = [
    emit({
      name: "build-new",
      frameId: nextFrameId,
      run: NOOP,
    }),
    emit({
      name: "open-new-control",
      frameId: nextFrameId,
      run: NOOP,
    }),
    emit({
      name: "new-frame-ready",
      frameId: nextFrameId,
      run: NOOP,
    }),
  ];
  if (failNewFrameReady === true) {
    // Failed new-frame ready: stop short — old frame stays visible,
    // shell surfaces an error badge. NO `swap`, NO `apply-view-state`,
    // NO `remove-old`. The new frame's channels are still closed by
    // the caller (closeControl + remove) in the error path.
    return steps;
  }
  steps.push(
    emit({ name: "swap", run: NOOP }),
    emit({ name: "apply-view-state", zoom: viewState.zoom, run: NOOP }),
    emit({ name: "close-old-control", frameId: currentFrameId, run: NOOP }),
    emit({ name: "remove-old", frameId: currentFrameId, run: NOOP }),
  );
  return steps;
}
