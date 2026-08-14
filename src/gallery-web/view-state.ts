export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;

export interface ViewState {
  zoom: number;
  panX?: number;
  panY?: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

export function resetViewState(_state: ViewState): ViewState {
  return { zoom: 1, panX: 0, panY: 0 };
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
