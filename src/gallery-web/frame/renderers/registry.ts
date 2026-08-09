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

export const ARTIFACT_TYPES = ["markdown", "mermaid", "svg", "chart"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface RenderContext {
  readonly container: HTMLElement;
}

export type Renderer = (ctx: RenderContext, bytes: Uint8Array) => Promise<void>;

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
  readonly errorCount: number;
}

function safeSelectorCount(selector: string): number {
  // The shim lives in the PAGE world on purpose: a hostile page can
  // monkey-patch querySelectorAll and lie here — the Tier 1 verdict
  // detects that lie against the protocol authority. Reading through
  // the patchable API is the design, not a bug.
  let result: unknown;
  try {
    result = document.querySelectorAll(selector);
  } catch {
    result = [];
  }
  return result !== null && typeof result === "object" && "length" in result
    ? Number((result as { length: number }).length)
    : 0;
}

/** Page-world self-report emitted with `render-complete`. UNTRUSTED by design. */
export function countPageShim(): PageShimCounts {
  const svgLength = safeSelectorCount("svg");
  const errorLength = safeSelectorCount("[data-facet-error]");
  return {
    rendererRootSvgCount: svgLength,
    graphCount: svgLength,
    mermaidNodeCount: svgLength,
    visibleSvgCount: svgLength,
    errorCount: errorLength,
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
 * Dispatch one artifact through the registry. Unknown types (the
 * reserved `html` literal included) throw — the caller turns the
 * throw into a facet-error marker, never executable content.
 */
export async function dispatchRender(
  registry: RendererRegistry,
  ctx: RenderContext,
  payload: { readonly artifactType: string; readonly bytes: Uint8Array },
): Promise<void> {
  const renderer = registry.get(payload.artifactType);
  if (renderer === undefined) {
    throw new FacetRenderError(
      `Artifact type '${payload.artifactType}' has no renderer in this frame`,
      "unsupported_reserved_type",
    );
  }
  await renderer(ctx, payload.bytes);
}
