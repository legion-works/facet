import { isTsxExecutionMode, type TsxExecutionMode } from "../../shared/tsx/execution";
import { isResolvedGalleryTheme } from "../theme";

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
  readonly resetDiagramRegions: () => void;
}

/** Artifact types where the whole document IS one diagram — wheel/drag gestures are the natural interaction with no competing text-selection or click behavior to protect. */
const STANDALONE_DIAGRAM_TYPES = new Set(["mermaid", "svg", "chart"]);
const DIAGRAM_REGION_SELECTOR = "[data-facet-diagram-region]";

export interface DiagramRegionEngagementState {
  readonly activeRegion: string | null;
  readonly armedRegion: string | null;
}

export type DiagramRegionEngagementEvent =
  | { readonly type: "pointerenter" | "pointerleave" | "activate"; readonly region: string }
  | { readonly type: "dismiss" };

export function nextDiagramRegionEngagement(
  state: DiagramRegionEngagementState,
  event: DiagramRegionEngagementEvent,
): DiagramRegionEngagementState {
  if (event.type === "dismiss") return { activeRegion: null, armedRegion: null };
  if (event.type === "pointerenter") {
    return state.activeRegion === event.region ? state : { ...state, armedRegion: event.region };
  }
  if (event.type === "pointerleave") {
    return state.armedRegion === event.region ? { ...state, armedRegion: null } : state;
  }
  return state.armedRegion === event.region
    ? { activeRegion: event.region, armedRegion: null }
    : state;
}

interface DiagramRegionGestures {
  readonly setEnabled: (enabled: boolean) => void;
  readonly dismiss: () => boolean;
  readonly reset: () => void;
}

export interface GalleryFrameApi {
  render(payload: FrameRenderPayload): Promise<RenderResult>;
}

declare global {
  interface Window {
    __facetFrame?: GalleryFrameApi;
  }
}

/** Duck-typed `.style` guard — covers HTMLElement and SVGElement alike without requiring SVGElement as a global (the frame bundle and this file's unit-test DOM shim don't both provide it). */
function asStylable(node: Element | null): (Element & { style: CSSStyleDeclaration }) | null {
  return node !== null && "style" in node
    ? (node as Element & { style: CSSStyleDeclaration })
    : null;
}

function setPointerEventsIfStylable(node: Element | null, value: string): void {
  const stylable = asStylable(node);
  if (stylable !== null) stylable.style.pointerEvents = value;
}

/**
 * Markdown appends its rendered fragment directly into the container,
 * which can leave MULTIPLE top-level siblings (e.g. a paragraph
 * followed by a standalone link). Suppressing pointer-events on only
 * `firstElementChild` left every later sibling interactive during a
 * panzoom drag, so every top-level child gets the same treatment —
 * the centering CSS keys on the first child specifically and is
 * untouched by also styling the rest.
 */
