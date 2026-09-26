import { describe, expect, test } from "bun:test";

import { isFrameScriptError } from "../../src/gallery-web/frame-error-filter";

describe("isFrameScriptError", () => {
  test("accepts a window-targeted script ErrorEvent", () => {
    const frameWindow = new EventTarget() as unknown as Window;
    let event: Event | undefined;
    frameWindow.addEventListener("error", (value) => {
      event = value;
    });
    frameWindow.dispatchEvent(new ErrorEvent("error"));

    expect(event).toBeDefined();
    expect(isFrameScriptError(event!, frameWindow)).toBe(true);
  });

  test("rejects an element-targeted resource Event", () => {
    const frameWindow = new EventTarget() as unknown as Window;
    const image = new EventTarget() as unknown as Element;
    let event: Event | undefined;
    image.addEventListener("error", (value) => {
      event = value;
    });
    image.dispatchEvent(new Event("error"));

    expect(event).toBeDefined();
    expect(isFrameScriptError(event!, frameWindow)).toBe(false);
  });
});
