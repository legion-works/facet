import { describe, expect, test } from "bun:test";

import {
  TIER1_CDP_CALL_WATCHDOG_MS,
  TIER1_RENDER_BARRIER_MS,
  TIER1_TIMEOUT_MS,
} from "../../src/validation/tier1/limits";

describe("Tier 1 budget ordering", () => {
  test("each outer budget leaves room to observe the inner typed result", () => {
    const acceptanceTestBudgetMs = 90_000;

    expect(TIER1_CDP_CALL_WATCHDOG_MS).toBeLessThan(TIER1_RENDER_BARRIER_MS);
    expect(TIER1_RENDER_BARRIER_MS).toBeLessThan(TIER1_TIMEOUT_MS);
    expect(TIER1_TIMEOUT_MS).toBeLessThan(acceptanceTestBudgetMs);
  });
});
