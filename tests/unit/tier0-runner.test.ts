import { describe, expect, test } from "bun:test";

import * as tier0Runner from "../../src/validation/tier0/runner";

describe("Tier 0 insecure isolation selection", () => {
  test.each([0, 1] as const)("level %d selects the netns worker path", (level) => {
    expect(tier0Runner.resolveTier0Isolation(level)).toBe("netns");
  });

  test.each([2, 3] as const)("level %d selects the direct worker path", (level) => {
    expect(tier0Runner.resolveTier0Isolation(level)).toBe("direct");
  });

  test("the exported runner remains the secure level-0 implementation", () => {
    expect(tier0Runner.resolveTier0Isolation(0)).toBe("netns");
    expect(tier0Runner.createTier0Runner(0)).toBeDefined();
    expect(tier0Runner.runTier0).toBeDefined();
  });

  test("rejects a type-bypassed insecure level instead of failing open", () => {
    expect(() => tier0Runner.resolveTier0Isolation(99 as never)).toThrow();
  });
});
