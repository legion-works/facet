import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  closeAndRemoveEphemeralProfile,
  createEphemeralProfileDir,
} from "../../src/validation/tier1/browser-process";

describe("Tier 1 browser process cleanup", () => {
  test("removes the profile when browser teardown never settles", async () => {
    const profile = createEphemeralProfileDir();
    mkdirSync(join(profile, "Default"));

    await closeAndRemoveEphemeralProfile(() => new Promise<void>(() => undefined), profile, 5);

    expect(existsSync(profile)).toBe(false);
  });
});