function setPointerEventsForAllChildren(container: HTMLElement, value: string): void {
  for (const child of Array.from(container.children)) {
    setPointerEventsIfStylable(child, value);
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

function installDiagramRegionGestures(container: HTMLElement): DiagramRegionGestures {
  const regions = Array.from(container.querySelectorAll<HTMLElement>(DIAGRAM_REGION_SELECTOR));
  let enabled = false;
  let engagement: DiagramRegionEngagementState = { activeRegion: null, armedRegion: null };
  interface RegionControl {
    readonly region: HTMLElement;
    readonly regionId: string;
    readonly sync: () => void;
    readonly dismiss: () => void;
    readonly reset: () => void;
  }
  let controls: readonly RegionControl[] = [];
  const transition = (event: DiagramRegionEngagementEvent): void => {
    engagement = nextDiagramRegionEngagement(engagement, event);
    controls.forEach((control) => control.sync());
  };
  controls = regions.flatMap((region, index) => {
    const svg = region.querySelector<SVGSVGElement>(":scope > svg");
    if (svg === null) return [];
    const rect = svg.getBoundingClientRect();
    const naturalWidth = rect.width;
    const naturalHeight = rect.height;
    if (naturalWidth <= 0 || naturalHeight <= 0) return [];
    region.style.width = `${Math.ceil(naturalWidth)}px`;
    region.style.height = `${Math.ceil(naturalHeight)}px`;
    region.style.overflow = "hidden";
    const regionId = String(index);
    let zoom = 1;
    let drag: { x: number; y: number; pointerId: number } | null = null;
    const sync = (): void => {
      if (engagement.activeRegion === regionId)
        region.setAttribute("data-facet-diagram-engaged", "true");
      else region.removeAttribute("data-facet-diagram-engaged");
    };
    const eventRegion = (event: Event): HTMLElement | null => {
      const target = event.target;
      return target instanceof Element
        ? target.closest<HTMLElement>(DIAGRAM_REGION_SELECTOR)
        : null;
    };
    region.addEventListener("pointerenter", () => {
      if (enabled) transition({ type: "pointerenter", region: regionId });
    });
    region.addEventListener("pointerleave", () => {
      if (enabled) transition({ type: "pointerleave", region: regionId });
    });
    region.addEventListener("pointerdown", (event) => {
      if (!enabled || eventRegion(event) !== region) return;
      transition({ type: "activate", region: regionId });
      if (engagement.activeRegion !== regionId) return;
      region.focus({ preventScroll: true });
      drag = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      region.setPointerCapture(event.pointerId);
      region.style.cursor = "grabbing";
      event.preventDefault();
    });
    region.addEventListener("pointermove", (event) => {
      if (drag === null || event.pointerId !== drag.pointerId || eventRegion(event) !== region)
        return;
      region.scrollLeft = Math.max(0, region.scrollLeft - (event.clientX - drag.x));
      region.scrollTop = Math.max(0, region.scrollTop - (event.clientY - drag.y));
      drag = { ...drag, x: event.clientX, y: event.clientY };
      event.preventDefault();
    });
    const endDrag = (event: PointerEvent): void => {
      if (drag === null || event.pointerId !== drag.pointerId) return;
      releaseDrag();
    };
    const releaseDrag = (): void => {
      const activeDrag = drag;
      drag = null;
      if (
        activeDrag !== null &&
        region.isConnected &&
        region.hasPointerCapture(activeDrag.pointerId)
      ) {
        region.releasePointerCapture(activeDrag.pointerId);
      }
      region.style.cursor = "";
    };
    region.addEventListener("pointerup", endDrag);
    region.addEventListener("pointercancel", endDrag);
    region.addEventListener(
      "wheel",
      (event) => {
        if (!enabled || engagement.activeRegion !== regionId || eventRegion(event) !== region)
          return;
        event.preventDefault();
        const nextZoom = clampZoom(zoom * Math.exp(-event.deltaY * 0.001));
        const regionRect = region.getBoundingClientRect();
        const cursorX = event.clientX - regionRect.left;
        const cursorY = event.clientY - regionRect.top;
        const scale = nextZoom / zoom;
        zoom = nextZoom;
        svg.style.width = `${Math.ceil(naturalWidth * zoom)}px`;
        svg.style.maxWidth = "none";
        svg.style.height = "auto";
        region.scrollLeft = Math.max(0, (region.scrollLeft + cursorX) * scale - cursorX);
        region.scrollTop = Math.max(0, (region.scrollTop + cursorY) * scale - cursorY);
      },
      { passive: false },
    );
    return [
      {
        region,
        regionId,
        sync,
        dismiss: (): void => {
          releaseDrag();
        },
        reset: (): void => {
          zoom = 1;
          svg.style.width = `${Math.ceil(naturalWidth)}px`;
          svg.style.maxWidth = "none";
          svg.style.height = "auto";
          region.scrollLeft = 0;
          region.scrollTop = 0;
          releaseDrag();
        },
      },
    ];
  });
  return {
    setEnabled(nextEnabled: boolean): void {
      enabled = nextEnabled;
      if (!enabled) {
        controls.forEach((control) => control.dismiss());
        transition({ type: "dismiss" });
      }
    },
    dismiss(): boolean {
      const wasEngaged = engagement.activeRegion !== null;
      controls.forEach((control) => control.dismiss());
      transition({ type: "dismiss" });
      return wasEngaged;
    },
    reset(): void {
      controls.forEach((control) => control.reset());
      transition({ type: "dismiss" });
    },
  };
}

function validatePayload(value: unknown): {
  readonly artifactType: string;
  readonly renderer: ReturnType<typeof validateRenderer>;
  readonly bytes: Uint8Array;
  readonly theme: FrameRenderPayload["theme"];
  readonly execution?: TsxExecutionMode;
} {
  if (value === null || typeof value !== "object") {
    throw new FacetRenderError("artifact payload is missing", "invalid_request");
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.artifactType !== "string") {
    throw new FacetRenderError("artifact payload is missing artifactType", "invalid_request");
  }
  if (!isResolvedGalleryTheme(payload.theme)) {
    throw new FacetRenderError("artifact payload has invalid theme", "invalid_request");
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
    theme: payload.theme,
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
  let diagramRegions: DiagramRegionGestures | null = null;
  let gestureMode: GestureMode = "native";
  let drag: { x: number; y: number } | null = null;
  let capturedPointerId: number | null = null;

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
    capturedPointerId = event.pointerId;
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
    capturedPointerId = null;
    container.style.cursor = "auto";
  };

  // Frame-wide gesture listeners exist only while panzoom mode is active.
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
    if (capturedPointerId !== null) {
      container.releasePointerCapture(capturedPointerId);
      capturedPointerId = null;
    }
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
    diagramRegions?.setEnabled(mode === "native");
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
    setPointerEventsForAllChildren(container, mode === "panzoom" ? "none" : "");
  };

  const api: GalleryFrameApi = {
    async render(payload: FrameRenderPayload): Promise<RenderResult> {
      if (rendered) throw new FacetRenderError("frame already rendered", "invalid_request");
      const validated = validatePayload(payload);
      rendered = true;
      try {
        await dispatchRender(registry, { container, theme: validated.theme }, validated);
      } catch (error) {
        appendRenderError(container, error instanceof Error ? error.message : String(error));
        throw error;
      }

      diagramRegions = installDiagramRegionGestures(container);

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
          // A viewBox-less SVG root (`renderedSvg` returned null, so this
          // is the CSS-fallback branch) is still an SVGElement, not an
          // HTMLElement — the same class of guard miss `setGestureMode`
          // had for pointer-events, reachable here on the zoom path
          // instead.
          const root = asStylable(container.firstElementChild);
          if (root !== null) {
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
        resetDiagramRegions: () => diagramRegions?.reset(),
      };
      return currentRenderResult;
    },
  };
  Reflect.set(window, "__facetFrame", api);

  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(DIAGRAM_REGION_SELECTOR) !== null) return;
    diagramRegions?.dismiss();
  });

  // Frame-side listener: this is the frame's own document, distinct
  // from the shell's (app.ts keydown listener attaches to the parent
  // document). Keyboard focus can legitimately sit in either realm, so
  // both listeners stay; both route through `nextViewStateForKey` so
  // the key-to-state mapping has one tested home instead of two.
  document.addEventListener("keydown", (event) => {
    const result = currentRenderResult;
    if (!result) return;
    if (event.key === "Escape" && diagramRegions?.dismiss()) {
      event.preventDefault();
      return;
    }
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
