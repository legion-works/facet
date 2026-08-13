import { describe, expect, test } from "bun:test";

import {
  clampCssPan,
  clampNativeSvgPan,
  clampZoom,
  resetViewState,
  validateViewMode,
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

  test("keeps at least 48 pixels of a CSS-transformed artifact visible", () => {
    expect(
      clampCssPan(
        { zoom: 8, panX: 100_000, panY: -100_000 },
        { width: 800, height: 600 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ zoom: 8, panX: 752, panY: -4752 });
  });

  test("allows a zoomed-out CSS artifact to pan while retaining 48 pixels", () => {
    expect(
      clampCssPan(
        { zoom: 0.25, panX: 10_000, panY: -10_000 },
        { width: 800, height: 600 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ zoom: 0.25, panX: 752, panY: -102 });
  });

  test("keeps a native SVG intersecting the viewport at both zoom extremes", () => {
    expect(
      clampNativeSvgPan({ zoom: 8, panX: 100_000, panY: -100_000 }, { width: 800, height: 600 }),
    ).toEqual({ zoom: 8, panX: 752, panY: -4752 });
    expect(
      clampNativeSvgPan({ zoom: 0.25, panX: 100_000, panY: -100_000 }, { width: 800, height: 600 }),
    ).toEqual({ zoom: 0.25, panX: 752, panY: -102 });
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

  test("accepts only native and css frame view modes", () => {
    expect(validateViewMode({ type: "view-mode", mode: "native" })).toBe("native");
    expect(validateViewMode({ type: "view-mode", mode: "css" })).toBe("css");
    expect(validateViewMode({ type: "view-mode", mode: "script" })).toBeNull();
    expect(validateViewMode({ type: "view-mode", mode: "native", zoom: 8 })).toBeNull();
    expect(validateViewMode({ type: "view-mode", kind: "view-intent", mode: "native" })).toBeNull();
    const prototypeLess = Object.assign(Object.create(null), { type: "view-mode", mode: "native" });
    expect(validateViewMode(prototypeLess)).toBe("native");
  });
});
