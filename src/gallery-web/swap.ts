/**
 * Double-buffered HMR swap plan — pure state machine.
 *
 * The shell calls `run()` on each step in order. The steps are a
 * tagged union so callers can introspect the plan without re-deriving
 * it from a state machine.
 *
 * Ordering invariant: `render-new` < `swap` < `apply-view-state` <
 * `remove-old`. If the new frame fails to render within the wait window,
 * the plan stops short of `swap` /
 * `remove-old` — the old frame stays visible with an error badge.
 */

export type SwapPlanStep =
  | { readonly name: "build-new"; readonly run: () => void; readonly frameId: string }
  | { readonly name: "load-new"; readonly run: () => void; readonly frameId: string }
  | { readonly name: "render-new"; readonly run: () => void; readonly frameId: string }
  | { readonly name: "swap"; readonly run: () => void }
  | { readonly name: "apply-view-state"; readonly run: () => void; readonly zoom: number }
  | { readonly name: "remove-old"; readonly run: () => void; readonly frameId: string };

export interface PlanSwapOptions {
  readonly currentFrameId: string;
  readonly nextFrameId: string;
  readonly viewState: { readonly zoom: number };
  readonly failNewRender?: boolean;
  readonly onStep?: (step: SwapPlanStep) => void;
}

const NOOP = (): void => {};

export function planSwap(options: PlanSwapOptions): readonly SwapPlanStep[] {
  const { currentFrameId, nextFrameId, viewState, failNewRender, onStep } = options;
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
      name: "load-new",
      frameId: nextFrameId,
      run: NOOP,
    }),
    emit({
      name: "render-new",
      frameId: nextFrameId,
      run: NOOP,
    }),
  ];
  if (failNewRender === true) {
    return steps;
  }
  steps.push(
    emit({ name: "swap", run: NOOP }),
    emit({ name: "apply-view-state", zoom: viewState.zoom, run: NOOP }),
    emit({ name: "remove-old", frameId: currentFrameId, run: NOOP }),
  );
  return steps;
}
