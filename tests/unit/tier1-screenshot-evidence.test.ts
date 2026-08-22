import { describe, expect, test } from "bun:test";

import {
  captureScreenshotWithRetry,
  captureScreenshotWithFallback,
  configureTier1Viewport,
} from "../../src/validation/tier1/runner";
import { Tier1ResultSchema } from "../../src/shared/contracts/validation";
import {
  TIER1_SCREENSHOT_CAP_BYTES,
  TIER1_VIEWPORT_HEIGHT,
  TIER1_VIEWPORT_WIDTH,
} from "../../src/validation/tier1/limits";

describe("Tier 1 screenshot evidence", () => {
  test("requires a screenshot-unavailable marker only for partial results without a screenshot", () => {
    const base = {
      tier: 1 as const,
      status: "partial:layout_unverified" as const,
      artifactId: "artifact",
      revisionSha: "0".repeat(64),
      expected: {
        rendererRootSvgCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        externalImageCount: 0,
      },
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        externalImageCount: 0,
        errorCount: 0,
      },
      consolePath: "/tmp/console.txt",
    };

    expect(() => Tier1ResultSchema.parse({ ...base, screenshotPath: null })).toThrow();
    expect(() =>
      Tier1ResultSchema.parse({
        ...base,
        screenshotPath: null,
        screenshotError: {
          code: "screenshot_unavailable",
          message: "screenshot capture timed out",
        },
      }),
    ).not.toThrow();
    expect(() =>
      Tier1ResultSchema.parse({ ...base, screenshotPath: "/tmp/screenshot.png" }),
    ).not.toThrow();
    expect(() =>
      Tier1ResultSchema.parse({
        ...base,
        status: "ok",
        screenshotPath: null,
      }),
    ).not.toThrow();
  });

  test("accepts a screenshot-unavailable marker on a non-partial result", () => {
    const result = {
      tier: 1 as const,
      status: "ok" as const,
      artifactId: "artifact",
      revisionSha: "0".repeat(64),
      expected: {
        rendererRootSvgCount: 1,
        mermaidNodeCount: 0,
        visibleSvgCount: 1,
        opaqueRegionCount: 0,
        externalImageCount: 0,
      },
      observed: {
        rendererRootSvgCount: 1,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 1,
        opaqueRegionCount: 0,
        externalImageCount: 0,
        errorCount: 0,
      },
      screenshotPath: null,
      screenshotError: {
        code: "screenshot_unavailable" as const,
        message: "screenshot capture timed out",
      },
      consolePath: "/tmp/console.txt",
    };

    expect(() => Tier1ResultSchema.parse(result)).not.toThrow();
  });

  test("accepts legacy results without screenshotFormat and rejects invalid formats", () => {
    const result = {
      tier: 1 as const,
      status: "ok" as const,
      artifactId: "artifact",
      revisionSha: "0".repeat(64),
      expected: {
        rendererRootSvgCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        externalImageCount: 0,
      },
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        externalImageCount: 0,
        errorCount: 0,
      },
      screenshotPath: null,
      consolePath: null,
    };
    expect(() => Tier1ResultSchema.parse(result)).not.toThrow();
    expect(() => Tier1ResultSchema.parse({ ...result, screenshotFormat: "gif" })).toThrow();
  });

  test("sets the deterministic viewport before render ingress", async () => {
    const calls: string[] = [];
    const session = {
      send: async <T = unknown>(method: string, params?: Record<string, unknown>) => {
        calls.push(`${method}:${JSON.stringify(params ?? {})}`);
        return {} as T;
      },
      on: () => {},
      off: () => {},
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
      on: () => {},
      off: () => {},
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

  test("retries a bounded screenshot capture before recording it as unavailable", async () => {
    let attempts = 0;
    const session = {
      send: async <T = unknown>() => ({}) as T,
      on: () => {},
      off: () => {},
      detach: async () => {},
    };
    const result = await captureScreenshotWithRetry(session, {
      attempts: 2,
      timeoutMs: 25,
      capture: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first capture failed");
        return Buffer.from("recovered screenshot");
      },
    });

    expect(attempts).toBe(2);
    expect(result.screenshot).toEqual(Buffer.from("recovered screenshot"));
    expect(result.screenshotError).toBeNull();
  });

  test("records a screenshot-unavailable marker after bounded capture retries exhaust", async () => {
    const startedAt = performance.now();
    const session = {
      send: async <T = unknown>() => ({}) as T,
      on: () => {},
      off: () => {},
      detach: async () => {},
    };
    const result = await captureScreenshotWithRetry(session, {
      attempts: 2,
      timeoutMs: 25,
      capture: async () => new Promise<Buffer>(() => {}),
    });

    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(result.screenshot).toBeNull();
    expect(result.screenshotError).toMatchObject({ code: "screenshot_unavailable" });
  });
});
