import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "bun:test";
import sharp from "sharp";

import { publishFixture } from "../helpers/facet-testkit";

const FIXTURE_PATH = `${import.meta.dir}/../fixtures/svg-animated-wide-evidence.svg`;

function includesColor(
  pixels: Buffer,
  channels: number,
  red: number,
  green: number,
  blue: number,
): boolean {
  for (let offset = 0; offset < pixels.length; offset += channels) {
    if (
      Math.abs(pixels[offset]! - red) <= 12 &&
      Math.abs(pixels[offset + 1]! - green) <= 12 &&
      Math.abs(pixels[offset + 2]! - blue) <= 12
    )
      return true;
  }
  return false;
}

test("Tier 1 stores bounded whole-artifact WebP evidence without clipping either edge", async () => {
  const published = await publishFixture({
    fixturePath: FIXTURE_PATH,
    artifactType: "svg",
    execution: "static",
    slug: "tier1-whole-artifact-webp",
    productionTier0: true,
  });
  expect(published.tier1Status).toBe("ok");
  expect(published.tier1ScreenshotPath).not.toBeNull();
  const screenshotPath = published.tier1ScreenshotPath!;
  expect(existsSync(screenshotPath)).toBe(true);

  const image = sharp(readFileSync(screenshotPath), { animated: true });
  const metadata = await image.metadata();
  const decoded = await image.raw().toBuffer({ resolveWithObject: true });
  const frameLength = decoded.info.width * (metadata.pageHeight ?? 0) * decoded.info.channels;
  const red = includesColor(decoded.data, decoded.info.channels, 255, 0, 0);
  const blue = includesColor(decoded.data, decoded.info.channels, 0, 0, 255);
  expect(metadata.format).toBe("webp");
  expect(metadata.width).toBeGreaterThan(1280);
  expect(metadata.width).toBeLessThanOrEqual(4096);
  expect(metadata.height).toBeLessThanOrEqual(4096);
  expect(metadata.pages).toBeGreaterThan(1);
  expect(metadata.pageHeight).toBeGreaterThan(0);
  expect(
    decoded.data
      .subarray(0, frameLength)
      .equals(decoded.data.subarray(frameLength, frameLength * 2)),
  ).toBe(false);
  expect(decoded.info.width * decoded.info.height).toBeLessThanOrEqual(8_388_608);
  expect(red).toBe(true);
  expect(blue).toBe(true);
}, 90_000);
