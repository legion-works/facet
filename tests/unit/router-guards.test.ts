import { expect, test } from "bun:test";

import { RAW_BODY_CAP_BYTES, readCappedBody } from "../../src/service/router-guards";

test("raw body cap accepts exactly-cap malformed UTF-8 bytes without re-encoding inflation", async () => {
  const bytes = new Uint8Array(RAW_BODY_CAP_BYTES);
  bytes.fill(0x61);
  bytes[bytes.length - 1] = 0xc3;

  await expect(
    readCappedBody(new Request("http://facet.invalid", { method: "POST", body: bytes }), null),
  ).resolves.toBeString();
});
