/**
 * Mermaid renderer — the REAL mermaid runtime, `securityLevel: "strict"`.
 *
 * Renders the diagram to an SVG string via `mermaid.render()`, awaits
 * completion, then imports the result through the ONE sanitized-SVG
 * import path (`svg.ts`). Mermaid's own strict-mode sanitization is
 * the first layer; the shared import path is the second (defense in
 * depth — the frame CSP is the third).
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
    securityLevel: "strict",
    suppressErrorRendering: true,
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
  await importSanitizedSvgText(container, svg);
}

/** Render a standalone mermaid artifact (artifactType "mermaid"). */
export async function renderMermaidDocument(ctx: RenderContext, bytes: Uint8Array): Promise<void> {
  await renderMermaidInto(ctx.container, decodeArtifactBytes(bytes));
}
