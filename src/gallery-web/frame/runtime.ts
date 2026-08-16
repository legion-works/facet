import { isTsxExecutionMode, type TsxExecutionMode } from "../../shared/tsx/execution";

import { validateRenderer } from "./renderer-validation";
import {
  appendRenderError,
  countPageShim,
  dispatchRender,
  FacetRenderError,
  type PageShimCounts,
  type RendererRegistry,
} from "./renderers/registry";
import {
  decodePayloadBytes,
  isFrameViewState,
  isGestureMode,
  isUint8Array,
  parseViewBox,
  type FrameRenderPayload,
  type FrameViewState,
  type GestureMode,
} from "./frame-payload";
import type { SvgViewBox } from "./view-box";
import {
  clampZoom,
  EMPTY_VIEW_STATE,
  nextViewStateForKey,
  normalizeViewState,
  zoomAtPoint,
} from "../view-state";

export type { FrameRenderPayload, FrameViewState, GestureMode };

export interface RenderResult {
  readonly observed: PageShimCounts;
  readonly viewMode: "native" | "css";
  readonly applyViewState: (state: FrameViewState) => void;
  readonly readViewState: () => FrameViewState;
  /** Gesture mode a fresh render started in — restored by reset. */
  readonly defaultGestureMode: GestureMode;
  readonly gestureMode: () => GestureMode;
  readonly setGestureMode: (mode: GestureMode) => void;
}

/** Artifact types where the whole document IS one diagram — wheel/drag gestures are the natural interaction with no competing text-selection or click behavior to protect. */
const STANDALONE_DIAGRAM_TYPES = new Set(["mermaid", "svg", "chart"]);

export interface GalleryFrameApi {
  render(payload: FrameRenderPayload): Promise<RenderResult>;
}

declare global {
  interface Window {
    __facetFrame?: GalleryFrameApi;
  }
}

/** Duck-typed `.style` check — covers HTMLElement and SVGElement alike without requiring SVGElement as a global (the frame bundle and this file's unit-test DOM shim don't both provide it). */
function setPointerEventsIfStylable(node: Element | null, value: string): void {
  if (node !== null && "style" in node) {
    (node as Element & { style: CSSStyleDeclaration }).style.pointerEvents = value;
  }
}

function renderedSvg(
  container: HTMLElement,
): { readonly svg: SVGSVGElement; readonly viewBox: SvgViewBox } | null {
  const root = container.children.length === 1 ? container.firstElementChild : null;
  if (root?.nodeName.toLowerCase() !== "svg") return null;
  const viewBox = parseViewBox(root.getAttribute("viewBox"));
  if (viewBox === null) return null;
  return { svg: root as SVGSVGElement, viewBox };
}

function validatePayload(value: unknown): {
  readonly artifactType: string;
  readonly renderer: ReturnType<typeof validateRenderer>;
  readonly bytes: Uint8Array;
  readonly execution?: TsxExecutionMode;
} {
  if (value === null || typeof value !== "object") {
    throw new FacetRenderError("artifact payload is missing", "invalid_request");
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.artifactType !== "string") {
    throw new FacetRenderError("artifact payload is missing artifactType", "invalid_request");
  }
  if (typeof payload.bytes !== "string" && !isUint8Array(payload.bytes)) {
    throw new FacetRenderError("artifact payload is missing bytes", "invalid_request");
  }
  if (payload.execution !== undefined && !isTsxExecutionMode(payload.execution)) {
    throw new FacetRenderError("artifact payload has invalid execution", "invalid_request");
  }
  return {
    artifactType: payload.artifactType,
    renderer: validateRenderer(payload.renderer),
    bytes: decodePayloadBytes(payload.bytes),
    ...(payload.execution === undefined ? {} : { execution: payload.execution }),
  };
}

