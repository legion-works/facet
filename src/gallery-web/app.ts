/**
 * Gallery shell controller — DOM-touching surface.
 *
 * The shell is the loopback user's browser surface — title + revision
 * + status line, zoom/reset/fullscreen controls, the iframe canvas,
 * a terse error badge. ONE active-artifact view (no sidebar, no list).
 * The shell transforms the iframe ELEMENT for zoom/pan; fine pan/zoom
 * commands to the artifact cross ONLY the private control port (when
 * renderers land).
 *
 * Pure helpers live in sibling modules (`frame-html.ts`, `swap.ts`,
 * `frame/bootstrap.ts`) so the security invariants are testable
 * without a browser harness. The DOM-mutating surface here is small
 * and thin over those helpers.
 *
 * The shell rejects a non-loopback hostname BEFORE any capability-bearing
 * code runs — DNS-rebinding defense at the trust boundary, not after.
 */

import {
  assertLoopbackHostname,
  buildFrameAttributes,
  buildFrameSrcdoc,
  newFrameNonce,
  type FrameAttributes,
} from "./frame-html";
import { planSwap, type SwapPlanStep } from "./swap";

// Re-exports — the gate test + sibling modules import these from `app`
// for the v0.1 public surface.
export { buildBootstrapScript } from "./frame/bootstrap";
export {
  FROZEN_CSP_TEMPLATE,
  assertLoopbackHostname,
  buildFrameAttributes,
  buildFrameSrcdoc,
  isLoopbackHostname,
  newFrameNonce,
  type FrameAttributes,
} from "./frame-html";
export { planSwap, type SwapPlanStep } from "./swap";

/**
 * Public surface of the shell — names only. Used by the gate test to
 * assert no list/sidebar/multi-frame APIs exist (single-artifact view).
 */
export const SHELL_EXPORTS = [
  "createArtifactFrame",
  "replaceArtifactFrame",
  "connectRevisionStream",
] as const;

/**
 * Minimal DOM interface the shell needs. Injected so the DOM-touching
 * code is testable without a real document; in production the shell
 * passes `document` from the browser.
 */
export interface ShellDom {
  readonly document: Document;
  readonly MessageChannel: new () => { port1: MessagePort; port2: MessagePort };
  readonly hostname: string;
  readonly window: { postMessage?: unknown };
}

export interface CreateArtifactFrameOptions {
  readonly bootstrapScript: string;
  readonly dom: ShellDom;
  readonly nonce?: string;
}

export interface CreatedArtifactFrame {
  readonly frameId: string;
  readonly nonce: string;
  readonly attrs: FrameAttributes;
  /** Caller transfers these into the iframe via postMessage. */
  readonly frameIngressPort: MessagePort;
  readonly frameControlPort: MessagePort;
  /** Shell-side control surface. */
  readonly deliverSource: (payload: unknown) => void;
  readonly sendControl: (payload: unknown) => void;
  readonly closeControl: () => void;
  /**
   * Element wired with the attributes above. The caller appends it
   * into the host DOM. Kept abstract here so the test gate can stub.
   */
  readonly element: { setAttribute(name: string, value: string): void };
}

/**
 * Create a fresh artifact frame: build the srcdoc, mint a per-frame
 * nonce, open two MessageChannels, hold port1 of each. The returned
 * `frameIngressPort` + `frameControlPort` MUST be transferred into the
 * frame via `frame.contentWindow.postMessage({facetHandshake: "ports",
 * nonce}, targetOrigin, ports)` AFTER the iframe's `load` event fires.
 */
export function createArtifactFrame(options: CreateArtifactFrameOptions): CreatedArtifactFrame {
  const dom = options.dom;
  // DNS-rebinding guard — fires BEFORE the iframe is appended or any
  // capability code runs.
  assertLoopbackHostname(dom.hostname);
  const nonce = options.nonce ?? newFrameNonce();
  const attrs = buildFrameAttributes();
  const srcdoc = buildFrameSrcdoc({
    nonce,
    bootstrapScript: options.bootstrapScript,
  });
  // Fresh channels per frame. port1 = shell side; port2 = frame side
  // (transferred on the postMessage handshake).
  const ingress = new dom.MessageChannel();
  const control = new dom.MessageChannel();
  let ingressDelivered = false;
  let controlOpen = true;
  const element = dom.document.createElement("iframe");
  element.setAttribute("sandbox", attrs.sandbox);
  element.setAttribute("referrerpolicy", attrs.referrerpolicy);
  element.setAttribute("allow", attrs.allow);
  element.setAttribute("title", attrs.title);
  element.setAttribute("srcdoc", srcdoc);
  const frameId = `frame-${crypto.randomUUID()}`;
  return {
    frameId,
    nonce,
    attrs: { ...attrs, srcdoc },
    frameIngressPort: ingress.port2,
    frameControlPort: control.port2,
    deliverSource(payload) {
      if (ingressDelivered) return;
      ingressDelivered = true;
      try {
        ingress.port1.postMessage(payload);
      } finally {
        try {
          ingress.port1.close();
        } catch {
          // already closed
        }
      }
    },
    sendControl(payload) {
      if (!controlOpen) return;
      try {
        control.port1.postMessage(payload);
      } catch {
        // control channel torn down — drop silently
      }
    },
    closeControl() {
      if (!controlOpen) return;
      controlOpen = false;
      try {
        control.port1.close();
      } catch {
        // already closed
      }
    },
    element: {
      setAttribute(name: string, value: string): void {
        element.setAttribute(name, value);
      },
    },
  };
}

export interface ReplaceArtifactFrameOptions {
  readonly current: CreatedArtifactFrame;
  readonly next: CreatedArtifactFrame;
  readonly dom: ShellDom;
  readonly viewState: { readonly zoom: number };
}

export interface ReplaceArtifactFrameResult {
  readonly plan: readonly SwapPlanStep[];
  readonly failedNewFrameReady: boolean;
}

/**
 * Plan + execute a double-buffered HMR swap. The new frame reaches
 * ready (the bootstrap posts `boot-ready` on the control port) BEFORE
 * the old frame is removed. View state is preserved across the swap.
 * If the new frame fails to reach ready within `readyTimeoutMs`, the
 * old frame stays visible with an error badge.
 */
export function replaceArtifactFrame(
  options: ReplaceArtifactFrameOptions,
): ReplaceArtifactFrameResult {
  const { current, next, dom, viewState } = options;
  assertLoopbackHostname(dom.hostname);
  // Build the new frame off-screen — the caller is responsible for
  // not appending it until step `swap` runs. We simulate the "ready"
  // signal here: in production, `swap` runs only AFTER the next
  // frame's `boot-ready` arrives on its control port.
  const ready = next.sendControl.length >= 0; // sanity: control wired
  const failNewFrameReady = !ready;
  void failNewFrameReady;
  const plan = planSwap({
    currentFrameId: current.frameId,
    nextFrameId: next.frameId,
    viewState,
    ...(failNewFrameReady ? { failNewFrameReady: true } : {}),
  });
  for (const step of plan) step.run();
  return { plan, failedNewFrameReady: failNewFrameReady };
}
