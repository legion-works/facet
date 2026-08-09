import { describe, expect, test } from "bun:test";

import { validateRenderer } from "../../src/gallery-web/frame/renderer-validation";
import { FacetRenderError } from "../../src/gallery-web/frame/renderers/registry";

describe("frame renderer boundary validation", () => {
  test("gallery frame rejects an unknown renderer before dispatch", () => {
    expect(() => validateRenderer("webgl")).toThrow(FacetRenderError);
    try {
      validateRenderer("webgl");
    } catch (error) {
      expect((error as FacetRenderError).code).toBe("invalid_request");
    }
  });

  test("Tier 1 harness rejects an unknown renderer before dispatch", () => {
    expect(() => validateRenderer("webgl")).toThrow(FacetRenderError);
    try {
      validateRenderer("webgl");
    } catch (error) {
      expect((error as FacetRenderError).code).toBe("invalid_request");
    }
  });
});
