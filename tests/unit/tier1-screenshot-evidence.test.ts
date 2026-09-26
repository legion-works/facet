import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import {
  boundCaptureSize,
  captureBoundedScreenshot,
  captureBoundedScreenshotParams,
  captureEvidenceScreenshot,
  captureScreenshotWithRetry,
  captureTiledEvidenceScreenshot,
  configureTier1Viewport,
  hasDeclaredAnimation,
} from "../../src/validation/tier1/runner";
import { Tier1ResultSchema, type Tier1Input } from "../../src/shared/contracts/validation";
import {
  TIER1_SCREENSHOT_CAP_BYTES,
  TIER1_SCREENSHOT_MAX_AXIS_PX,
  TIER1_SCREENSHOT_MAX_PIXELS,
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

  test("declares static evidence animated only when the artifact frame has active animations", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = {
      send: async <T = unknown>(method: string, params?: Record<string, unknown>) => {
        calls.push(params === undefined ? { method } : { method, params });
        return { result: { value: true } } as T;
      },
      on: () => {},
      off: () => {},
      detach: async () => {},
    };

    const declared = await hasDeclaredAnimation({ execution: "static" } as Tier1Input, session, 41);

    expect(declared).toBe(true);
    expect(calls).toEqual([
      {
        method: "Runtime.evaluate",
        params: {
          contextId: 41,
          returnByValue: true,
          expression:
            "document.getAnimations().some(a => a.playState === 'running' || a.playState === 'pending')",
        },
      },
    ]);
  });

  test("declares interactive evidence animated without changing the artifact frame", async () => {
    let calls = 0;
    const session = {
      send: async <T = unknown>() => {
        calls += 1;
        return {} as T;
      },
      on: () => {},
      off: () => {},
      detach: async () => {},
    };

    expect(
      await hasDeclaredAnimation({ execution: "interactive" } as Tier1Input, session, 41),
    ).toBe(true);
    expect(calls).toBe(0);
  });

  test("bounds whole-artifact capture dimensions without clipping a fitting artifact", () => {
    expect(boundCaptureSize({ width: 3000, height: 700 })).toEqual({
      width: 3000,
      height: 700,
      scale: 1,
    });

    const bounded = boundCaptureSize({ width: 9000, height: 9000 });
    expect(bounded.width).toBeLessThanOrEqual(TIER1_SCREENSHOT_MAX_AXIS_PX);
    expect(bounded.height).toBeLessThanOrEqual(TIER1_SCREENSHOT_MAX_AXIS_PX);
    expect(bounded.width * bounded.height).toBeLessThanOrEqual(TIER1_SCREENSHOT_MAX_PIXELS);
  });

  test("records an unavailable screenshot when a whole capture exceeds the cap", async () => {
    const oversized = "A".repeat(Math.ceil((TIER1_SCREENSHOT_CAP_BYTES * 4) / 3) + 5);
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = {
      send: async <T = unknown>(method: string, params?: Record<string, unknown>) => {
        calls.push(params === undefined ? { method } : { method, params });
        return { data: oversized } as T;
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
    let result: Awaited<ReturnType<typeof captureBoundedScreenshot>>;
    try {
      result = await captureBoundedScreenshot(session);
    } finally {
      bufferSpy.from = decode;
    }

    expect(result).toBeNull();
    expect(decodedOversizedPayload).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params?.captureBeyondViewport).toBe(true);
    expect(calls[0]?.params).toMatchObject({ format: "webp", quality: 82 });
  });

  test("scales the full artifact clip when the axis cap binds", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const session = {
      send: async <T = unknown>(method: string, params?: Record<string, unknown>) => {
        calls.push(params === undefined ? { method } : { method, params });
        return { data: Buffer.from("scaled capture").toString("base64") } as T;
      },
      on: () => {},
      off: () => {},
      detach: async () => {},
    };

    await captureBoundedScreenshot(session, {
      bounds: { width: 4096, height: 227, scale: 4096 / 9000 },
      source: { width: 9000, height: 500 },
    });

    expect(calls[0]?.params).toMatchObject({
      clip: { x: 0, y: 0, width: 9000, height: 500, scale: 4096 / 9000 },
      format: "webp",
      quality: 82,
      captureBeyondViewport: true,
    });
  });

  test("uses the static whole-artifact clip for animated PNG frames", () => {
    const bounded = {
      bounds: { width: 4096, height: 227, scale: 4096 / 9000 },
      source: { width: 9000, height: 500 },
    };

    const staticCapture = captureBoundedScreenshotParams("webp", bounded);
    const animatedFrame = captureBoundedScreenshotParams("png", bounded);

    expect(animatedFrame.clip).toEqual(staticCapture.clip);
    expect(animatedFrame).toMatchObject({ format: "png", captureBeyondViewport: true });
    expect(staticCapture).toMatchObject({ format: "webp", quality: 82 });
  });

  test("uses one static capture when the artifact does not declare animation", async () => {
    let captureCalls = 0;
    const session = {
      send: async <T = unknown>() => ({}) as T,
      on: () => {},
      off: () => {},
      detach: async () => {},
    };

    const result = await captureEvidenceScreenshot(session, {
      animated: false,
      bounds: {
        bounds: { width: 3000, height: 700, scale: 1 },
        source: { width: 3000, height: 700 },
      },
      captureStatic: async () => {
        captureCalls += 1;
        return { bytes: Buffer.from("static screenshot"), format: "webp" };
      },
    });

    expect(captureCalls).toBe(1);
    expect(result.screenshot?.format).toBe("webp");
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
        return { bytes: Buffer.from("recovered screenshot"), format: "webp" };
      },
    });

    expect(attempts).toBe(2);
    expect(result.screenshot).toEqual({
      bytes: Buffer.from("recovered screenshot"),
      format: "webp",
    });
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
      capture: async () => new Promise<never>(() => {}),
    });

    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(result.screenshot).toBeNull();
    expect(result.screenshotError).toMatchObject({ code: "screenshot_unavailable" });
  });

  test("refuses a tiled screenshot promptly when its CDP capture never resolves", async () => {
    let tileAttempts = 0;
    const session = {
      send: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
        if (method === "Page.captureScreenshot") {
          tileAttempts += 1;
          return new Promise<T>(() => {});
        }
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression);
          if (expression.includes("container.scrollWidth"))
            return { result: { value: { width: 2, height: 2 } } } as T;
          if (expression.includes("element.clientWidth"))
            return { result: { value: { width: 2, height: 2 } } } as T;
          if (expression.includes("#host-root iframe"))
            return { result: { value: { x: 0, y: 0, width: 2, height: 2 } } } as T;
          if (expression.includes("element.scrollLeft="))
            return { result: { value: { left: 0, top: 0 } } } as T;
        }
        return {} as T;
      },
      on: () => {},
      off: () => {},
      detach: async () => {},
    };
    const result = await Promise.race([
      captureTiledEvidenceScreenshot(session, 41, { tileTimeoutMs: 25, tileAttempts: 2 }),
      Bun.sleep(1_000).then(() => {
        throw new Error("unbounded tiled screenshot capture");
      }),
    ]);

    expect(tileAttempts).toBe(1);
    expect(result.screenshot).toBeNull();
    expect(result.screenshotError).toMatchObject({
      code: "screenshot_unavailable",
      message: expect.stringContaining("tiled screenshot capture"),
    });
  });

  test("uses integer tile clip and extract dimensions for fractional client boxes", async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#aabbee" },
    })
      .png()
      .toBuffer();
    const clips: { width: number; height: number }[] = [];
    let scrollResets = 0;
    const session = {
      send: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
        if (method === "Page.captureScreenshot") {
          const clip = params?.clip as { width: number; height: number };
          clips.push(clip);
          if (!Number.isInteger(clip.width) || !Number.isInteger(clip.height))
            throw new Error("fractional CDP clip");
          return { data: png.toString("base64") } as T;
        }
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression);
          if (
            expression.startsWith(
              "(function(){var element=document.getElementById('artifact');element.scrollLeft=0;",
            )
          )
            scrollResets += 1;
          if (expression.includes("container.scrollWidth"))
            return { result: { value: { width: 2, height: 2 } } } as T;
          if (expression.includes("element.clientWidth"))
            return { result: { value: { width: 2.9, height: 2.8 } } } as T;
          if (expression.includes("#host-root iframe"))
            return { result: { value: { x: 0, y: 0, width: 3.9, height: 3.8 } } } as T;
          if (expression.includes("element.scrollLeft="))
            return { result: { value: { left: 0, top: 0 } } } as T;
        }
        return {} as T;
      },
      on: () => {},
      off: () => {},
      detach: async () => {},
    };

    const result = await captureTiledEvidenceScreenshot(session, 41);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ width: 2, height: 2 });
    expect(scrollResets).toBe(1);
    expect(result.screenshotError).toBeNull();
    expect(await sharp(result.screenshot!.bytes).metadata()).toMatchObject({
      width: 2,
      height: 2,
      format: "webp",
    });
  });

  test("refuses slow successful tiles once the tiled-capture deadline expires", async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#22b97a" },
    })
      .png()
      .toBuffer();
    let capturedTiles = 0;
    const session = {
      send: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
        if (method === "Page.captureScreenshot") {
          capturedTiles += 1;
          await Bun.sleep(30);
          return { data: png.toString("base64") } as T;
        }
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression);
          if (expression.includes("container.scrollWidth"))
            return { result: { value: { width: 2, height: 16 } } } as T;
          if (expression.includes("element.clientWidth"))
            return { result: { value: { width: 2, height: 2 } } } as T;
          if (expression.includes("#host-root iframe"))
            return { result: { value: { x: 0, y: 0, width: 2, height: 2 } } } as T;
          if (expression.includes("element.style.scrollBehavior")) {
            const top = Number(expression.match(/element\.scrollTop=(\d+)/)?.[1]);
            return { result: { value: { left: 0, top } } } as T;
          }
        }
        return {} as T;
      },
      on: () => {},
      off: () => {},
      detach: async () => {},
    };
    const started = performance.now();
    const result = await captureTiledEvidenceScreenshot(session, 41, {
      tileTimeoutMs: 100,
      tileAttempts: 1,
      tiledDeadlineMs: 100,
    });

    expect(performance.now() - started).toBeLessThan(500);
    expect(capturedTiles).toBeLessThan(8);
    expect(result.screenshot).toBeNull();
    expect(result.screenshotError).toMatchObject({
      code: "screenshot_unavailable",
      message: expect.stringContaining("tiled-capture deadline"),
    });
  });
});
