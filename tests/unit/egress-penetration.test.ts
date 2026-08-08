import { describe, expect, test } from "bun:test";

import { buildArtifact, EGRESS_CHANNELS } from "../../scripts/egress-penetration";

describe("egress penetration artifact", () => {
  test("contains every closed egress attempt in the generated browser artifact", () => {
    const html = buildArtifact("192.0.2.10", 4321);
    expect(html).toContain("http://192.0.2.10:4321");
    expect(html).toContain("ws://192.0.2.10:4321");
    for (const channel of EGRESS_CHANNELS) expect(html).toContain(`'${channel}'`);
    expect(html).toContain("document.title = attempted.join(',')");
  });
});
