/**
 * Pure frame-HTML helpers — document + attribute generation, hostname
 * guard, per-frame nonce. No DOM mutation; the shell's createArtifactFrame
 * calls these to assemble the iframe configuration.
 *
 * Kept in a separate file from `app.ts` so the security invariants
 * (CSP exactness, nonce substitution, artifact-byte absence in the frame
 * document) are testable without touching the
 * DOM-touching surface.
 */

import { freshFrameNonce } from "./frame/channels";

/**
 * Frozen production CSP. `script-src 'nonce-<NONCE>'` is the ONLY script
 * authority — the trusted bootstrap, embedded under a per-frame nonce.
 * `style-src 'unsafe-inline'` is required for Mermaid's inline SVG
 * styles; it does NOT authorize script. We never add `script-src
 * 'unsafe-inline'`, `allow-same-origin`, or window.postMessage as a
 * trust path.
 */
export const FROZEN_CSP_TEMPLATE =
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

/**
 * Frame element attributes. The shell applies these to every iframe it
 * creates. The nonce is carried in the loopback document URL so the service
 * can deliver the frozen CSP as an HTTP response header.
 */
export interface FrameAttributes {
  readonly sandbox: "allow-scripts";
  readonly referrerpolicy: "no-referrer";
  readonly allow: "";
  readonly title: string;
  readonly src: string;
}

export function buildFrameAttributes(src = "/gallery/frame"): FrameAttributes {
  return {
    sandbox: "allow-scripts",
    referrerpolicy: "no-referrer",
    allow: "",
    title: "facet artifact frame",
    src,
  };
}

export function buildFrameDocument(options: { nonce: string; bootstrapUrl: string }): string {
  const { nonce, bootstrapUrl } = options;
  // The script tag is `type="module"` on purpose: Vega's bundled source
  // declares `function addEventListener(...)` at the top level, and a
  // classic `<script>` would hoist that into `window.addEventListener`,
  // replacing the native one before the frame's own message listener
  // can be registered. The module script keeps top-level function
  // declarations in the module scope instead of the global one.
  // The nonce authorizes this one external script without adding a host to
  // script-src. Keeping the bundle out of the document avoids parser hangs on
  // the multi-megabyte renderer while preserving the opaque sandbox origin.
  const escapedBootstrapUrl = bootstrapUrl
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return (
    "<!doctype html><html><head>" +
    `<meta charset="utf-8">` +
    // The frame is the artifact's whole viewport. Without these the
    // renderers inherit UA defaults — black text on the dark stage, and
    // an SVG at natural size that overflows instead of fitting.
    `<style>` +
    `html,body{margin:0;height:100%;background:transparent;` +
    `color:#c8d3f5;font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}` +
    // height (not min-height): a percentage max-height on the artifact
    // only resolves against a DEFINITE parent height, so min-height let
    // an oversized SVG overflow and crop instead of fitting.
    `#artifact{margin:0;height:100%;box-sizing:border-box;padding:16px;` +
    `display:flex;align-items:center;justify-content:center;overflow:auto}` +
    `#artifact>svg{max-width:100%;max-height:100%;height:auto;width:auto}` +
    `#artifact a{color:#82aaff}` +
    `#artifact code,#artifact pre{background:#1e2030;color:#c3e88d;border-radius:4px}` +
    `#artifact code{padding:1px 4px}#artifact pre{padding:10px;overflow:auto}` +
    `#artifact table{border-collapse:collapse}` +
    `#artifact th,#artifact td{border:1px solid #2f334d;padding:4px 8px}` +
    `#artifact blockquote{border-left:3px solid #444a73;margin:0 0 0 8px;padding-left:12px;color:#a9b8e8}` +
    `#artifact hr{border:0;border-top:1px solid #2f334d}` +
    `</style>` +
    "</head><body>" +
    `<main id="artifact"></main>` +
    `<script type="module" nonce="${nonce}" src="${escapedBootstrapUrl}"></script>` +
    "</body></html>"
  );
}

/**
 * The shell trusts the loopback only. Anything else is a DNS-rebind or
 * a same-origin-policy escape; the guard fires BEFORE the SSE stream
 * or the iframe is touched.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1";
}

export function assertLoopbackHostname(hostname: string): void {
  if (!isLoopbackHostname(hostname)) {
    throw new Error(
      `Refusing to run gallery shell: hostname must be 127.0.0.1 (got: ${JSON.stringify(hostname)})`,
    );
  }
}

/**
 * Per-frame nonce. Fresh per revision — a reused nonce would let an
 * old bootstrap survive into a new CSP window.
 */
export function newFrameNonce(): string {
  return freshFrameNonce();
}
