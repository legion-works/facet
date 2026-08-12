/**
 * FAIL-CLOSED TSX renderer stub.
 *
 * Until Tasks 5-7 land, TSX is contract-valid and persistable but
 * CANNOT execute in the gallery or Tier 1. This stub ships the build
 * and the parity gate without introducing a script exemption or an
 * alias around the CSP — a stub that quietly executes something is a
 * security hole shipped early.
 *
 * `renderTsx` MUST throw before any read of the artifact bytes:
 * any execution path that touches `_bytes` is a regression, even
 * for the byte length or to populate a typed-error marker. The
 * dispatch contract has the harness own the marker (see
 * `bootstrap.ts` and `harness-entry.ts`, both wrap renderer throws
 * with `appendRenderError`); this renderer is a typed refusal and
 * nothing more. The stub MUST NOT import React, React DOM, the
 * bundler, or any module that would cause the build to grow the
 * renderer footprint beyond a typed rejection.
 */
import { FacetRenderError, type RenderContext } from "./registry";

export async function renderTsx(_ctx: RenderContext, _bytes: Uint8Array): Promise<void> {
  // Intentionally ignores `_ctx` and `_bytes`. Touching either is a
  // regression: the dispatch contract is "throw a typed refusal" and
  // the harness owns the error marker. Do not rationalize reading
  // `_bytes.byteLength` or any other metadata — the rejection is
  // unconditional until Tasks 5-7 land the real renderer.
  void _ctx;
  void _bytes;
  throw new FacetRenderError(
    "TSX rendering is unavailable in this build; Tasks 5-7 must land before the gallery can execute tsx artifacts",
    "tsx_unavailable",
  );
}
