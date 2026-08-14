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
  isUint8Array,
  parseViewBox,
  type FrameViewState,
} from "./frame-payload";
import type { SvgViewBox } from "./view-box";
import { clampZoom, zoomAtPoint } from "../view-state";
export interface FrameRenderPayload {
  readonly artifactType: string;
  readonly renderer: string;
  readonly bytes: Uint8Array | string;
  readonly execution?: TsxExecutionMode;
}

export type { FrameViewState };

export interface RenderResult {
  readonly observed: PageShimCounts;
  readonly viewMode: "native" | "css";
  readonly applyViewState: (state: FrameViewState) => void;
  readonly readViewState: () => FrameViewState;
}

export interface GalleryFrameApi {
  render(payload: FrameRenderPayload): Promise<RenderResult>;
}

declare global {
  interface Window {
    __facetFrame?: GalleryFrameApi;
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
  const api: GalleryFrameApi = {
    async render(payload: FrameRenderPayload): Promise<RenderResult> {
      if (rendered) throw new FacetRenderError("frame already rendered", "invalid_request");
      rendered = true;
      try {
        await dispatchRender(registry, { container }, validatePayload(payload));
      } catch (error) {
        appendRenderError(container, error instanceof Error ? error.message : String(error));
        throw error;
      }

      const svg = renderedSvg(container);
      const viewMode = svg === null ? "css" : "native";
      let viewState: FrameViewState = { zoom: 1, panX: 0, panY: 0 };
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
      currentRenderResult = {
        observed: countPageShim(),
        viewMode,
        applyViewState,
        readViewState: () => ({ ...viewState }),
      };
      return currentRenderResult;
    },
  };
  Reflect.set(window, "__facetFrame", api);

  let drag: { x: number; y: number } | null = null;
  container.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const state = currentRenderResult?.readViewState() ?? { zoom: 1, panX: 0, panY: 0 };
      const factor = Math.exp(-event.deltaY * 0.001);
      const nextZoom = clampZoom(state.zoom * factor);
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const next = zoomAtPoint(state, nextZoom, cursorX, cursorY);
      currentRenderResult?.applyViewState({
        zoom: next.zoom,
        panX: next.panX ?? 0,
        panY: next.panY ?? 0,
      });
    },
    { passive: false },
  );
  container.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, y: event.clientY };
    container.setPointerCapture(event.pointerId);
    container.style.cursor = "grabbing";
  });
  container.addEventListener("pointermove", (event) => {
    if (drag === null) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag = { x: event.clientX, y: event.clientY };
    const state = currentRenderResult?.readViewState() ?? { zoom: 1, panX: 0, panY: 0 };
    currentRenderResult?.applyViewState({
      ...state,
      panX: (state.panX ?? 0) + dx,
      panY: (state.panY ?? 0) + dy,
    });
  });
  const endDrag = (event: PointerEvent): void => {
    drag = null;
    container.releasePointerCapture(event.pointerId);
    container.style.cursor = "auto";
  };
  container.addEventListener("pointerup", endDrag);
  container.addEventListener("pointercancel", endDrag);
  document.addEventListener("keydown", (event) => {
    const result = currentRenderResult;
    if (!result) return;
    const state = result.readViewState();
    const rect = container.getBoundingClientRect();

    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      const factor = Math.exp(100 * 0.001);
      const next = zoomAtPoint(
        state,
        clampZoom(state.zoom * factor),
        rect.width / 2,
        rect.height / 2,
      );
      result.applyViewState({ zoom: next.zoom, panX: next.panX ?? 0, panY: next.panY ?? 0 });
    } else if (event.key === "-") {
      event.preventDefault();
      const factor = Math.exp(-100 * 0.001);
      const next = zoomAtPoint(
        state,
        clampZoom(state.zoom * factor),
        rect.width / 2,
        rect.height / 2,
      );
      result.applyViewState({ zoom: next.zoom, panX: next.panX ?? 0, panY: next.panY ?? 0 });
    } else if (event.key === "0") {
      event.preventDefault();
      result.applyViewState({ zoom: 1, panX: 0, panY: 0 });
    } else if (
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowDown"
    ) {
      event.preventDefault();
      const amount = event.shiftKey ? 50 : 10;
      const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
      const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
      result.applyViewState({
        ...state,
        panX: (state.panX ?? 0) + dx,
        panY: (state.panY ?? 0) + dy,
      });
    }
  });
}
