import { expect, test } from "bun:test";

import { runEgressPenetration } from "../helpers/facet-testkit";

// The 10 externally-observed channels the production Tier-1 launcher must
// attempt during a penetration run. Order-independent on the assertion side
// via Set equality, so any empty/subset/extra harness now fails the gate.
const CHANNELS: readonly string[] = [
  "fetch-raw-ip",
  "fetch-hostname",
  "xhr",
  "websocket",
  "image-src",
  "script-src",
  "beacon",
  "eventsource",
  "anchor-ping",
  "stun-udp",
];

test("production Tier-1 launcher attempts every external channel and leaks nothing", async () => {
  const result = await runEgressPenetration({ launcher: "production" });
  expect(new Set(result.attemptedChannels)).toEqual(new Set(CHANNELS));
  expect(result.sinkHits).toHaveLength(0);
  expect(result.udpPackets).toBe(0);
  // 30s budget: the harness waits out the artifact's settle window and
  // launches a real netns'd browser, so the 5s default is too tight.
}, 30_000);