export function installGalleryFrameApi(registry: RendererRegistry): void {
  const container = document.getElementById("artifact");
  if (container === null) throw new Error("frame runtime: #artifact container missing");
  let rendered = false;

  document.documentElement.style.height = "100%";
  document.documentElement.style.overflow = "hidden";
  document.body.style.height = "100%";
  document.body.style.margin = "0";
  document.body.style.padding = "0";
  document.body.style.overflow = "hidden";
  container.style.height = "100%";
  container.style.width = "100%";
  container.style.overflow = "auto";
  container.style.boxSizing = "border-box";

  let currentRenderResult: RenderResult | null = null;
  let gestureMode: GestureMode = "native";
  let drag: { x: number; y: number } | null = null;

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const state = currentRenderResult?.readViewState() ?? EMPTY_VIEW_STATE;
    const factor = Math.exp(-event.deltaY * 0.001);
    const nextZoom = clampZoom(state.zoom * factor);
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const next = zoomAtPoint(state, nextZoom, cursorX, cursorY);
    currentRenderResult?.applyViewState(normalizeViewState(next));
  };
  const onPointerDown = (event: PointerEvent): void => {
    drag = { x: event.clientX, y: event.clientY };
    container.setPointerCapture(event.pointerId);
    container.style.cursor = "grabbing";
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (drag === null) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag = { x: event.clientX, y: event.clientY };
    const state = normalizeViewState(currentRenderResult?.readViewState() ?? EMPTY_VIEW_STATE);
    currentRenderResult?.applyViewState({
      ...state,
      panX: state.panX + dx,
      panY: state.panY + dy,
    });
  };
  const onPointerEnd = (event: PointerEvent): void => {
    drag = null;
    container.releasePointerCapture(event.pointerId);
    container.style.cursor = "auto";
  };

  // Gesture listeners exist on the DOM only while panzoom mode is
  // active — native mode is not "listeners that no-op", it is zero
  // listeners, so nothing on the frame document can intercept scroll,
  // click, or text selection.
  let gesturesInstalled = false;
  const installGestureListeners = (): void => {
    if (gesturesInstalled) return;
    gesturesInstalled = true;
    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerEnd);
    container.addEventListener("pointercancel", onPointerEnd);
  };
  const removeGestureListeners = (): void => {
    if (!gesturesInstalled) return;
    gesturesInstalled = false;
    container.removeEventListener("wheel", onWheel);
    container.removeEventListener("pointerdown", onPointerDown);
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerup", onPointerEnd);
    container.removeEventListener("pointercancel", onPointerEnd);
  };

  const setGestureMode = (mode: GestureMode): void => {
    if (!isGestureMode(mode)) {
      throw new FacetRenderError("gesture mode is invalid", "invalid_request");
    }
    gestureMode = mode;
    if (mode === "panzoom") {
      installGestureListeners();
    } else {
      removeGestureListeners();
      drag = null;
      container.style.cursor = "auto";
    }
    // Suppress the artifact's own pointer interaction while dragging
    // pans it — events fall through the (now pointer-events:none) root
    // to the container, which is what pointerdown/move/up listen on.
    // A raw SVG root (mermaid/svg/chart, the STANDALONE_DIAGRAM_TYPES
    // that default straight into panzoom) is an SVGSVGElement, not an
    // HTMLElement — an `instanceof HTMLElement` guard here silently
    // skips exactly the default-panzoom path and only ever suppressed
    // the html/tsx CSS-fallback root reached via the toggle button.
    // `.style` duck-typing covers both without depending on SVGElement
    // being a global in every runtime (frame bundle + unit-test shims).
    setPointerEventsIfStylable(container.firstElementChild, mode === "panzoom" ? "none" : "");
  };

  const api: GalleryFrameApi = {
    async render(payload: FrameRenderPayload): Promise<RenderResult> {
      if (rendered) throw new FacetRenderError("frame already rendered", "invalid_request");
      rendered = true;
      const validated = validatePayload(payload);
      try {
        await dispatchRender(registry, { container }, validated);
      } catch (error) {
        appendRenderError(container, error instanceof Error ? error.message : String(error));
        throw error;
      }

      const svg = renderedSvg(container);
      const viewMode = svg === null ? "css" : "native";
      let viewState: FrameViewState = { ...EMPTY_VIEW_STATE };
      const applyViewState = (state: FrameViewState): void => {
        if (!isFrameViewState(state)) {
          throw new FacetRenderError("view state is invalid", "invalid_request");
        }
        viewState = { zoom: state.zoom, panX: state.panX, panY: state.panY };
        if (svg !== null) {
          svg.svg.style.width = `${Math.ceil(svg.viewBox.width * state.zoom)}px`;
          svg.svg.style.maxWidth = "none";
          svg.svg.style.height = "auto";
        } else {
          const root = container.firstElementChild;
          if (root instanceof HTMLElement) {
            root.style.transformOrigin = "top left";
            root.style.transform = `scale(${state.zoom})`;
          }
        }
        container.scrollLeft = Math.max(0, -state.panX);
        container.scrollTop = Math.max(0, -state.panY);
      };
      const defaultGestureMode: GestureMode = STANDALONE_DIAGRAM_TYPES.has(validated.artifactType)
        ? "panzoom"
        : "native";
      setGestureMode(defaultGestureMode);
      currentRenderResult = {
        observed: countPageShim(),
        viewMode,
        applyViewState,
        readViewState: () => ({ ...viewState }),
        defaultGestureMode,
        gestureMode: () => gestureMode,
        setGestureMode,
      };
      return currentRenderResult;
    },
  };
  Reflect.set(window, "__facetFrame", api);

  // Frame-side listener: this is the frame's own document, distinct
  // from the shell's (app.ts keydown listener attaches to the parent
  // document). Keyboard focus can legitimately sit in either realm, so
  // both listeners stay; both route through `nextViewStateForKey` so
  // the key-to-state mapping has one tested home instead of two.
  document.addEventListener("keydown", (event) => {
    const result = currentRenderResult;
    if (!result) return;
    const next = nextViewStateForKey(
      result.readViewState(),
      event.key,
      event.shiftKey,
      container.getBoundingClientRect(),
    );
    if (next === null) return;
    event.preventDefault();
    if (event.key === "0") result.setGestureMode(result.defaultGestureMode);
    result.applyViewState(normalizeViewState(next));
  });
}
