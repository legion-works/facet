/**
 * Pure frame-HTML helpers — srcdoc + attribute generation, hostname
 * guard, per-frame nonce. No DOM mutation; the shell's createArtifactFrame
 * calls these to assemble the iframe configuration.
 *
 * Kept in a separate file from `app.ts` so the security invariants
 * (CSP exactness, charset-before-CSP ordering, nonce substitution,
 * artifact-byte absence in srcdoc) are testable without touching the
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
 * creates. `src` is intentionally absent — the srcdoc carries the WHOLE
 * document, including the nonce'd CSP.
 */
export interface FrameAttributes {
  readonly sandbox: "allow-scripts";
  readonly referrerpolicy: "no-referrer";
  readonly allow: "";
  readonly title: string;
  readonly srcdoc: string;
}

export function buildFrameAttributes(): Omit<FrameAttributes, "srcdoc"> {
  return {
    sandbox: "allow-scripts",
    referrerpolicy: "no-referrer",
    allow: "",
    title: "facet artifact frame",
  };
}

export function buildFrameSrcdoc(options: { nonce: string; bootstrapScript: string }): string {
  const { nonce, bootstrapScript } = options;
  // Charset meta MUST precede the CSP meta — a CSP declared before the
  // charset parser hint is treated as unsafe.
  //
  // The bootstrap text has any literal `</script` escaped to `<\\/script`
  // so an attacker-controlled script (future renderer) cannot terminate
  // the parent <script> tag and break out of the nonce boundary.
  const escapedBootstrap = bootstrapScript.replace(/<\/script/gi, "<\\/script");
  const csp = FROZEN_CSP_TEMPLATE.replace("<BOOTSTRAP_NONCE>", nonce);
  return (
    "<!doctype html><html><head>" +
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>html,body,#artifact{margin:0;min-height:100%;background:transparent}</style>` +
    "</head><body>" +
    `<main id="artifact"></main>` +
    `<script nonce="${nonce}">${escapedBootstrap}</script>` +
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
