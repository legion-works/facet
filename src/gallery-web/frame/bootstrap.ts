/**
 * Frame-side bootstrap — runs INSIDE the opaque-origin iframe.
 *
 * This module is the frame program. Each type-specific entry supplies
 * one renderer registry; the paired Tier 1 entry supplies the SAME
 * renderer modules to the verifier harness. The CSP rejects untrusted
 * script, so artifact bytes arrive as DATA on the ingress port and never
 * become executable.
 *
 * Lifecycle:
 *   1. Receive the transitional `ports` channel and wire the transferred ports.
 *   3. Emit `boot-ready` on the control port.
 *   4. Receive the artifact on the ingress port (one-shot), close it.
 *   5. Dispatch through the renderer registry; await render-complete
 *      semantics (mermaid render() awaited, imported SVGs settled
 *      under bounded MutationObservers, markdown awaits its embedded
 *      diagram promises — all inside the renderer dispatch).
 *   6. Emit page-shim counts on the control port ONLY after completion.
 *
 * The control port also has a RECEIVE path (shell → frame view-state
 * commands). The shell owns canonical zoom/pan; SVG roots apply it through
 * their viewBox while other artifacts retain the shell CSS fallback.
 */

import {
  appendRenderError,
  countPageShim,
  dispatchRender,
  FacetRenderError,
  type RendererRegistry,
} from "./renderers/registry";
import { validateRenderer } from "./renderer-validation";
import type { SvgViewBox } from "./view-box";
import { isTsxExecutionMode, type TsxExecutionMode } from "../../shared/tsx/execution";
import { decodePayloadBytes, isFrameViewState, isUint8Array, parseViewBox } from "./frame-payload";

declare global {
  interface Window {
    __facetBootstrapReady?: boolean;
  }
}

interface HandshakeData {
  readonly facetHandshake?: string;
}

interface ArtifactPayload {
  readonly artifactType?: string;
  readonly renderer?: string;
  readonly bytes?: Uint8Array | string;
  readonly execution?: TsxExecutionMode;
}

const containerElement = document.getElementById("artifact");
if (containerElement === null) {
  throw new Error("bootstrap: #artifact container missing");
}
const container: HTMLElement = containerElement;

let controlPost: ((event: unknown) => void) | null = null;
let handshakeComplete = false;

let drag: { x: number; y: number } | null = null;

let renderedSvg: SVGSVGElement | null = null;
let originalViewBox: SvgViewBox | null = null;
let viewModeReported = false;

function deliver(event: unknown): void {
  try {
    controlPost?.(event);
  } catch {
    // control channel torn down — drop silently
  }
}

function cacheRenderedSvg(): void {
  const root = container.children.length === 1 ? container.firstElementChild : null;
  if (!(root instanceof SVGSVGElement)) return;
  const viewBox = parseViewBox(root.getAttribute("viewBox"));
  if (viewBox === null) return;
  renderedSvg = root;
  originalViewBox = viewBox;
}

function receiveViewState(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  const event = value as Record<string, unknown>;
  if (event.type !== "view-state" || !isFrameViewState(event)) return;
  const viewState = event as unknown as { zoom: number; panX: number; panY: number };
  if (renderedSvg === null || originalViewBox === null) {
    if (!viewModeReported) {
      viewModeReported = true;
      deliver({ type: "view-mode", mode: "css" });
    }
    return;
  }
  if (!viewModeReported) {
    viewModeReported = true;
    deliver({ type: "view-mode", mode: "native" });
  }
  // Zoom resizes the ELEMENT; pan scrolls the CONTAINER. The old model
  // kept the element fixed and moved the camera (viewBox) instead — the
  // element then acted as an invisible window, so any pan cut the
  // diagram off at the element's edge (operator-reported, screenshot:
  // a sliver of diagram lost in a dark stage). Scrolling a naturally
  // sized element cannot clip: overflow extends the scroll range.
  const naturalWidth = originalViewBox.width;
  if (naturalWidth <= 0) return;
  renderedSvg.style.width = `${Math.ceil(naturalWidth * viewState.zoom)}px`;
  renderedSvg.style.maxWidth = "none";
  renderedSvg.style.height = "auto";
  const scroller = container;
  scroller.scrollLeft = Math.max(0, -viewState.panX);
  scroller.scrollTop = Math.max(0, -viewState.panY);
}

