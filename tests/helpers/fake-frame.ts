/**
 * Shared fake render-result + fake frame-render-API installer for
 * gallery integration tests. Both `gallery-shell-start.test.ts` and
 * `gallery-sse.test.ts` exercise the shell against a fake iframe whose
 * `contentWindow.__facetFrame.render` resolves with the same shape a
 * real frame runtime returns — one implementation instead of two
 * divergent copies.
 */

export interface FakeViewState {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

export type FakeGestureMode = "native" | "panzoom";

export interface FakeRenderResultShape<TObserved = Record<string, number>> {
  readonly observed: TObserved;
  readonly viewMode: "native" | "css";
  readonly applyViewState: (state: FakeViewState) => void;
  readonly readViewState: () => FakeViewState;
  readonly defaultGestureMode: FakeGestureMode;
  readonly gestureMode: () => FakeGestureMode;
  readonly setGestureMode: (mode: FakeGestureMode) => void;
}

/** Build a fake `RenderResult` that tracks the last applied view state, like the real frame. */
export function makeFakeRenderResult<TObserved>(
  viewMode: "native" | "css",
  observed: TObserved,
  defaultGestureMode: FakeGestureMode = "native",
): FakeRenderResultShape<TObserved> {
  let applied: FakeViewState | null = null;
  let mode: FakeGestureMode = defaultGestureMode;
  return {
    observed,
    viewMode,
    applyViewState: (state) => {
      applied = { ...state };
    },
    readViewState: () => applied ?? { zoom: 1, panX: 0, panY: 0 },
    defaultGestureMode,
    gestureMode: () => mode,
    setGestureMode: (next) => {
      mode = next;
    },
  };
}

export interface FakeFrameApiTarget {
  readonly contentWindow: {
    __facetFrame?: { readonly render?: (payload: unknown) => Promise<unknown> };
  };
  readonly receivedPayloads: unknown[];
}

export interface FakeFrameApiConfig<TObserved> {
  readonly viewMode: "native" | "css";
  readonly observed: TObserved;
  /** Override the render promise (default: resolve with a fake render result). */
  readonly render?: (payload: unknown) => Promise<FakeRenderResultShape<TObserved>>;
}

/**
 * Install `contentWindow.__facetFrame.render` on a fake iframe-like
 * object: records every payload it receives, then resolves with the
 * configured render result (or a caller-supplied override for
 * error/timeout-path tests).
 */
export function installFakeFrameApi<TObserved>(
  target: FakeFrameApiTarget,
  config: FakeFrameApiConfig<TObserved>,
): void {
  // oxlint-disable-next-line no-underscore-dangle
  target.contentWindow.__facetFrame = {
    render: async (payload: unknown) => {
      target.receivedPayloads.push(payload);
      if (config.render !== undefined) return config.render(payload);
      return makeFakeRenderResult(config.viewMode, config.observed);
    },
  };
}
