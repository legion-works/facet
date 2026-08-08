import { describe, expect, test } from "bun:test";

import { checkCoverage, summarizeLcov } from "../../scripts/check-coverage";

const lcov = (lineHit: number, lineFound: number, fnHit: number, fnFound: number) =>
  `TN:\nSF:src/example.ts\nFNF:${fnFound}\nFNH:${fnHit}\nLF:${lineFound}\nLH:${lineHit}\nend_of_record\n`;

describe("aggregate LCOV coverage gate", () => {
  test("summarizes and accepts coverage at or above the threshold", () => {
    expect(summarizeLcov(lcov(95, 100, 9, 10))).toEqual({ lines: 95, functions: 90 });
    expect(() => checkCoverage(lcov(95, 100, 9, 10))).not.toThrow();
  });

  test("rejects coverage below the threshold", () => {
    expect(() => checkCoverage(lcov(89, 100, 10, 10))).toThrow(
      "aggregate coverage is below the configured threshold",
    );
  });
});
