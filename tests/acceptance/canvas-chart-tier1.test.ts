import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { publishFixture, readBackFixture } from "../helpers/facet-testkit";

const FIXTURE_PATH = `${import.meta.dir}/../fixtures/chart-barline.vl.json`;

test("canvas chart records an opaque-content Tier 1 verdict with screenshot evidence", async () => {
  const published = await publishFixture({
    fixturePath: FIXTURE_PATH,
    artifactType: "chart",
    renderer: "canvas",
    slug: "canvas-chart-tier1",
    screenshotMode: "deterministic",
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });
  expect(verdict.status).toBe("partial:opaque_content");
  expect(verdict.observed.opaqueRegionCount).toBeGreaterThanOrEqual(1);
  expect(verdict.renderer).toBe("canvas");
  expect(published.tier1ScreenshotPath).not.toBeNull();
}, 90_000);

test("standalone Mermaid evidence centers the diagram in the Tier 1 frame", async () => {
  const directory = mkdtempSync(join(tmpdir(), "facet-tier1-mermaid-layout-"));
  const fixturePath = join(directory, "diagram.mmd");
  writeFileSync(fixturePath, "flowchart LR\n  A[Start] --> B[Done]\n");
  try {
    const published = await publishFixture({
      fixturePath,
      artifactType: "mermaid",
      slug: "tier1-mermaid-centered",
      productionTier0: true,
    });
    expect(published.tier1Status).toBe("ok");
    expect(published.tier1ScreenshotPath).not.toBeNull();
    const { data, info } = await sharp(readFileSync(published.tier1ScreenshotPath!))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBeGreaterThanOrEqual(1280);
    const background = [...data.subarray(0, 3)];
    let firstDiagramColumn = info.width;
    for (let x = 0; x < info.width; x += 1) {
      let changed = 0;
      for (let y = 32; y < Math.min(info.height, 768); y += 2) {
        const pixel = (y * info.width + x) * info.channels;
        if (
          Math.abs(data[pixel]! - background[0]!) > 45 ||
          Math.abs(data[pixel + 1]! - background[1]!) > 45 ||
          Math.abs(data[pixel + 2]! - background[2]!) > 45
        )
          changed += 1;
      }
      if (changed > 3) {
        firstDiagramColumn = x;
        break;
      }
    }
    expect(firstDiagramColumn).toBeGreaterThan(100);
    expect(firstDiagramColumn).toBeLessThan(600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
