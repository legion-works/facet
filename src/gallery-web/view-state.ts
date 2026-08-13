export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;
const MIN_VISIBLE_PX = 48;

export interface ViewState {
  zoom: number;
  panX?: number;
  panY?: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
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

function clampPanAxis(
  pan: number,
  content: number,
  viewport: number,
  zoom: number,
  offset: number,
): number {
  if (!Number.isFinite(pan) || content <= 0 || viewport <= 0) return 0;
  const visible = Math.min(MIN_VISIBLE_PX, viewport);
  const scaled = content * zoom;
  return Math.max(visible - offset - scaled, Math.min(viewport - visible - offset, pan));
}

/**
 * Clamp shell-transformed frames to retain 48px of the artifact. The frame
 * begins centered in the grid, while its inline transform origin stays top-left.
 */
export function clampCssPan(
  state: ViewState,
  viewport: ViewportSize,
  artifact: ViewportSize,
): ViewState {
  const zoom = clampZoom(state.zoom);
  return {
    zoom,
    panX: clampPanAxis(
      state.panX ?? 0,
      artifact.width,
      viewport.width,
      zoom,
      (viewport.width - artifact.width) / 2,
    ),
    panY: clampPanAxis(
      state.panY ?? 0,
      artifact.height,
      viewport.height,
      zoom,
      (viewport.height - artifact.height) / 2,
    ),
  };
}

/** Clamp native SVG viewBox translation to retain 48px of the source image. */
export function clampNativeSvgPan(state: ViewState, viewport: ViewportSize): ViewState {
  const zoom = clampZoom(state.zoom);
  return {
    zoom,
    panX: clampPanAxis(state.panX ?? 0, viewport.width, viewport.width, zoom, 0),
    panY: clampPanAxis(state.panY ?? 0, viewport.height, viewport.height, zoom, 0),
  };
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
