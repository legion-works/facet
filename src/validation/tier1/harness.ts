/**
 * Verifier harness bundle — the in-frame rendering pipeline the
 * Tier 1 verifier drives via the pre-armed probe sequence.
 *
 * The harness is intentionally NOT the gallery frame: the gallery
 * frame renders for the operator's interactive use; this harness
 * renders for the verifier's adversarial probes.
 *
 * Build pipeline:
 *   1. Bundle the artifact type's entry as ESM via bun.build. Its paired
 *      gallery entry imports the SAME renderer modules, enforced by the
 *      build-metafile parity test. The result is inlined under the nonce,
 *      with no sibling `<script src>` for the file:// CSP to reject.
 *   2. Build the harness srcdoc with the bootstrap inlined under a
 *      per-frame nonce.
 *   3. The host page points its iframe at the harness srcdoc via
 *      file://. The bootstrap is the only executable code; the
 *      verifier renders artifacts through the shared renderers.
 */

import { build } from "bun";

import { ARTIFACT_TYPES, type ArtifactType } from "../../gallery-web/frame/renderers/registry";
import { frameBundlePlugins } from "../../shared/build/frame-bundle-plugins";
import { FROZEN_CSP_TEMPLATE as HARNESS_CSP } from "../../shared/security/frozen-csp";

export { FROZEN_CSP_TEMPLATE as HARNESS_CSP } from "../../shared/security/frozen-csp";

const HARNESS_ENTRY_DIR = `${import.meta.dir}/entries`;

function freshNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build one type-specific harness browser bundle, inlined as ESM.
 * Returns the bundled JS plus its byte
 * length. The bundle is inlined into the srcdoc under the per-frame
 * nonce — the file:// CSP problem that blocks sibling `<script src>`
 * does not apply to nonce-carrying inline script, so the REAL
 * mermaid/markdown/vega renderers run inside the verifier frame.
 */
function parseArtifactType(artifactType: string): ArtifactType {
  if ((ARTIFACT_TYPES as readonly string[]).includes(artifactType)) {
    return artifactType as ArtifactType;
  }
  throw new Error(`Tier 1 harness has no renderer bundle for artifact type '${artifactType}'`);
}

async function buildBootstrapBundleUncached(artifactType: ArtifactType): Promise<{
  readonly code: string;
  readonly bytes: number;
}> {
  const result = await build({
    entrypoints: [`${HARNESS_ENTRY_DIR}/${artifactType}.ts`],
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

const bundlePromises = new Map<
  ArtifactType,
  Promise<{ readonly code: string; readonly bytes: number }>
>();

/**
 * Each type-specific bundle is a pure function of the source tree, so
 * rebuilding it per verification buys nothing and
 * puts a heavyweight bundler invocation on every run's critical path.
 * The per-frame nonce is applied to the srcdoc, not the bundle, so
 * sharing the bytes across runs is sound.
 */
function buildBootstrapBundle(
  artifactType: ArtifactType,
): Promise<{ readonly code: string; readonly bytes: number }> {
  let bundlePromise = bundlePromises.get(artifactType);
  if (bundlePromise === undefined) {
    bundlePromise = buildBootstrapBundleUncached(artifactType).catch((error: unknown) => {
      // A failed build must not poison the cache for later runs.
      bundlePromises.delete(artifactType);
      throw error;
    });
    bundlePromises.set(artifactType, bundlePromise);
  }
  return bundlePromise;
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
export async function buildHarnessSrcdoc(artifactType: string): Promise<{
  readonly srcdoc: string;
  readonly nonce: string;
  readonly bundleBytes: number;
}> {
  const rendererType = parseArtifactType(artifactType);
  const nonce = freshNonce();
  const { code, bytes } = await buildBootstrapBundle(rendererType);
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
  renderer = "svg",
): Promise<HostPageInputs> {
  const { srcdoc, bundleBytes: harnessBytes } = await buildHarnessSrcdoc(artifactType);
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
    "var renderer=" +
    JSON.stringify(renderer) +
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
    "window.__facetHostArtifact={bytes:artifactB64,mode:artifactMode,artifactType:artifactType,renderer:renderer,ingress:ingress.port1,control:control.port1};" +
    "})();" +
    "</script>" +
    "</body></html>";
  return { html, harnessBytes, harnessPath };
}
