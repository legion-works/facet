/**
 * Pure frame-HTML helpers — document + attribute generation, hostname
 * guard. No DOM mutation; the shell's createArtifactFrame
 * calls these to assemble the iframe configuration.
 *
 * Kept in a separate file from `app.ts` so frame-document invariants — CSP
 * exactness and artifact-byte absence — are testable without the DOM-touching
 * surface.
 */

/**
 * Frame element attributes. The shell applies these to every iframe it
 * creates.
 */
export interface FrameAttributes {
  readonly referrerpolicy: "no-referrer";
  readonly allow: "";
  readonly title: string;
  readonly src: string;
}

export function buildFrameAttributes(src = "/gallery/frame"): FrameAttributes {
  return {
    referrerpolicy: "no-referrer",
    allow: "",
    title: "facet artifact frame",
    src,
  };
}

export function buildFrameDocument(options: { artifactType: string; runtimeUrl: string }): string {
  const { artifactType, runtimeUrl } = options;
  const escapedRuntimeUrl = runtimeUrl
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return (
    "<!doctype html><html><head>" +
    `<meta charset="utf-8"><link rel="stylesheet" href="/gallery/frame/frame.css">` +
    (artifactType === "html" || artifactType === "tsx"
      ? `<link rel="stylesheet" href="/gallery/frame/artifact.css">`
      : "") +
    "</head><body>" +
    `<main id="artifact" data-facet-artifact-type="${artifactType}"></main>` +
    `<script type="module" src="${escapedRuntimeUrl}"></script>` +
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
