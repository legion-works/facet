import type { ViewportSize } from "./frame/view-box";

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;

export interface ViewState {
  zoom: number;
  panX?: number;
  panY?: number;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/** Canonical zero state — the one home for the `{ zoom: 1, panX: 0, panY: 0 }` literal. */
export const EMPTY_VIEW_STATE: Required<ViewState> = { zoom: 1, panX: 0, panY: 0 };

export function resetViewState(_state: ViewState): ViewState {
  return { ...EMPTY_VIEW_STATE };
}

/** Fill the optional pan fields so callers stop open-coding `?? 0`. */
export function normalizeViewState(state: ViewState): Required<ViewState> {
  return { zoom: state.zoom, panX: state.panX ?? 0, panY: state.panY ?? 0 };
}

export function zoomAtPoint(
  state: ViewState,
  nextZoom: number,
  cursorX: number,
  cursorY: number,
): ViewState {
  const zoom = clampZoom(nextZoom);
  const ratio = zoom / state.zoom;
  const panX = state.panX ?? 0;
  const panY = state.panY ?? 0;
  return {
    zoom,
    panX: cursorX - (cursorX - panX) * ratio,
    panY: cursorY - (cursorY - panY) * ratio,
  };
}

const ZOOM_KEY_FACTOR = Math.exp(100 * 0.001);
const PAN_STEP_PX = 10;
const PAN_STEP_PX_SHIFT = 50;

/**
 * Map a keydown event to the resulting view state, or null if the key
 * isn't one of the bound zoom/pan/reset keys. Pure — no DOM access —
 * so both the shell (parent document) and the frame (iframe document)
 * keydown listeners can share one tested key-to-state mapping instead
 * of maintaining parallel copies.
 */
export function nextViewStateForKey(
  state: ViewState,
  key: string,
  shiftKey: boolean,
  rect: ViewportSize,
): ViewState | null {
  if (key === "+" || key === "=") {
    return zoomAtPoint(
      state,
      clampZoom(state.zoom * ZOOM_KEY_FACTOR),
      rect.width / 2,
      rect.height / 2,
    );
  }
  if (key === "-") {
    return zoomAtPoint(
      state,
      clampZoom(state.zoom / ZOOM_KEY_FACTOR),
      rect.width / 2,
      rect.height / 2,
    );
  }
  if (key === "0") {
    return resetViewState(state);
  }
  if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
    const amount = shiftKey ? PAN_STEP_PX_SHIFT : PAN_STEP_PX;
    const dx = key === "ArrowLeft" ? -amount : key === "ArrowRight" ? amount : 0;
    const dy = key === "ArrowUp" ? -amount : key === "ArrowDown" ? amount : 0;
    return {
      ...state,
      panX: (state.panX ?? 0) + dx,
      panY: (state.panY ?? 0) + dy,
    };
  }
  return null;
}