export function startGalleryFrame(registry: RendererRegistry): void {
  window.addEventListener(
    "message",
    (event: MessageEvent) => {
      if (handshakeComplete || event.source !== window.parent) return;
      const data = event.data as HandshakeData | null;
      if (data === null || data.facetHandshake !== "ports") return;
      const ports = event.ports;
      if (ports.length !== 2) return;
      const ingress = ports[0];
      const control = ports[1];
      if (ingress === undefined || control === undefined) return;
      handshakeComplete = true;
      controlPost = control.postMessage.bind(control);
      // Control RECEIVE path (shell → frame). MessagePort.onmessage
      // setter form: the pinned chrome-headless-shell silently drops
      // addEventListener-registered port events, and the setter works
      // everywhere the listener form does.
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      control.onmessage = (controlEvent: MessageEvent) => receiveViewState(controlEvent.data);
      container.addEventListener(
        "wheel",
        (wheelEvent) => {
          wheelEvent.preventDefault();
          const rect = container.getBoundingClientRect();
          deliver({
            type: "view-intent",
            mode: "zoom",
            deltaY: wheelEvent.deltaY,
            cursorX: wheelEvent.clientX - rect.left,
            cursorY: wheelEvent.clientY - rect.top,
            rect: { w: rect.width, h: rect.height },
          });
        },
        { passive: false },
      );
      container.addEventListener("pointerdown", (pointerEvent) => {
        drag = { x: pointerEvent.clientX, y: pointerEvent.clientY };
        container.setPointerCapture(pointerEvent.pointerId);
      });
      container.addEventListener("pointermove", (pointerEvent) => {
        if (drag === null) return;
        const dx = pointerEvent.clientX - drag.x;
        const dy = pointerEvent.clientY - drag.y;
        drag = { x: pointerEvent.clientX, y: pointerEvent.clientY };
        deliver({ type: "view-intent", mode: "pan", dx, dy });
      });
      const endDrag = (pointerEvent: PointerEvent): void => {
        drag = null;
        container.releasePointerCapture(pointerEvent.pointerId);
      };
      container.addEventListener("pointerup", endDrag);
      container.addEventListener("pointercancel", endDrag);
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      ingress.onmessage = async (sourceEvent: MessageEvent) => {
        // One-shot ingress: receive the artifact, then close the port.
        ingress.close();
        const payload = sourceEvent.data as ArtifactPayload | null;
        try {
          if (payload === null || typeof payload.artifactType !== "string") {
            throw new FacetRenderError(
              "artifact payload is missing artifactType",
              "invalid_request",
            );
          }
          const renderer = validateRenderer(payload.renderer);
          // Strict type check (shared with the direct API path): a
          // `bytes: null` must not fall through to atob(null).
          if (typeof payload.bytes !== "string" && !isUint8Array(payload.bytes)) {
            throw new FacetRenderError("artifact payload is missing bytes", "invalid_request");
          }
          const bytes = payload.bytes;
          if (payload.execution !== undefined && !isTsxExecutionMode(payload.execution)) {
            throw new FacetRenderError("artifact payload has invalid execution", "invalid_request");
          }
          await dispatchRender(
            registry,
            { container },
            {
              artifactType: payload.artifactType,
              renderer,
              bytes: decodePayloadBytes(bytes),
              ...(payload.execution === undefined ? {} : { execution: payload.execution }),
            },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          appendRenderError(container, message);
        }
        cacheRenderedSvg();
        // Counts cross the control port ONLY after the render settled.
        deliver({ type: "render-complete", observed: countPageShim() });
      };
      deliver({ type: "boot-ready" });
      // oxlint-disable-next-line no-underscore-dangle
      window.__facetBootstrapReady = true;
    },
    { once: false },
  );
}

export type { ArtifactPayload };
