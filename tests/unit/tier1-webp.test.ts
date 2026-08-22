import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import sharp from "sharp";

import { runBoundaryCheck } from "../../scripts/check-boundaries";
import { encodeAnimatedWebp, encodeAnimatedWebpWithinCap } from "../../src/validation/tier1/webp";

async function pngFrame(center: [number, number, number, number]): Promise<Buffer> {
  const pixels = Buffer.alloc(4 * 4 * 4, 0);
  const offset = (2 * 4 + 2) * 4;
  pixels.set(center, offset);
  return sharp(pixels, { raw: { width: 4, height: 4, channels: 4 } })
    .png()
    .toBuffer();
}

async function noiseFrame(seed: number): Promise<Buffer> {
  const pixels = Buffer.alloc(256 * 256 * 4);
  let state = seed;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    pixels[offset] = state & 0xff;
    pixels[offset + 1] = (state >>> 8) & 0xff;
    pixels[offset + 2] = (state >>> 16) & 0xff;
    pixels[offset + 3] = 255;
  }
  return sharp(pixels, { raw: { width: 256, height: 256, channels: 4 } })
    .png()
    .toBuffer();
}

describe("Tier 1 animated WebP encoding", () => {
  test("encodes equally sized PNG frames as an infinitely looping animated WebP", async () => {
    const encoded = await encodeAnimatedWebp(
      await Promise.all([
        pngFrame([255, 0, 0, 255]),
        pngFrame([0, 255, 0, 255]),
        pngFrame([0, 0, 255, 255]),
      ]),
      { delayMs: 150, quality: 82 },
    );

    const metadata = await sharp(encoded, { animated: true }).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.pages).toBe(3);
    expect(metadata.pageHeight).toBe(4);
    expect(metadata.loop).toBe(0);
  });

  test("reduces WebP quality when the first animated encoding exceeds the evidence cap", async () => {
    const frames = await Promise.all([noiseFrame(1), noiseFrame(2), noiseFrame(3), noiseFrame(4)]);
    const at82 = await encodeAnimatedWebp(frames, {
      delayMs: 150,
      quality: 82,
    });
    const at70 = await encodeAnimatedWebp(frames, {
      delayMs: 150,
      quality: 70,
    });
    const capBytes = at82.byteLength - 1;

    expect(at70.byteLength).toBeLessThanOrEqual(capBytes);
    const encoded = await encodeAnimatedWebpWithinCap(frames, {
      delayMs: 150,
      qualities: [82, 70],
      capBytes,
    });

    expect(encoded?.byteLength).toBeLessThanOrEqual(capBytes);
    expect(encoded?.equals(at82)).toBe(false);
  });

  test("rejects a mismatched frame before assembling an animated WebP", async () => {
    const smaller = await pngFrame([255, 0, 0, 255]);
    const pixels = Buffer.alloc(5 * 4 * 4, 255);
    const wider = await sharp(pixels, { raw: { width: 5, height: 4, channels: 4 } })
      .png()
      .toBuffer();

    await expect(
      encodeAnimatedWebp([smaller, wider], { delayMs: 150, quality: 82 }),
    ).rejects.toThrow("animated WebP frames do not share dimensions");
  });

  test("keeps Sharp outside the byte-dumb service boundary", () => {
    const repoRoot = resolve(import.meta.dir, "../..");
    const violations = runBoundaryCheck({
      repoRoot,
      serviceDir: resolve(repoRoot, "src/service"),
      frameDir: resolve(repoRoot, "src/gallery-web/frame"),
    });

    expect(violations.filter((violation) => violation.specifier === "sharp")).toEqual([]);
  });
});
