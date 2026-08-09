import { describe, expect, test } from "bun:test";

import {
  captureScreenshotWithFallback,
  configureTier1Viewport,
} from "../../src/validation/tier1/runner";
import {
  TIER1_SCREENSHOT_CAP_BYTES,
  TIER1_VIEWPORT_HEIGHT,
  TIER1_VIEWPORT_WIDTH,
} from "../../src/validation/tier1/limits";

describe("Tier 1 screenshot evidence", () => {
  test("sets the deterministic viewport before render ingress", async () => {
    const calls: string[] = [];
    const session = {
      send: async <T = unknown>(method: string, params?: Record<string, unknown>) => {
        calls.push(`${method}:${JSON.stringify(params ?? {})}`);
        return {} as T;
      },
      detach: async () => {},
    };

    await configureTier1Viewport(session);
    await session.send("Runtime.evaluate", { expression: "render" });

    expect(calls[0]!).toBe(
      `Emulation.setDeviceMetricsOverride:${JSON.stringify({
        width: TIER1_VIEWPORT_WIDTH,
        height: TIER1_VIEWPORT_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      })}`,
    );
    expect(calls[0]!.startsWith("Emulation.setDeviceMetricsOverride")).toBe(true);
  });

  test("falls back to viewport-only capture when the full screenshot exceeds the cap", async () => {
    const oversized = "A".repeat(Math.ceil((TIER1_SCREENSHOT_CAP_BYTES * 4) / 3) + 5);
    const viewportOnly = Buffer.from("viewport screenshot").toString("base64");
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = {
      send: async <T = unknown>(method: string, params?: Record<string, unknown>) => {
        calls.push(params === undefined ? { method } : { method, params });
        return { data: calls.length === 1 ? oversized : viewportOnly } as T;
      },
      detach: async () => {},
    };

    const bufferSpy = Buffer as unknown as {
      from(value: unknown, encoding?: BufferEncoding): Buffer;
    };
    const decode = bufferSpy.from;
    let decodedOversizedPayload = false;
    bufferSpy.from = (value: unknown, encoding?: BufferEncoding) => {
      if (value === oversized) decodedOversizedPayload = true;
      return decode(value, encoding);
    };
    let result: Buffer | null;
    try {
      result = await captureScreenshotWithFallback(session);
    } finally {
      bufferSpy.from = decode;
    }

    expect(result).toEqual(Buffer.from("viewport screenshot"));
    expect(decodedOversizedPayload).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params?.captureBeyondViewport).toBe(true);
    expect(calls[1]?.params?.captureBeyondViewport).toBe(false);
  });
});
