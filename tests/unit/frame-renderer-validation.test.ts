import { describe, expect, test } from "bun:test";

import {
  validateGalleryRenderer,
  validateTier1Renderer,
} from "../../src/gallery-web/frame/renderer-validation";
import { FacetRenderError } from "../../src/gallery-web/frame/renderers/registry";

describe("frame renderer boundary validation", () => {
  test("gallery frame rejects an unknown renderer before dispatch", () => {
    expect(() => validateGalleryRenderer("webgl")).toThrow(FacetRenderError);
    try {
      validateGalleryRenderer("webgl");
    } catch (error) {
      expect((error as FacetRenderError).code).toBe("invalid_request");
    }
  });

  test("Tier 1 harness rejects an unknown renderer before dispatch", () => {
    expect(() => validateTier1Renderer("webgl")).toThrow(FacetRenderError);
    try {
      validateTier1Renderer("webgl");
    } catch (error) {
      expect((error as FacetRenderError).code).toBe("invalid_request");
    }
  });
});
