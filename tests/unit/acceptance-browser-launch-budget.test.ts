import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const acceptanceDirectory = join(import.meta.dir, "../acceptance");
const browserConstructionPattern = /\bnew\s+PuppeteerTier1Browser\s*\(/g;
const browserLaunchPattern = /\b\w+\.launch\s*\(/g;
const browserAvailabilityProbePattern = /\b\w+\.probeAvailability\s*\(/g;

test("acceptance modules use at most one direct CDP-pipe launch", () => {
  const overBudget = readdirSync(acceptanceDirectory)
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((entry) => {
      const source = readFileSync(join(acceptanceDirectory, entry), "utf8");
      return {
        entry,
        constructions: source.match(browserConstructionPattern)?.length ?? 0,
        launches: source.match(browserLaunchPattern)?.length ?? 0,
        availabilityProbes: source.match(browserAvailabilityProbePattern)?.length ?? 0,
      };
    })
    .filter(({ constructions, launches, availabilityProbes }) => {
      return constructions > 1 || launches + availabilityProbes > 1;
    });

  expect(overBudget).toEqual([]);
});
