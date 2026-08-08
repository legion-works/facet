/**
 * Verifier harness bundle — the in-frame rendering pipeline the
 * Tier 1 verifier drives via the pre-armed probe sequence.
 *
 * The harness is intentionally NOT the gallery frame: the gallery
 * frame renders for the operator's interactive use; this harness
 * renders for the verifier's adversarial probes.
 *
 * Build pipeline:
 *   1. Bundle the bootstrap (`harness-entry.ts`) as ESM via bun.build.
 *   2. Build the harness srcdoc with the bootstrap inlined under a
 *      per-frame nonce. The verifier uses a lightweight in-frame
 *      renderer (NOT a Mermaid UMD) so the bundle stays small and
 *      avoids the file:// CSP / sibling-`<script src>` mismatch
 *      that blocks external-script loading from a sandboxed
 *      iframe in the netns verifier.
 *   3. The host page points its iframe at the harness srcdoc via
 *      file://. The bootstrap is the only executable code; the
 *      verifier renders mermaid blocks via a hand-written minimal
 *      renderer that emits one renderer-OWNED svg per fence.
 */

import { build } from "bun";

const HARNESS_ENTRY = `${import.meta.dir}/harness-entry.ts`;

/**
 * Frozen CSP the harness srcdoc ships with. Identical directive
 * shape to the gallery frame's CSP so the harness has the same
 * script-authority boundary: only the bundled bootstrap (under the
 * per-frame nonce) is executable; received artifact bytes never
 * become executable script.
 */
export const HARNESS_CSP =
  "default-src 'none'; " +
  "script-src 'nonce-<BOOTSTRAP_NONCE>'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data:; " +
  "font-src data:; " +
  "worker-src 'none'; " +
  "connect-src 'none'; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none'; " +
  "frame-src 'none'; " +
  "media-src 'none'";

function freshNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the harness browser bundle (bootstrap only; uses the
 * hand-written minimal renderer in `harness-entry.ts` rather than
 * bundling a real Mermaid runtime). Returns the bundled JS plus its
 * byte length. The renderer is intentionally lightweight so the
 * bundle stays small enough to inline in a single script tag inside
 * the sandboxed iframe srcdoc — a 3.5 MB Mermaid UMD plus a CSP that
 * permits it as a sibling script would not survive the `file://`
 * origin / `'self'` mismatch that the netns verifier lives under.
 */
async function buildBootstrapBundle(): Promise<{ readonly code: string; readonly bytes: number }> {
  const result = await build({
    entrypoints: [HARNESS_ENTRY],
    target: "browser",
    minify: false,
    format: "esm",
  });
  if (!result.success) {
    throw new Error(`harness bundle failed: ${result.logs.map((log) => log.message).join("\n")}`);
  }
  const outputs = result.outputs;
  const output = outputs[0];
  if (output === undefined) {
    throw new Error("harness bundle produced no output");
  }
  const text = await output.text();
  return { code: text, bytes: text.length };
}

/**
 * Build the harness srcdoc with the bundled bootstrap inlined under
 * a per-frame nonce. The Mermaid-style rendering lives inside the
 * bundle itself (hand-written minimal renderer in `harness-entry.ts`)
 * so no external script is loaded. The CSP `script-src` only
 * needs `'nonce-<NONCE>'` because the artifact bytes are inserted
 * via `innerHTML` inside the page world (not as executable script).
 */
export async function buildHarnessSrcdoc(): Promise<{
  readonly srcdoc: string;
  readonly nonce: string;
  readonly bundleBytes: number;
}> {
  const nonce = freshNonce();
  const { code, bytes } = await buildBootstrapBundle();
  const escaped = code.replace(/<\/script/gi, "<\\/script");
  const csp = HARNESS_CSP.replace("<BOOTSTRAP_NONCE>", nonce);
  const srcdoc =
    "<!doctype html><html><head>" +
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>html,body,#artifact{margin:0;min-height:100%;background:transparent}</style>` +
    "</head><body>" +
    `<main id="artifact"></main>` +
    `<script nonce="${nonce}">${escaped}</script>` +
    "</body></html>";
  return { srcdoc, nonce, bundleBytes: bytes };
}

/**
 * Write the harness srcdoc + Mermaid UMD bundle to `hostDir`. The
 * host page's iframe points at the srcdoc; the iframe's CSP allows
 * the Mermaid UMD via its precomputed SHA-256 hash.
 */
export interface HostPageInputs {
  readonly html: string;
  readonly harnessBytes: number;
  readonly harnessPath: string;
}

export async function buildHostPage(
  artifactBytes: Uint8Array,
  artifactMode: "raw" | "render",
  hostDir: string,
): Promise<HostPageInputs> {
  const { srcdoc, bundleBytes: harnessBytes } = await buildHarnessSrcdoc();
  const harnessPath = `${hostDir}/harness.html`;
  await Bun.write(harnessPath, srcdoc);
  const b64 = Buffer.from(artifactBytes).toString("base64");
  const html =
    "<!doctype html><html><head>" +
    `<meta charset="utf-8">` +
    "<title>facet-tier1-host</title>" +
    "</head><body>" +
    `<main id="host-root"></main>` +
    "<script>" +
    "(function(){" +
    "var artifactB64=" +
    JSON.stringify(b64) +
    ";" +
    "var artifactMode=" +
    JSON.stringify(artifactMode) +
    ";" +
    "var harnessPath=" +
    JSON.stringify(harnessPath) +
    ";" +
    "var ingress=new MessageChannel();" +
    "var control=new MessageChannel();" +
    "window.__facetShimEvents=[];" +
    "control.port1.onmessage=function(ev){window.__facetShimEvents.push(ev.data);};" +
    "var frame=document.createElement('iframe');" +
    "frame.setAttribute('sandbox','allow-scripts');" +
    "frame.referrerPolicy='no-referrer';" +
    "frame.src=harnessPath;" +
    "frame.addEventListener('load',function(){" +
    "frame.contentWindow.postMessage({facetHandshake:'ports',nonce:''},'*',[ingress.port2,control.port2]);" +
    "});" +
    "document.getElementById('host-root').appendChild(frame);" +
    "window.__facetHostArtifact={bytes:artifactB64,mode:artifactMode,ingress:ingress.port1,control:control.port1};" +
    "})();" +
    "</script>" +
    "</body></html>";
  return { html, harnessBytes, harnessPath };
}
