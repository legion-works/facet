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
 *   1. Read the per-frame nonce from the frame document's own URL (the
 *      bundle is static across frames; the nonce is fresh per frame).
 *   2. Verify the `ports` handshake nonce, wire the transferred ports.
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
import { isRenderer } from "../../shared/contracts/renderers";
import { applySvgViewBox, type SvgViewBox } from "./view-box";

declare global {
  interface Window {
    __facetBootstrapReady?: boolean;
  }
}

interface HandshakeData {
  readonly facetHandshake?: string;
  readonly nonce?: string;
}

interface ArtifactPayload {
  readonly artifactType?: string;
  readonly renderer?: string;
  readonly bytes?: Uint8Array | string;
}

const containerElement = document.getElementById("artifact");
if (containerElement === null) {
  throw new Error("bootstrap: #artifact container missing");
}
const container: HTMLElement = containerElement;

// The frame document's own URL carries the per-frame nonce (the service
// validates its shape before echoing it into the CSP header), and the
// handshake must match it. Read it from `location` rather than the script
// tag: `document.currentScript` is ALWAYS null in a module script, and a
// nonce content attribute is hidden from DOM reads. Keeping the nonce off
// the bundle URL leaves ONE cacheable bundle valid across frames.
const nonce = new URLSearchParams(location.search).get("nonce") ?? "";

let controlPost: ((event: unknown) => void) | null = null;

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

function decodePayloadBytes(bytes: Uint8Array | string): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  // Base64 form (used by hosts that must embed bytes as text).
  const binary = atob(bytes);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
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
  if (
    event.type !== "view-state" ||
    typeof event.zoom !== "number" ||
    !Number.isFinite(event.zoom) ||
    event.zoom <= 0 ||
    typeof event.panX !== "number" ||
    !Number.isFinite(event.panX) ||
    typeof event.panY !== "number" ||
    !Number.isFinite(event.panY)
  )
    return;
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
  const width = renderedSvg.clientWidth;
  const height = renderedSvg.clientHeight;
  if (width <= 0 || height <= 0) return;
  const next = applySvgViewBox(
    originalViewBox,
    { width, height },
    {
      zoom: event.zoom,
      panX: event.panX,
      panY: event.panY,
    },
  );
  renderedSvg.setAttribute("viewBox", `${next.minX} ${next.minY} ${next.width} ${next.height}`);
}

export function startGalleryFrame(registry: RendererRegistry): void {
  window.addEventListener(
    "message",
    (event: MessageEvent) => {
      const data = event.data as HandshakeData | null;
      if (data === null || data.facetHandshake !== "ports" || data.nonce !== nonce) return;
      const ports = event.ports;
      if (ports.length !== 2) return;
      const ingress = ports[0];
      const control = ports[1];
      if (ingress === undefined || control === undefined) return;
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
          if (!isRenderer(payload.renderer)) {
            throw new FacetRenderError(
              "artifact payload is missing a supported renderer",
              "invalid_request",
            );
          }
          const bytes = payload.bytes;
          if (bytes === undefined) {
            throw new FacetRenderError("artifact payload is missing bytes", "invalid_request");
          }
          await dispatchRender(
            registry,
            { container },
            {
              artifactType: payload.artifactType,
              renderer: payload.renderer,
              bytes: decodePayloadBytes(bytes),
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
