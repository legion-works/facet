import { describe, expect, test } from "bun:test";

import { applySvgViewBox } from "../../src/gallery-web/frame/view-box";

const original = { minX: 10, minY: 20, width: 400, height: 200 };
const viewport = { width: 800, height: 400 };

describe("native SVG gallery viewBox", () => {
  test("applies shell zoom and screen pan in the original SVG coordinate system", () => {
    expect(applySvgViewBox(original, viewport, { zoom: 2, panX: 80, panY: -40 })).toEqual({
      minX: -10,
      minY: 30,
      width: 200,
      height: 100,
    });
  });

  test("is idempotent for the same state", () => {
    const state = { zoom: 2, panX: 80, panY: -40 };
    expect(applySvgViewBox(original, viewport, state)).toEqual(
      applySvgViewBox(original, viewport, state),
    );
  });

  test("restores the exact original-derived viewBox after a different state", () => {
    const stateA = { zoom: 2, panX: 80, panY: -40 };
    const stateB = { zoom: 4, panX: -120, panY: 60 };
    applySvgViewBox(original, viewport, stateB);
    expect(applySvgViewBox(original, viewport, stateA)).toEqual({
      minX: -10,
      minY: 30,
      width: 200,
      height: 100,
    });
  });
});
