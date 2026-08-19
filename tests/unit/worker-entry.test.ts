import { expect, test } from "bun:test";

import { TIER0_INPUT_CAP_BYTES } from "../../src/validation/sandbox/limits";
import { splitWorkerInputLines } from "../../src/validation/tier0/worker-entry";

test("accepts complete batched worker lines above the aggregate cap", () => {
  const line = "x".repeat(Math.floor(TIER0_INPUT_CAP_BYTES / 2) + 1);
  const parsed = splitWorkerInputLines(`${line}\n${line}\n`);

  expect(parsed.lines).toEqual([line, line]);
  expect(parsed.remainder).toBe("");
});

test("rejects one unterminated worker line above the cap", () => {
  expect(() => splitWorkerInputLines("x".repeat(TIER0_INPUT_CAP_BYTES + 1))).toThrow(
    "request line exceeds byte cap",
  );
});
