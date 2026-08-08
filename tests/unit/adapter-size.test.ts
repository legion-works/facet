import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  adapterPaths,
  checkAdapterSource,
  main,
  verifyAdapters,
} from "../../scripts/verify-adapter-size";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "facet-adapter-check-"));
  roots.push(root);
  const path = join(root, "facet.sh");
  writeFileSync(path, body, "utf8");
  return path;
}

describe("adapter size and boundary checker", () => {
  test("accepts a short shell adapter that only invokes the CLI", () => {
    const path = fixture('#!/bin/sh\nexec bun src/cli/main.ts "$@"\n');
    expect(checkAdapterSource(path)).toEqual([]);
  });

  test("rejects adapters over 50 physical lines", () => {
    const path = fixture(["#!/bin/sh", ...Array.from({ length: 50 }, () => "true")].join("\n"));
    expect(checkAdapterSource(path).some((issue) => issue.includes("50 lines"))).toBe(true);
  });

  test("rejects token and HTTP references", () => {
    const path = fixture("#!/bin/sh\ncurl -H 'Authorization: Bearer token' http://127.0.0.1/x\n");
    const issues = checkAdapterSource(path).join("\n");
    expect(issues).toContain("forbidden");
    expect(issues).toContain("token");
  });

  test("rejects database and renderer references", () => {
    const path = fixture("#!/bin/sh\nsqlite renderer validation zod DB_PATH FACET_HOME\n");
    const issues = checkAdapterSource(path).join("\n");
    expect(issues).toContain("database or runtime path handling");
    expect(issues).toContain("renderer or validation logic");
  });

  test("reports a missing adapter root", () => {
    const missing = join(tmpdir(), `facet-missing-adapters-${crypto.randomUUID()}`);
    expect(verifyAdapters(missing)).toEqual([`${missing}: adapter root does not exist`]);
  });

  test("reports each missing adapter beneath an existing root", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-adapter-root-"));
    roots.push(root);
    mkdirSync(join(root, "opencode"), { recursive: true });
    expect(verifyAdapters(root)).toEqual(
      adapterPaths(root).map((path) => `${path}: adapter does not exist`),
    );
  });

  test("runs the production adapter gate entrypoint", () => {
    expect(() => main()).not.toThrow();
  });
});
