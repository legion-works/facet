import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { publishFixture } from "../helpers/facet-testkit";

async function retainedPixels(
  fixturePath: string,
  artifactType: "html" | "tsx",
  slug: string,
): Promise<{ readonly data: Buffer; readonly width: number; readonly channels: number }> {
  const published = await publishFixture({
    fixturePath,
    artifactType,
    slug,
    ...(artifactType === "tsx" ? { execution: "static" as const } : {}),
    productionTier0: true,
  });
  expect(published.tier1Status, JSON.stringify(published).slice(0, 4000)).toBe("ok");
  expect(published.tier1ScreenshotPath).not.toBeNull();
  const decoded = await sharp(readFileSync(published.tier1ScreenshotPath!))
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: decoded.data, width: decoded.info.width, channels: decoded.info.channels };
}

function hasRedBackground(pixels: {
  readonly data: Buffer;
  readonly width: number;
  readonly channels: number;
}): boolean {
  for (let y = 20; y < 40; y += 1) {
    for (let x = Math.floor(pixels.width / 4); x < Math.floor((pixels.width * 3) / 4); x += 1) {
      const offset = (y * pixels.width + x) * pixels.channels;
      if (
        pixels.data[offset]! > 220 &&
        pixels.data[offset + 1]! < 80 &&
        pixels.data[offset + 2]! < 80
      ) {
        return true;
      }
    }
  }
  return false;
}

test("Tier 1 retained evidence includes artifact styling for TSX and HTML", async () => {
  const directory = mkdtempSync(join(tmpdir(), "facet-tier1-style-"));
  const tsxPath = join(directory, "styled.tsx");
  const htmlPath = join(directory, "styled.html");
  // Only classes in artifact.css apply; an empty element without a height utility collapses.
  writeFileSync(
    tsxPath,
    'export default function Artifact() { return <div className="bg-red-500 p-4">styled</div>; }',
  );
  writeFileSync(htmlPath, '<div class="bg-red-500 p-4">styled</div>');

  try {
    const tsx = await retainedPixels(tsxPath, "tsx", "tier1-tsx-style-parity");
    const html = await retainedPixels(htmlPath, "html", "tier1-html-style-control");
    expect(hasRedBackground(html), "HTML control retains the styled background").toBe(true);
    expect(hasRedBackground(tsx), "TSX evidence retains the styled background").toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
