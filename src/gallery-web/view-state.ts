export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;

export interface ViewState {
  zoom: number;
  panX?: number;
  panY?: number;
}

export type ViewMode = "native" | "css";

export type ViewIntent =
  | {
      readonly type: "view-intent";
      readonly mode: "zoom";
      readonly deltaY: number;
      readonly cursorX: number;
      readonly cursorY: number;
      readonly rect: { readonly w: number; readonly h: number };
    }
  | {
      readonly type: "view-intent";
      readonly mode: "pan";
      readonly dx: number;
      readonly dy: number;
    };

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

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateViewIntent(value: unknown): ViewIntent | null {
  if (value === null || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.type !== "view-intent") return null;
  if (event.mode === "pan") {
    if (
      !finite(event.dx) ||
      !finite(event.dy) ||
      Math.abs(event.dx) > 2_000 ||
      Math.abs(event.dy) > 2_000
    )
      return null;
    return { type: "view-intent", mode: "pan", dx: event.dx, dy: event.dy };
  }
  if (event.mode !== "zoom" || !finite(event.deltaY) || Math.abs(event.deltaY) > 1_000) return null;
  const rect = event.rect;
  if (rect === null || typeof rect !== "object") return null;
  const dimensions = rect as Record<string, unknown>;
  if (
    !finite(event.cursorX) ||
    !finite(event.cursorY) ||
    !finite(dimensions.w) ||
    !finite(dimensions.h) ||
    dimensions.w <= 0 ||
    dimensions.h <= 0 ||
    dimensions.w > 100_000 ||
    dimensions.h > 100_000
  )
    return null;
  return {
    type: "view-intent",
    mode: "zoom",
    deltaY: event.deltaY,
    cursorX: event.cursorX,
    cursorY: event.cursorY,
    rect: { w: dimensions.w, h: dimensions.h },
  };
}

export function validateViewMode(value: unknown): ViewMode | null {
  if (value === null || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.type !== "view-mode") return null;
  if (event.mode !== "native" && event.mode !== "css") return null;
  if (Object.keys(event).length !== 2) return null;
  return event.mode;
}
