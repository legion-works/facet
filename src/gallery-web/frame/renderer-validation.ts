import { isRenderer, type Renderer } from "../../shared/contracts/renderers";

import { FacetRenderError } from "./renderers/registry";

export function validateGalleryRenderer(value: unknown): Renderer {
  if (!isRenderer(value)) {
    throw new FacetRenderError(
      "artifact payload is missing a supported renderer",
      "invalid_request",
    );
  }
  return value;
}

export function validateTier1Renderer(value: unknown): Renderer {
  if (!isRenderer(value)) {
    throw new FacetRenderError(
      "artifact payload is missing a supported renderer",
      "invalid_request",
    );
  }
  return value;
}
