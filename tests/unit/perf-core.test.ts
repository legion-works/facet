import { describe, expect, test } from "bun:test";

import {
  assessLimit,
  diffLeakSnapshot,
  nearestRankPercentile,
  parseProcStatCpuTicks,
  summarize,
} from "../../scripts/perf/core";
import { PERF_BUDGETS, enforcementForPolicy } from "../../scripts/perf/budgets";

describe("performance gate statistics", () => {
  test("nearest-rank p95 over 40 samples selects the 38th ordered value", () => {
    expect(
      nearestRankPercentile(
        Array.from({ length: 40 }, (_, index) => index + 1),
        0.95,
      ),
    ).toBe(38);
  });

  test("summary reports min, median, and max without mutating samples", () => {
    const samples = [9, 1, 5, 3, 7];
    expect(summarize(samples)).toEqual({ min: 1, median: 5, max: 9 });
    expect(samples).toEqual([9, 1, 5, 3, 7]);
  });
});

describe("performance gate mutation checks", () => {
  test.each([
    ["absolute RSS", 80.01, PERF_BUDGETS.rssAbsolute],
    ["RSS delta", 30.01, PERF_BUDGETS.rssDelta],
    ["idle CPU", 0.5, PERF_BUDGETS.idleCpu],
    ["publish commit", 200.01, PERF_BUDGETS.publishCommitted],
    ["SSE delivery", 25.01, PERF_BUDGETS.sseDelivery],
    ["publish visible", 300, PERF_BUDGETS.publishVisible],
    ["cold read-back", 1_500, PERF_BUDGETS.coldReadBack],
    ["browser exit", 100.01, PERF_BUDGETS.browserExit],
  ] as const)("%s turns red when the guarded budget is broken", (_name, observed, budget) => {
    expect(assessLimit(observed, budget.limit, budget.mode)).toBe("fail");
  });

  test("CI enforces browser-free budgets and records browser-dependent budgets", () => {
    expect(enforcementForPolicy("always", "ci")).toBe(true);
    expect(enforcementForPolicy("stable", "ci")).toBe(false);
    expect(enforcementForPolicy("record-only", "ci")).toBe(false);
  });

  test("cleanup turns red for every leaked resource class", () => {
    const baseline = { pids: new Set([10]), profiles: new Set(["/tmp/facet-tier1-existing"]) };
    const leaked = {
      pids: new Set([10, 11]),
      profiles: new Set(["/tmp/facet-tier1-existing", "/tmp/facet-tier1-leaked"]),
    };
    expect(diffLeakSnapshot(baseline, leaked)).toEqual({
      pids: [11],
      profiles: ["/tmp/facet-tier1-leaked"],
    });
  });
});

test("CPU parser survives spaces and parentheses in the process name", () => {
  const fields = ["S", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
  fields[11] = "17";
  fields[12] = "19";
  expect(parseProcStatCpuTicks(`42 (facet worker (tier0)) ${fields.join(" ")}`)).toBe(36);
});
