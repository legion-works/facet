/**
 * DIAGNOSTIC — not a product gate.
 *
 * Minimal reproducer for the CI-only response-delivery stall: a full browser
 * launch + teardown at module level, before any service exists in the process.
 * Run paired with `gate-forgery.test.ts` (this file sorts first) to reproduce
 * the hang in two files. Opt-in so it never runs in the normal suite.
 *
 * Enable with FACET_REPRO_LIFECYCLE=1.
 */
import { expect, test } from "bun:test";

import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";

const enabled = process.env.FACET_REPRO_LIFECYCLE === "1";

if (enabled) {
  const browser = new PuppeteerTier1Browser();
  const availability = await browser.probeAvailability();
  // eslint-disable-next-line no-console
  console.error(`repro: probeAvailability available=${availability.available}`);
}

test.skipIf(!enabled)("browser lifecycle ran at module level", () => {
  expect(enabled).toBe(true);
});
