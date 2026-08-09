import { describe, expect, test } from "bun:test";

import { formatJunitSummary, parseJunit } from "../../scripts/summarize-junit";

describe("CI JUnit summary", () => {
  test("reports counts and the failing test names developers need", () => {
    const xml = `<?xml version="1.0"?>
<testsuites tests="3" failures="1" skipped="1">
  <testsuite name="tests/unit/example.test.ts">
    <testcase name="passes" classname="example" />
    <testcase name="shows the break" classname="example" file="tests/unit/example.test.ts" line="12">
      <failure message="expected 1, received 2">stack</failure>
    </testcase>
    <testcase name="skips" classname="example"><skipped /></testcase>
  </testsuite>
</testsuites>`;

    expect(parseJunit(xml)).toEqual({
      tests: 3,
      passed: 1,
      failures: 1,
      skipped: 1,
      failingTests: ["example › shows the break (tests/unit/example.test.ts:12)"],
    });
  });

  test("formats a failing job summary with the exact failed test", () => {
    expect(
      formatJunitSummary("unit", {
        tests: 2,
        passed: 1,
        failures: 1,
        skipped: 0,
        failingTests: ["example › breaks (tests/unit/example.test.ts:12)"],
      }),
    ).toBe(
      "## unit tests\n\n✗ 1 passed · 0 skipped · 1 failed\n\nFailures:\n- example › breaks (tests/unit/example.test.ts:12)\n",
    );
  });
});
