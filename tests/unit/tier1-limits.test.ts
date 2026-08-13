import { describe, expect, test } from "bun:test";

import { FACET_CLIENT_COMMAND_TIMEOUT_MS } from "../../src/cli/client";
import { ACCEPTANCE_TEST_BUDGET_MS } from "../../src/shared/config/limits";
import {
  TIER1_CDP_CALL_WATCHDOG_MS,
  TIER1_RENDER_BARRIER_MS,
  TIER1_TIMEOUT_MS,
  TSX_STABILITY_WINDOW_MS,
} from "../../src/validation/tier1/limits";

describe("Tier 1 budget ordering", () => {
  test("each outer budget leaves room to observe the inner typed result", () => {
    expect(TIER1_CDP_CALL_WATCHDOG_MS).toBeLessThan(TIER1_RENDER_BARRIER_MS);
    expect(TIER1_RENDER_BARRIER_MS).toBeLessThan(TIER1_TIMEOUT_MS);
    expect(TSX_STABILITY_WINDOW_MS).toBeLessThan(TIER1_TIMEOUT_MS - TIER1_RENDER_BARRIER_MS);
    expect(TIER1_TIMEOUT_MS).toBeLessThan(FACET_CLIENT_COMMAND_TIMEOUT_MS);
    expect(FACET_CLIENT_COMMAND_TIMEOUT_MS).toBeLessThan(ACCEPTANCE_TEST_BUDGET_MS);
  });
});
