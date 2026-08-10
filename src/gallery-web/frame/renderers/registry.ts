import type { ArtifactType } from "../../../shared/contracts/artifact-types";
import { isRenderer, type Renderer as RendererKind } from "../../../shared/contracts/renderers";
import { HTML_STRUCTURAL_GROUPS } from "../../../shared/html/policy";

export { ARTIFACT_TYPES, type ArtifactType } from "../../../shared/contracts/artifact-types";

/**
 * Frame-side renderer registry — keyed by ArtifactType.
 *
 * Runs INSIDE the opaque-origin frame. Gallery and Tier 1 have paired
 * type-specific entries that instantiate this registry with the SAME
 * renderer modules; the build-metafile parity gate turns red if those
 * module sets diverge. Artifact bytes are DATA: dispatch routes them to
 * the typed renderer and every renderer builds DOM through trusted APIs.
 *
 * No zod in the frame bundle: the wire shape is plain JS here.
 */

export interface RenderContext {
  readonly container: HTMLElement;
}

export type Renderer = (
  ctx: RenderContext,
  bytes: Uint8Array,
  renderer: RendererKind,
) => Promise<void>;

/**
 * Typed render failure. `code` travels into the facet-error element's
 * text so the verifier's discriminative surface can name the reason.
 */
export class FacetRenderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "FacetRenderError";
  }
}

export function decodeArtifactBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Append the renderer-owned error marker. The element carries
 * `data-facet-error` so every observation channel (page shim,
 * protocol probes) counts it the same way.
 */
export function appendRenderError(container: HTMLElement, message: string): void {
  const el = document.createElement("facet-error");
  el.setAttribute("data-facet-error", "true");
  el.textContent = message;
  container.appendChild(el);
}

export interface PageShimCounts {
  readonly rendererRootSvgCount: number;
  readonly graphCount: number;
  readonly mermaidNodeCount: number;
  readonly visibleSvgCount: number;
  readonly opaqueRegionCount: number;
  readonly errorCount: number;
  readonly html?: {
    readonly rendererRootCount: number;
    readonly headingCount: number;
    readonly tableCount: number;
    readonly listCount: number;
    readonly imageCount: number;
    readonly canvasCount: number;
    readonly externalImageCount: number;
  };
}

const RENDERER_ROOT_SELECTOR = 'svg[data-facet-renderer-root="true"]';
const MARKED_ROOT_SELECTOR = '[data-facet-renderer-root="true"]';
const RENDERER_GRAPH_ATTRIBUTE = "data-facet-renderer-graph";

function safeSelectorElementsWithin(scope: ParentNode, selector: string): Element[] {
  // The shim lives in the PAGE world on purpose: a hostile page can
  // monkey-patch querySelectorAll and lie here — the Tier 1 verdict
  // detects that lie against the protocol authority. Reading through
  // the patchable API is the design, not a bug.
  try {
    return Array.from(scope.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function safeSelectorElements(selector: string): Element[] {
  return safeSelectorElementsWithin(document, selector);
}

function hasMarkedRootAncestor(root: Element, roots: ReadonlySet<Element>): boolean {
  let parent = root.parentElement;
  while (parent !== null) {
    if (roots.has(parent)) return true;
    parent = parent.parentElement;
  }
  return false;
}

function nonDegenerateViewBox(svg: Element): boolean {
  const parts = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part));
  if (parts.length !== 4) return false;
  const [, , width, height] = parts as [number, number, number, number];
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

/** Page-world self-report emitted with `render-complete`. UNTRUSTED by design. */
export function countPageShim(): PageShimCounts {
  const markedCandidates = safeSelectorElements(RENDERER_ROOT_SELECTOR);
  const candidateSet = new Set(markedCandidates);
  const roots = markedCandidates.filter((root) => !hasMarkedRootAncestor(root, candidateSet));
  const graphRoots = roots.filter((root) => root.getAttribute(RENDERER_GRAPH_ATTRIBUTE) === "true");
  const allMarkedCandidates = safeSelectorElements(MARKED_ROOT_SELECTOR);
  const markedSet = new Set(allMarkedCandidates);
  const htmlRoots = allMarkedCandidates.filter(
    (root) => root.nodeName.toLowerCase() !== "svg" && !hasMarkedRootAncestor(root, markedSet),
  );
  const html =
    htmlRoots.length === 0
      ? undefined
      : {
          rendererRootCount: htmlRoots.length,
          headingCount: 0,
          tableCount: 0,
          listCount: 0,
          imageCount: 0,
          canvasCount: 0,
          externalImageCount: 0,
        };
  for (const root of htmlRoots) {
    html!.headingCount += safeSelectorElementsWithin(
      root,
      HTML_STRUCTURAL_GROUPS.headings.join(","),
    ).length;
    html!.tableCount += safeSelectorElementsWithin(
      root,
      HTML_STRUCTURAL_GROUPS.tables.join(","),
    ).length;
    html!.listCount += safeSelectorElementsWithin(
      root,
      HTML_STRUCTURAL_GROUPS.lists.join(","),
    ).length;
    const images = safeSelectorElementsWithin(root, HTML_STRUCTURAL_GROUPS.images.join(","));
    html!.imageCount += images.length;
    html!.externalImageCount += images.filter((image) => {
      try {
        return new URL(image.getAttribute("src") ?? "").protocol === "https:";
      } catch {
        return false;
      }
    }).length;
    html!.canvasCount += safeSelectorElementsWithin(
      root,
      HTML_STRUCTURAL_GROUPS.canvases.join(","),
    ).length;
  }
  const mermaidNodeCount = graphRoots.reduce(
    (count, root) => count + safeSelectorElementsWithin(root, "g.node").length,
    0,
  );
  // Marker-scoped renderer counts deliberately differ from this document-wide
  // canvas census: a smuggled canvas outside a renderer root remains observable.
  // getContext() would create the surface being observed and turn the probe into a false positive.
  const opaqueRegionCount = safeSelectorElements("*").filter(
    (element) => element.nodeName.toLowerCase() === "canvas",
  ).length;
  return {
    rendererRootSvgCount: roots.length,
    graphCount: graphRoots.length,
    mermaidNodeCount,
    visibleSvgCount: roots.filter(nonDegenerateViewBox).length,
    opaqueRegionCount,
    errorCount: safeSelectorElements("[data-facet-error]").length,
    ...(html === undefined ? {} : { html }),
  };
}

export interface RendererRegistry {
  readonly get: (type: string) => Renderer | undefined;
}

export function createRendererRegistry(
  entries: readonly (readonly [ArtifactType, Renderer])[],
): RendererRegistry {
  const registry = new Map<string, Renderer>(entries);
  return {
    get(type: string): Renderer | undefined {
      return registry.get(type);
    },
  };
}

/**
 * Dispatch one artifact through the registry. Unknown types throw — the caller
 * turns the throw into a facet-error marker, never executable content.
 */
export async function dispatchRender(
  registry: RendererRegistry,
  ctx: RenderContext,
  payload: {
    readonly artifactType: string;
    readonly renderer: RendererKind;
    readonly bytes: Uint8Array;
  },
): Promise<void> {
  if (!isRenderer(payload.renderer)) {
    throw new FacetRenderError(
      `Artifact renderer '${payload.renderer}' is not supported in this frame`,
      "invalid_request",
    );
  }
  const renderer = registry.get(payload.artifactType);
  if (renderer === undefined) {
    throw new FacetRenderError(
      `Artifact type '${payload.artifactType}' has no renderer in this frame`,
      "unsupported_reserved_type",
    );
  }
  await renderer(ctx, payload.bytes, payload.renderer);
}
