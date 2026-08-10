import { FacetRenderError, type RenderContext } from "./registry";
import type { Renderer } from "../../../shared/contracts/renderers";

export async function renderHtmlStub(
  _ctx: RenderContext,
  _bytes: Uint8Array,
  _renderer: Renderer,
): Promise<void> {
  throw new FacetRenderError(
    "HTML rendering is not implemented in this build",
    "html_renderer_not_implemented",
  );
}
