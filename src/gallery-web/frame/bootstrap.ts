/**
 * Frame-side bootstrap — runs INSIDE the opaque-origin iframe.
 *
 * This is the ONLY code that runs in the frame when srcdoc is parsed.
 * It is bundled by `scripts/build-gallery.ts` and embedded into the
 * srcdoc under a per-frame nonce. The CSP rejects any script that does
 * not carry that nonce, so this bundle is the only executable code
 * reachable inside the frame.
 *
 * The bootstrap's only responsibility is to wire the two transferred
 * ports to a tiny lifecycle: receive the artifact on the ingress port,
 * emit a `boot-ready` signal on the control port, emit a
 * `render-complete` (with the placeholder verdict) on the control port,
 * and listen for control messages (the shell never sends any yet — the
 * channel is reserved for the future renderer fine-pan/zoom + verdict
 * surface).
 *
 * No zod, no parser, no renderer. Renderers land next task.
 */

export interface BootstrapControlEvent {
  readonly type: "boot-ready" | "render-complete" | "view-state";
  readonly observed?: unknown;
  readonly zoom?: number;
}

/**
 * Build the frame-side bootstrap script as a string. Pure — no
 * side-effects at module load time. The caller (shell) embeds this
 * into srcdoc under the per-frame nonce.
 *
 * The placeholder verdict is inlined as a constant so the bundled
 * script has no runtime module resolution — it runs as a single
 * <script nonce="..."> block. The typed per-artifact renderer lands
 * next task; this bootstrap only demonstrates the trust path.
 */
export function buildBootstrapScript(options: { nonce: string }): string {
  const nonce = options.nonce;
  // The script runs inside the iframe. It must:
  //   1. Capture trusted DOM helpers before any other code runs.
  //   2. Wait for the `ports` handshake from the shell (via window.message).
  //   3. Verify the per-frame nonce before wiring the transferred ports.
  //   4. Post a `boot-ready` event on the control port.
  //   5. Receive the artifact on the ingress port (one-shot), then close.
  //   6. Render the placeholder verdict via trusted DOM helpers.
  //   7. Post a `render-complete` event on the control port.
  //
  // We intentionally keep the bootstrap tiny — the renderer lands next.
  return `;(function(){
"use strict";
var nonce = ${JSON.stringify(nonce)};
var trusted = {
  append: Node.prototype.appendChild.call.bind(Node.prototype.appendChild),
  createElement: document.createElement.bind(document),
  createElementNS: document.createElementNS.bind(document),
  setAttribute: Element.prototype.setAttribute.call.bind(Element.prototype.setAttribute),
  setTimeout: window.setTimeout.bind(window),
};
var controlPost = null;
var booted = false;
function deliver(event){ try { controlPost(event); } catch (_) {} }

window.addEventListener("message", function(event){
  var data = event.data;
  if (!data || data.facetHandshake !== "ports" || data.nonce !== nonce) return;
  var ports = event.ports || [];
  if (ports.length !== 2) return;
  var ingress = ports[0];
  var control = ports[1];
  if (!ingress || !control) return;
  controlPost = control.postMessage.bind(control);
  ingress.onmessage = function(sourceEvent){
    // One-shot ingress: receive artifact, then close the port.
    ingress.close();
    try {
      // Placeholder verdict — Task 9 replaces this with the typed renderer.
      deliver({ type: "render-complete", observed: { status: "shim_only", rendererRootSvgCount: 0, graphCount: 0, mermaidNodeCount: 0, visibleSvgCount: 0, errorCount: 0 } });
    } catch (_) {
      deliver({ type: "render-complete", observed: { status: "shim_only", rendererRootSvgCount: 0, graphCount: 0, mermaidNodeCount: 0, visibleSvgCount: 0, errorCount: 1 } });
    }
  };
  if (!booted) {
    booted = true;
    deliver({ type: "boot-ready" });
  }
}, { once: false });

// Expose a tiny test handle so the bootstrap-driven tests can assert
// boot arrived. Production code does not read this.
Object.defineProperty(window, "__facetBootstrapReady", { value: false, writable: true, configurable: true });
})();`;
}
