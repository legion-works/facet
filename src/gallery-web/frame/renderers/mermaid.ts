/**
 * Mermaid renderer — the REAL mermaid runtime, `securityLevel: "loose"`.
 *
 * Renders the diagram to an SVG string via `mermaid.render()`, awaits
 * completion, then imports the result through the ONE sanitized-SVG
 * import path (`svg.ts`). Mermaid's strict/sandbox levels add a
 * whole-SVG DOMPurify pass on top — redundant here, and broken in the
 * srcdoc bundle: the shim DOMPurify's SVG-input `_initDocument` path
 * resolves `body` to null and returns `""` for every diagram. "loose"
 * skips that pass (`!isLooseSecurityLevel` guard in mermaid's render),
 * so `importSanitizedSvgText` is the SOLE outer-SVG sanitizer — script,
 * foreignObject, on* handlers, and non-fragment URLs are still stripped
 * there; the frame CSP is the backstop. Per-label `sanitizeText`
 * (DOMPurify via the shim) is unaffected by the security level.
 *
 * Two render-time hazards are handled explicitly:
 *   1. `mermaid.render()` leaves its sandbox container (`d<id>` div)
 *      in the document — it is removed after every render so it can
 *      never inflate the verifier's SVG census.
 *   2. `suppressErrorRendering` keeps parse failures from injecting
 *      mermaid's own error SVG; a failed render surfaces as a
 *      facet-error marker instead.
 *
 * `flowchart.htmlLabels` is OFF: labels render as SVG text, so markup
 * inside a label is DATA (visible text), never an HTML subtree — the
 * nested-`<svg>`-in-label forgery probe has no surface to land on.
 */

import mermaid from "mermaid";

import { FacetRenderError, type RenderContext, decodeArtifactBytes } from "./registry";
import { importSanitizedSvgText } from "./svg";

let initialized = false;

function ensureMermaidInitialized(): void {
  if (initialized) return;
  initialized = true;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    suppressErrorRendering: true,
    // The stage is dark. Mermaid's default (light) theme paints edges
    // #333 and label text near-black — invisible here.
    theme: "dark",
    darkMode: true,
    // htmlLabels OFF at EVERY level that can re-enable it. An HTML label
    // is emitted inside a `<foreignObject>`, which the SVG import path
    // strips as an XSS vector — so an HTML label renders as an EMPTY
    // box. Text labels keep markup as DATA and survive the sanitizer.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
  });
}

let renderCounter = 0;

/**
 * Render one mermaid diagram source into the container. Awaits
 * `mermaid.render()` completion BEFORE the SVG crosses the sanitized
 * import path — render-complete semantics depend on this barrier.
 */
export async function renderMermaidInto(container: HTMLElement, source: string): Promise<void> {
  ensureMermaidInitialized();
  renderCounter += 1;
  const id = `facet-mermaid-${renderCounter}-${crypto.randomUUID()}`;
  let svg: string;
  try {
    const result = await mermaid.render(id, source);
    svg = result.svg;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FacetRenderError(`mermaid render failed: ${message}`, "mermaid_render_error");
  } finally {
    // Mermaid parks its sandbox in `d<id>` and does not remove it.
    document.getElementById(`d${id}`)?.remove();
  }
  await importSanitizedSvgText(container, svg, { marker: "graph" });
}

/** Render a standalone mermaid artifact (artifactType "mermaid"). */
export async function renderMermaidDocument(ctx: RenderContext, bytes: Uint8Array): Promise<void> {
  await renderMermaidInto(ctx.container, decodeArtifactBytes(bytes));
}
