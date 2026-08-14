import { describe, expect, test } from "bun:test";

import {
  clampZoom,
  nextViewStateForKey,
  resetViewState,
  zoomAtPoint,
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
});

describe("nextViewStateForKey — shared shell/frame keydown mapping", () => {
  const rect = { width: 200, height: 100 };

  test("'+' and '=' zoom in around the viewport center", () => {
    const state = { zoom: 1, panX: 0, panY: 0 };
    const plus = nextViewStateForKey(state, "+", false, rect);
    const equals = nextViewStateForKey(state, "=", false, rect);
    expect(plus).not.toBeNull();
    expect(plus?.zoom).toBeGreaterThan(1);
    expect(equals).toEqual(plus);
  });

  test("'-' zooms out and stays within MIN_ZOOM", () => {
    const next = nextViewStateForKey({ zoom: 1, panX: 0, panY: 0 }, "-", false, rect);
    expect(next).not.toBeNull();
    expect(next?.zoom).toBeLessThan(1);
    expect(next?.zoom).toBeGreaterThanOrEqual(0.25);
  });

  test("'0' resets zoom and pan", () => {
    const next = nextViewStateForKey({ zoom: 3, panX: 40, panY: -20 }, "0", false, rect);
    expect(next).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  test("arrow keys pan by the unshifted step", () => {
    const state = { zoom: 1, panX: 0, panY: 0 };
    expect(nextViewStateForKey(state, "ArrowLeft", false, rect)).toEqual({
      zoom: 1,
      panX: -10,
      panY: 0,
    });
    expect(nextViewStateForKey(state, "ArrowRight", false, rect)).toEqual({
      zoom: 1,
      panX: 10,
      panY: 0,
    });
    expect(nextViewStateForKey(state, "ArrowUp", false, rect)).toEqual({
      zoom: 1,
      panX: 0,
      panY: -10,
    });
    expect(nextViewStateForKey(state, "ArrowDown", false, rect)).toEqual({
      zoom: 1,
      panX: 0,
      panY: 10,
    });
  });

  test("shift+arrow pans by the larger step", () => {
    const next = nextViewStateForKey({ zoom: 1, panX: 0, panY: 0 }, "ArrowRight", true, rect);
    expect(next).toEqual({ zoom: 1, panX: 50, panY: 0 });
  });

  test("an unbound key returns null", () => {
    expect(nextViewStateForKey({ zoom: 1, panX: 0, panY: 0 }, "a", false, rect)).toBeNull();
  });
});
