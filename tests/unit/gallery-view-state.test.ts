import { describe, expect, test } from "bun:test";

import {
  clampZoom,
  resetViewState,
  validateViewIntent,
  zoomAtPoint,
  type ViewIntent,
} from "../../src/gallery-web/view-state";

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

  test("accepts bounded numeric frame intents and rejects hostile values", () => {
    const valid: ViewIntent = {
      type: "view-intent",
      mode: "pan",
      dx: 4,
      dy: -2,
    };
    expect(validateViewIntent(valid)).toEqual(valid);
    expect(validateViewIntent({ type: "view-intent", mode: "zoom", deltaY: 1e9 })).toBeNull();
    expect(
      validateViewIntent({
        type: "view-intent",
        mode: "zoom",
        deltaY: 10,
        cursorX: Number.POSITIVE_INFINITY,
        cursorY: 10,
        rect: { w: 800, h: 600 },
      }),
    ).toBeNull();
  });
});
