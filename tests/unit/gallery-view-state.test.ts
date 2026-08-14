import { describe, expect, test } from "bun:test";

import { clampZoom, resetViewState, zoomAtPoint } from "../../src/gallery-web/view-state";

describe("gallery view state", () => {
  test("clamps zoom to the supported range", () => {
    expect(clampZoom(0)).toBe(0.25);
    expect(clampZoom(9)).toBe(8);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  test("keeps the cursor-anchored point fixed while zooming", () => {
    const next = zoomAtPoint({ zoom: 1, panX: 10, panY: -5 }, 2, 100, 80);
    expect(next).toEqual({ zoom: 2, panX: -80, panY: -90 });
  });

  test("reset clears both zoom and pan", () => {
    expect(resetViewState({ zoom: 4, panX: 120, panY: -40 })).toEqual({
      zoom: 1,
      panX: 0,
      panY: 0,
    });
  });
});
