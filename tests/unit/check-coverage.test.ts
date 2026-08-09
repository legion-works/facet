import { describe, expect, test } from "bun:test";

import { checkCoverage, mergeLcov } from "../../scripts/check-coverage";

function lcov(
  path: string,
  lines: readonly (0 | 1)[],
  functionsHit: number,
  functionsFound: number,
): string {
  const entries = lines.map((hit, index) => `DA:${index + 1},${hit}`).join("\n");
  const linesHit = lines.filter((hit) => hit > 0).length;
  return `TN:\nSF:${path}\nFNF:${functionsFound}\nFNH:${functionsHit}\n${entries}\nLF:${lines.length}\nLH:${linesHit}\nend_of_record\n`;
}

describe("LCOV coverage gate", () => {
  test("uses the strongest tier without treating isolated runs as additive", () => {
    const unit = lcov("src/example.ts", [1, 0], 1, 2);
    const integration = lcov("src/example.ts", [0, 1], 2, 2);

    expect(mergeLcov([unit, integration])).toEqual({
      aggregate: { lines: 50, functions: 100 },
      files: [{ path: "src/example.ts", lines: 50, functions: 100 }],
    });
  });

  test("rejects and names files below the per-file floor", () => {
    expect(() => checkCoverage([lcov("src/under-covered.ts", [1, 0], 1, 2)], {}, () => {})).toThrow(
      "src/under-covered.ts · lines 50.00% < 70.00% · functions 50.00% < 65.00%",
    );
  });

  test("keeps the aggregate 90 percent lines and functions gate", () => {
    const covered = lcov(
      "src/covered.ts",
      Array.from({ length: 89 }, () => 1),
      9,
      10,
    );
    const missed = lcov(
      "src/missed.ts",
      Array.from({ length: 11 }, () => 0),
      1,
      1,
    );

    expect(() =>
      checkCoverage([covered, missed], { perFile: { lines: 0, functions: 0 } }, () => {}),
    ).toThrow("aggregate coverage · lines 89.00% · functions 90.91% · required 90.00%");
  });
});
