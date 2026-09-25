import { expect, test } from "bun:test";
import { publishFixture, readBackFixture } from "../helpers/facet-testkit";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseViewBox } from "../../src/gallery-web/frame/frame-payload";

const base = {
  mark: "bar",
  data: {
    values: [
      { category: "A", value: 2 },
      { category: "B", value: 5 },
    ],
  },
  encoding: {
    x: { field: "category", type: "nominal" },
    y: { field: "value", type: "quantitative" },
  },
};

test("dimensionless charts get a readable Tier 1 viewBox while authored width stays fixed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "facet-chart-size-"));
  try {
    const cases = [
      { name: "default", spec: base, minWidth: 600, maxWidth: 800 },
      { name: "explicit", spec: { ...base, width: 300 }, minWidth: 0, maxWidth: 400 },
      {
        name: "hconcat",
        spec: {
          hconcat: [base, base],
        },
        minWidth: 1200,
        maxWidth: 1600,
      },
    ];
    for (const item of cases) {
      const fixturePath = join(directory, `${item.name}.vl.json`);
      writeFileSync(fixturePath, JSON.stringify(item.spec));
      const published = await publishFixture({
        fixturePath,
        artifactType: "chart",
        slug: `chart-default-size-${item.name}`,
        screenshotMode: "deterministic",
      });
      const verdict = await readBackFixture({
        artifactId: published.artifactId,
        revisionSha: published.revisionSha,
        tier: 1,
      });
      expect(
        verdict.observed.viewBoxes?.some((viewBox) => {
          const width = parseViewBox(viewBox)?.width;
          return (
            width !== undefined && Number(width) >= item.minWidth && Number(width) <= item.maxWidth
          );
        }),
      ).toBe(true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
