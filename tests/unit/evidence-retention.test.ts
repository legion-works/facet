import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  enforceEvidenceRetention,
  ensureRunEvidenceDirectory,
} from "../../src/service/store/evidence-retention";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("evidence retention", () => {
  test("creates deterministic owner-only run paths", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-evidence-"));
    roots.push(root);
    const paths = ensureRunEvidenceDirectory({
      evidenceRoot: root,
      artifactId: "artifact-1",
      revisionSha: "sha-1",
      runId: "run-1",
    });
    expect(paths.directory).toBe(join(root, "artifact-1", "sha-1", "run-1"));
    expect(paths.screenshotPath).toEndWith("/screenshot.png");
    expect(paths.consolePath).toEndWith("/console.txt");
  });

  test("evicts oldest non-retained rows and removes their evidence files", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-evidence-"));
    roots.push(root);
    const oldDir = join(root, "artifact", "sha", "old");
    mkdirSync(oldDir, { recursive: true });
    const screenshot = join(oldDir, "screenshot.png");
    const consolePath = join(oldDir, "console.txt");
    const compiledPath = join(oldDir, "compiled.html");
    writeFileSync(screenshot, "pixels");
    writeFileSync(consolePath, "logs");
    writeFileSync(compiledPath, "<p>derived</p>");
    const deleted: string[] = [];
    const db = {
      query(sql: string) {
        if (sql.startsWith("SELECT")) {
          return {
            all: () => [
              {
                id: "new",
                screenshot_path: null,
                console_path: null,
                compiled_path: null,
                retained: 0,
              },
              {
                id: "old",
                screenshot_path: screenshot,
                console_path: consolePath,
                compiled_path: compiledPath,
                retained: 0,
              },
            ],
          };
        }
        return { run: (id: string) => deleted.push(id) };
      },
    };
    enforceEvidenceRetention({
      db: db as never,
      artifactId: "artifact",
      evidenceRoot: root,
      limit: 1,
    });
    expect(deleted).toEqual(["old"]);
    expect(existsSync(screenshot)).toBe(false);
    expect(existsSync(consolePath)).toBe(false);
    expect(existsSync(compiledPath)).toBe(false);
  });

  test("does not evict retained rows or runs within the limit", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-evidence-"));
    roots.push(root);
    const deleted: string[] = [];
    const db = {
      query(sql: string) {
        if (sql.startsWith("SELECT")) {
          return {
            all: () => [{ id: "retained", screenshot_path: null, console_path: null, retained: 1 }],
          };
        }
        return { run: (id: string) => deleted.push(id) };
      },
    };
    enforceEvidenceRetention({
      db: db as never,
      artifactId: "artifact",
      evidenceRoot: root,
      limit: 10,
    });
    expect(deleted).toEqual([]);
  });

  test("wraps database failures as store errors", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-evidence-"));
    roots.push(root);
    const db = {
      query: () => {
        throw new Error("db unavailable");
      },
    };
    expect(() =>
      enforceEvidenceRetention({ db: db as never, artifactId: "artifact", evidenceRoot: root }),
    ).toThrow();
  });
});
