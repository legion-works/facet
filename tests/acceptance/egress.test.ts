import { expect, test } from "bun:test";

import { runEgressPenetration } from "../helpers/facet-testkit";

test("production Tier-1 launcher leaks nothing across HTTP, WebSocket, EventSource, beacon, image, script, anchor ping, and STUN UDP", async () => {
  const result = await runEgressPenetration({ launcher: "production" });
  expect(result.sinkHits).toHaveLength(0);
  expect(result.udpPackets).toBe(0);
});
