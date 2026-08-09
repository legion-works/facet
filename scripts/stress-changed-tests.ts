#!/usr/bin/env bun
//
// Stress-run the test files this diff MODIFIED, to catch a flaky test as it is
// introduced — the one flake you can still cheaply prevent.
//
// Scope is deliberately MODIFIED-ONLY, not affected-set. Change a helper that
// 200 tests depend on without touching a test file and this selects nothing and
// passes. That is the design, not a compromise: the affected-set is unbounded
// (touch a shared type and it is the whole suite × N), and the normal test jobs
// already answer "did I break a test" deterministically on every run. Stress
// can only answer a different question — "is the test I just wrote flaky" — and
// that question is exactly scoped to the diff.
//
// tests/acceptance/** is EXCLUDED. Those drive a real browser, and browser
// flakiness here is dominated by launch (oven-sh/bun#37230 on the pinned
// runtime), which is a property of the runtime rather than of the change.
// Stressing them on the push path would measure Bun, not the diff.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const STRESS_COUNT = 5;

/** Test roots eligible for stress. Acceptance is excluded by construction. */
export const STRESS_ROOTS = ["tests/unit/", "tests/integration/"] as const;

export function isStressableTestFile(path: string): boolean {
  if (!path.endsWith(".test.ts")) return false;
  return STRESS_ROOTS.some((root) => path.startsWith(root));
}

/**
 * Split a `git diff --name-only` listing into the files worth stressing and the
 * total seen. The total is kept so the caller can distinguish "the diff changed
 * no test files" (a legitimate pass) from "the diff appears empty" (a broken
 * base ref, which must fail loudly rather than silently selecting nothing).
 */
export function selectChangedTests(changedPaths: readonly string[]): {
  readonly selected: string[];
  readonly totalChanged: number;
} {
  const selected = [...new Set(changedPaths.filter(isStressableTestFile))].toSorted();
  return { selected, totalChanged: changedPaths.length };
}

function changedPathsSince(baseRef: string): string[] {
  const result = spawnSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git diff against ${baseRef} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

function stressOne(file: string): boolean {
  for (let run = 1; run <= STRESS_COUNT; run += 1) {
    const result = spawnSync(process.execPath, ["test", file], { stdio: "inherit" });
    if (result.status !== 0) {
      console.error(`FAIL ${file} failed on stress run ${run}/${STRESS_COUNT}`);
      return false;
    }
  }
  console.log(`PASS ${file} survived ${STRESS_COUNT} runs`);
  return true;
}

export function main(argv: readonly string[]): number {
  const baseRef = argv[2] ?? process.env["FACET_STRESS_BASE"] ?? "origin/main";
  let changed: string[];
  try {
    changed = changedPathsSince(baseRef);
  } catch (error) {
    console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const { selected, totalChanged } = selectChangedTests(changed);
  if (totalChanged === 0) {
    // A push that changes nothing means the base ref is wrong, not that the
    // work is clean. Selecting nothing silently is the invisible failure.
    console.error(`ERROR diff against ${baseRef} is empty — base ref is probably wrong`);
    return 1;
  }
  if (selected.length === 0) {
    console.log(`SKIP no stressable test files changed (${totalChanged} file(s) in diff)`);
    return 0;
  }

  // A selected file that vanished is a pure deletion; nothing to stress.
  const present = selected.filter((file) => existsSync(file));
  if (present.length === 0) {
    console.log(`SKIP every changed test file was deleted (${selected.length} deletion(s))`);
    return 0;
  }

  console.log(`stressing ${present.length} changed test file(s) × ${STRESS_COUNT}`);
  const failures = present.filter((file) => !stressOne(file));
  if (failures.length > 0) {
    console.error(`ERROR ${failures.length} changed test file(s) are flaky under stress`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv));
