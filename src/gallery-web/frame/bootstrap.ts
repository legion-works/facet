/**
 * Frame-side bootstrap — runs INSIDE the opaque-origin iframe.
 *
 * This module is the frame program: `scripts/build-gallery.ts` bundles
 * it (renderers included) into the ONE script the frame document loads
 * under the per-frame nonce, and the Tier 1 verifier harness bundles
 * the SAME renderers so the gate verifies what the operator sees. The
 * CSP rejects any script without the nonce, so this bundle is the only
 * executable code reachable inside the frame; artifact bytes arrive as
 * DATA on the ingress port and never become executable.
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
 * commands). The shell owns zoom/pan via the iframe element transform;
 * the frame records the latest view-state and takes no further action.
 */

import {
  appendRenderError,
  countPageShim,
  dispatchRender,
  getRendererRegistry,
  FacetRenderError,
} from "./renderers/registry";

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
  readonly bytes?: Uint8Array | string;
}

const container = document.getElementById("artifact");
if (container === null) {
  throw new Error("bootstrap: #artifact container missing");
}

const registry = getRendererRegistry();

// The frame document's own URL carries the per-frame nonce (the service
// validates its shape before echoing it into the CSP header), and the
// handshake must match it. Read it from `location` rather than the script
// tag: `document.currentScript` is ALWAYS null in a module script, and a
// nonce content attribute is hidden from DOM reads. Keeping the nonce off
// the bundle URL leaves ONE cacheable bundle valid across frames.
const nonce = new URLSearchParams(location.search).get("nonce") ?? "";

let controlPost: ((event: unknown) => void) | null = null;

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
    control.onmessage = (_controlEvent: MessageEvent) => {
      // View-state messages are recorded for future consumers (pan/zoom
      // is owned by the shell today); the frame intentionally no-ops.
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    ingress.onmessage = async (sourceEvent: MessageEvent) => {
      // One-shot ingress: receive the artifact, then close the port.
      ingress.close();
      const payload = sourceEvent.data as ArtifactPayload | null;
      try {
        if (payload === null || typeof payload.artifactType !== "string") {
          throw new FacetRenderError("artifact payload is missing artifactType", "invalid_request");
        }
        const bytes = payload.bytes;
        if (bytes === undefined) {
          throw new FacetRenderError("artifact payload is missing bytes", "invalid_request");
        }
        await dispatchRender(
          registry,
          { container },
          { artifactType: payload.artifactType, bytes: decodePayloadBytes(bytes) },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendRenderError(container, message);
      }
      // Counts cross the control port ONLY after the render settled.
      deliver({ type: "render-complete", observed: countPageShim() });
    };
    deliver({ type: "boot-ready" });
    // oxlint-disable-next-line no-underscore-dangle
    window.__facetBootstrapReady = true;
  },
  { once: false },
);

export const bootstrapLoaded = true;
export type { ArtifactPayload };
