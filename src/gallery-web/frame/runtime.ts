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
import type { SvgViewBox } from "./view-box";

export interface FrameRenderPayload {
  readonly artifactType: string;
  readonly renderer: string;
  readonly bytes: Uint8Array | string;
  readonly execution?: TsxExecutionMode;
}

export interface FrameViewState {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

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

function decodePayloadBytes(bytes: Uint8Array | string): Uint8Array {
  if (typeof bytes !== "string") return new Uint8Array(bytes);
  const binary = atob(bytes);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function parseViewBox(value: string | null): SvgViewBox | null {
  if (value === null) return null;
  const values = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    values.length !== 4 ||
    values.some((entry) => !Number.isFinite(entry)) ||
    values[2]! <= 0 ||
    values[3]! <= 0
  )
    return null;
  return { minX: values[0]!, minY: values[1]!, width: values[2]!, height: values[3]! };
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

function isFrameViewState(value: unknown): value is FrameViewState {
  if (value === null || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.zoom === "number" &&
    Number.isFinite(state.zoom) &&
    state.zoom > 0 &&
    typeof state.panX === "number" &&
    Number.isFinite(state.panX) &&
    typeof state.panY === "number" &&
    Number.isFinite(state.panY)
  );
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
        if (svg === null) return;
        svg.svg.style.width = `${Math.ceil(svg.viewBox.width * state.zoom)}px`;
        svg.svg.style.maxWidth = "none";
        svg.svg.style.height = "auto";
        container.scrollLeft = Math.max(0, -state.panX);
        container.scrollTop = Math.max(0, -state.panY);
      };
      return {
        observed: countPageShim(),
        viewMode,
        applyViewState,
        readViewState: () => ({ ...viewState }),
      };
    },
  };
  Reflect.set(window, "__facetFrame", api);
}
