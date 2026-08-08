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
 *      The entry imports the SAME renderer registry the gallery frame
 *      bundles (`gallery-web/frame/renderers`), so mermaid/markdown
 *      run as real ESM inlined under the nonce — no sibling
 *      `<script src>` for the file:// CSP to reject.
 *   2. Build the harness srcdoc with the bootstrap inlined under a
 *      per-frame nonce.
 *   3. The host page points its iframe at the harness srcdoc via
 *      file://. The bootstrap is the only executable code; the
 *      verifier renders artifacts through the shared renderers.
 */

import { build } from "bun";

import { frameBundlePlugins } from "../../shared/build/frame-bundle-plugins";

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
 * Build the harness browser bundle (bootstrap + the shared renderer
 * registry, inlined as ESM). Returns the bundled JS plus its byte
 * length. The bundle is inlined into the srcdoc under the per-frame
 * nonce — the file:// CSP problem that blocks sibling `<script src>`
 * does not apply to nonce-carrying inline script, so the REAL
 * mermaid/markdown/vega renderers run inside the verifier frame.
 */
async function buildBootstrapBundle(): Promise<{ readonly code: string; readonly bytes: number }> {
  const result = await build({
    entrypoints: [HARNESS_ENTRY],
    target: "browser",
    minify: false,
    format: "esm",
    plugins: frameBundlePlugins(),
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
 * a per-frame nonce. The renderers live inside the bundle itself so
 * no external script is loaded. The CSP `script-src` only needs
 * `'nonce-<NONCE>'` because the artifact bytes are inserted via
 * `innerHTML` inside the page world (not as executable script).
 *
 * The script tag is `type="module"` on purpose: Vega's bundled source
 * declares `function addEventListener(...)` at the top level, and a
 * classic `<script>` would hoist that into `window.addEventListener`,
 * replacing the native one before the harness's own
 * `window.addEventListener("message", ...)` listener could be
 * registered. The module script keeps top-level function declarations
 * in the module scope instead of the global one.
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
    `<script type="module" nonce="${nonce}">${escaped}</script>` +
    "</body></html>";
  return { srcdoc, nonce, bundleBytes: bytes };
}

/**
 * Write the harness srcdoc to `hostDir` and build the host page that
 * transfers the artifact + ports into the frame. The host page's
 * iframe points at the srcdoc; the artifact's declared type travels
 * with the ingress payload so the harness dispatches the same
 * renderer the gallery uses.
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
  artifactType: string,
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
    "var artifactType=" +
    JSON.stringify(artifactType) +
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
    "window.__facetHostArtifact={bytes:artifactB64,mode:artifactMode,artifactType:artifactType,ingress:ingress.port1,control:control.port1};" +
    "})();" +
    "</script>" +
    "</body></html>";
  return { html, harnessBytes, harnessPath };
}
