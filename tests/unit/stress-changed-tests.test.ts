import { describe, expect, test } from "bun:test";

import {
  isStressableTestFile,
  changedPathsSince,
  main,
  selectChangedTests,
  STRESS_COUNT,
  STRESS_ROOTS,
  stressOne,
} from "../../scripts/stress-changed-tests";

describe("changed-test stress selection", () => {
  test("selects unit and integration test files", () => {
    const { selected } = selectChangedTests([
      "tests/unit/leases.test.ts",
      "tests/integration/api.test.ts",
    ]);
    expect(selected).toEqual(["tests/integration/api.test.ts", "tests/unit/leases.test.ts"]);
  });

  test("EXCLUDES acceptance tests — their flakiness is a runtime property, not a diff property", () => {
    // Browser tests fail from launch (oven-sh/bun#37230), so stressing them
    // measures Bun rather than the change under review.
    const { selected } = selectChangedTests([
      "tests/acceptance/egress.test.ts",
      "tests/acceptance/gate-forgery.test.ts",
    ]);
    expect(selected).toEqual([]);
    expect(isStressableTestFile("tests/acceptance/egress.test.ts")).toBe(false);
  });

  test("ignores non-test sources and helper files", () => {
    const { selected } = selectChangedTests([
      "src/service/router.ts",
      "tests/helpers/facet-testkit.ts",
      "tests/unit/_helpers/command-fixtures.ts",
      "docs/roadmap.md",
    ]);
    expect(selected).toEqual([]);
  });

  test("deduplicates and sorts so the run order is deterministic", () => {
    const { selected } = selectChangedTests([
      "tests/unit/b.test.ts",
      "tests/unit/a.test.ts",
      "tests/unit/b.test.ts",
    ]);
    expect(selected).toEqual(["tests/unit/a.test.ts", "tests/unit/b.test.ts"]);
  });

  test("reports the total changed count so an empty diff is distinguishable from no test changes", () => {
    // The two cases must not collapse: "no test files changed" is a legitimate
    // pass, "the diff is empty" means the base ref is wrong and must fail.
    expect(selectChangedTests([]).totalChanged).toBe(0);
    expect(selectChangedTests(["src/service/router.ts"]).totalChanged).toBe(1);
  });

  test("stress count and roots are pinned to the documented contract", () => {
    expect(STRESS_COUNT).toBe(5);
    expect([...STRESS_ROOTS]).toEqual(["tests/unit/", "tests/integration/"]);
  });

  test("main uses supplied diff and stress fixtures instead of live repository state", () => {
    const stressed: string[] = [];
    const runtime = {
      changedPathsSince: () => ["tests/unit/fixture.test.ts"],
      exists: () => true,
      stressOne: (file: string) => {
        stressed.push(file);
        return true;
      },
    };

    expect(main(["bun", "stress-changed-tests.ts", "fixture-base"], runtime)).toBe(0);
    expect(stressed).toEqual(["tests/unit/fixture.test.ts"]);
  });

  test("main reports an unusable diff without reading live repository state", () => {
    expect(
      main(["bun", "stress-changed-tests.ts", "fixture-base"], {
        changedPathsSince: () => {
          throw new Error("fixture diff failed");
        },
      }),
    ).toBe(1);
  });

  test("main rejects an empty diff", () => {
    expect(
      main(["bun", "stress-changed-tests.ts", "fixture-base"], {
        changedPathsSince: () => [],
      }),
    ).toBe(1);
  });

  test("main skips a diff without stressable tests", () => {
    expect(
      main(["bun", "stress-changed-tests.ts", "fixture-base"], {
        changedPathsSince: () => ["src/service/router.ts"],
      }),
    ).toBe(0);
  });

  test("main skips deleted stressable tests", () => {
    expect(
      main(["bun", "stress-changed-tests.ts", "fixture-base"], {
        changedPathsSince: () => ["tests/unit/deleted.test.ts"],
        exists: () => false,
      }),
    ).toBe(0);
  });

  test("main reports failed stress runs", () => {
    expect(
      main(["bun", "stress-changed-tests.ts", "fixture-base"], {
        changedPathsSince: () => ["tests/unit/fixture.test.ts"],
        exists: () => true,
        stressOne: () => false,
      }),
    ).toBe(1);
  });

  test("stressOne survives a stable test file and HEAD diff is fixture-independent", () => {
    expect(changedPathsSince("HEAD")).toEqual([]);
    expect(stressOne("tests/unit/check-format.test.ts")).toBe(true);
  });
});
