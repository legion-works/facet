import { expect, test } from "bun:test";
import { publishFixture, readBackFixture } from "../helpers/facet-testkit";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      { name: "default", spec: base, minWidth: 600, maxWidth: Number.POSITIVE_INFINITY },
      { name: "explicit", spec: { ...base, width: 300 }, minWidth: 0, maxWidth: 400 },
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
          const width = /^\s*\S+\s+\S+\s+(\S+)/.exec(viewBox)?.[1];
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
