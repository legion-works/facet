/**
 * FAIL-CLOSED TSX renderer stub.
 *
 * Until Tasks 5-7 land, TSX is contract-valid and persistable but
 * CANNOT execute in the gallery or Tier 1. This stub ships the build
 * and the parity gate without introducing a script exemption or an
 * alias around the CSP \u2014 a stub that quietly executes something is a
 * security hole shipped early.
 *
 * `renderTsxUnavailable` is the typed failure the registry turns into
 * a `<facet-error>` marker. It MUST throw before parsing bytes: any
 * execution path that reads `bytes` is a regression. It MUST NOT
 * import React, React DOM, the bundler, or any module that would
 * cause the build to grow the renderer footprint beyond a typed
 * rejection.
 */
import {
  FacetRenderError,
  appendRenderError,
  decodeArtifactBytes,
  type RenderContext,
} from "./registry";

export function createTsxRendererRoot(ownerDocument: Document): HTMLElement {
  const root = ownerDocument.createElement("div");
  root.setAttribute("data-facet-renderer-root", "true");
  root.className = "facet-tsx-root";
  return root;
}

export async function renderTsx(ctx: RenderContext, _bytes: Uint8Array): Promise<void> {
  // Touch `decodeArtifactBytes` ONLY in the rejection message so a
  // caller cannot point at a future \"we decoded then threw\" branch
  // as evidence the stub executes anything. The decode call does
  // not touch artifact semantics; it exists to surface the byte
  // length in the typed error so the verdict can name it.
  const decoded = decodeArtifactBytes(_bytes);
  const ownerDocument = ctx.container.ownerDocument;
  const root = createTsxRendererRoot(ownerDocument);
  ctx.container.replaceChildren(root);
  appendRenderError(
    root,
    `TSX rendering is unavailable in this build (received ${decoded.length} source bytes)`,
  );
  throw new FacetRenderError(
    "TSX rendering is unavailable in this build; Tasks 5-7 must land before the gallery can execute tsx artifacts",
    "tsx_unavailable",
  );
}
