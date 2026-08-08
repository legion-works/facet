/**
 * Unit tests for `ensureOwnerOnlyDirectory` (src/shared/util/dir-permissions.ts).
 *
 * The helper has THREE distinct semantics for three different segment
 * classes. A regression on any of them breaks either security (leaf
 * not 0o700) or shared-tree surprise (pre-existing ancestor chmod'd).
 *
 *   1. Leaf (security target): ALWAYS 0o700. Created at 0o700 if
 *      missing; chmod'd to 0o700 if pre-existing at a wrong mode.
 *
 *   2. Intermediate ancestors the helper CREATES (didn't exist
 *      before this call): 0o700 (chmod after mkdir to beat the
 *      process umask).
 *
 *   3. Pre-existing intermediate ancestors (existed before this
 *      call): UNTOUCHED. The helper must NEVER chmod a directory
 *      it did not create — silently re-moding a shared tree
 *      (e.g. ~/.local/state) would surprise every other app /
 *      backup sharing it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureOwnerOnlyDirectory, OWNER_ONLY_MODE } from "../../src/shared/util/dir-permissions";

let scratchRoot: string;

beforeEach(() => {
  scratchRoot = join(tmpdir(), `facet-dir-perms-${crypto.randomUUID()}`);
  mkdirSync(scratchRoot, { recursive: true });
});

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe("ensureOwnerOnlyDirectory — pre-existing ancestor is NOT re-moded", () => {
  test("a permissive pre-existing parent stays 0o755; created intermediate + leaf land 0o700", () => {
    const root = join(scratchRoot, "pre-existing-parent");
    mkdirSync(root, { mode: 0o755 });
    expect(statSync(root).mode & 0o777).toBe(0o755);

    ensureOwnerOnlyDirectory(join(root, "child", "leaf"));

    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, "child")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "child", "leaf")).mode & 0o777).toBe(0o700);
  });

  test("nested tree with one pre-existing intermediate in the middle", () => {
    const root = join(scratchRoot, "pre-existing-middle");
    mkdirSync(root, { mode: 0o755 });
    mkdirSync(join(root, "preexisting-middle"), { mode: 0o755 });
    expect(statSync(join(root, "preexisting-middle")).mode & 0o777).toBe(0o755);

    ensureOwnerOnlyDirectory(join(root, "preexisting-middle", "new-leaf"));

    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, "preexisting-middle")).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, "preexisting-middle", "new-leaf")).mode & 0o777).toBe(0o700);
  });

  test("pre-existing leaf at a permissive mode is tightened to 0o700 (leaf is the security target)", () => {
    const target = join(scratchRoot, "pre-existing-leaf");
    mkdirSync(target, { mode: 0o755 });
    expect(statSync(target).mode & 0o777).toBe(0o755);

    ensureOwnerOnlyDirectory(target);
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  test("the entire chain when nothing pre-exists lands at 0o700", () => {
    const target = join(scratchRoot, "fresh", "deep", "leaf");
    ensureOwnerOnlyDirectory(target);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(statSync(join(scratchRoot, "fresh")).mode & 0o777).toBe(0o700);
    expect(statSync(join(scratchRoot, "fresh", "deep")).mode & 0o777).toBe(0o700);
  });

  test("under an overlapping umask, a fresh nested tree still lands every segment at 0o700", () => {
    const target = join(scratchRoot, "umask-fresh", "deep", "leaf");
    const previousUmask = process.umask(0o177);
    try {
      ensureOwnerOnlyDirectory(target);
      expect(existsSync(target)).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o700);
      expect(statSync(join(scratchRoot, "umask-fresh")).mode & 0o777).toBe(0o700);
      expect(statSync(join(scratchRoot, "umask-fresh", "deep")).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
    }
  });

  test("under an overlapping umask, a permissive pre-existing parent is left untouched", () => {
    const root = join(scratchRoot, "umask-pre-existing-parent");
    mkdirSync(root, { mode: 0o755 });
    const previousUmask = process.umask(0o177);
    try {
      ensureOwnerOnlyDirectory(join(root, "child", "leaf"));
      expect(statSync(root).mode & 0o777).toBe(0o755);
      expect(statSync(join(root, "child")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "child", "leaf")).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
    }
  });
});

describe("ensureOwnerOnlyDirectory — return value", () => {
  test("returns the input path so callers can chain", () => {
    const target = join(scratchRoot, "return");
    expect(ensureOwnerOnlyDirectory(target)).toBe(target);
  });
});

describe("OWNER_ONLY_MODE", () => {
  test("is 0o700 — the canonical secret-bearing layout", () => {
    expect(OWNER_ONLY_MODE).toBe(0o700);
  });
});
