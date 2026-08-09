import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  FORMAT_EXTENSIONS,
  FORMATTER_EXECUTABLE,
  runFormatCheck,
  selectFormatPaths,
} from "../../scripts/check-format";

describe("format surface", () => {
  test("includes every oxfmt-supported extension used by the repo", () => {
    for (const extension of [".css", ".html", ".json", ".md", ".toml", ".ts", ".yml"])
      expect(FORMAT_EXTENSIONS.has(extension)).toBe(true);
    for (const extension of [".lock", ".mmd", ".sh", ".svg"])
      expect(FORMAT_EXTENSIONS.has(extension)).toBe(false);
  });

  test("filters unsupported, deleted, and duplicate paths", () => {
    expect(
      selectFormatPaths(
        ["src/app.ts", "src/app.ts", "src/app.css", "diagram.svg", "deleted.html"],
        (path) => path !== "deleted.html",
      ),
    ).toEqual(["src/app.ts", "src/app.css"]);
  });

  test("skips generated files the release tool owns, but not hand-written markdown", () => {
    expect(selectFormatPaths(["CHANGELOG.md", "docs/roadmap.md", "README.md"], () => true)).toEqual(
      ["docs/roadmap.md", "README.md"],
    );
  });

  test("uses tracked files in CI and explicit staged files in the hook", () => {
    const calls: string[][] = [];
    const deps = {
      trackedPaths: () => ["src/app.ts", "src/app.css", "script.sh"],
      pathExists: () => true,
      invoke: (paths: readonly string[]) => {
        calls.push([...paths]);
        return 0;
      },
    };

    expect(runFormatCheck([], deps)).toBe(0);
    expect(runFormatCheck(["--", "src/index.html", "README.md"], deps)).toBe(0);
    expect(calls).toEqual([
      ["src/app.ts", "src/app.css"],
      ["src/index.html", "README.md"],
    ]);
  });

  test("does not invoke oxfmt when no supported path remains", () => {
    expect(
      runFormatCheck(["script.sh"], {
        trackedPaths: () => [],
        pathExists: () => true,
        invoke: () => {
          throw new Error("must not run");
        },
      }),
    ).toBe(0);
  });

  test("invokes the project formatter without relying on a global PATH", () => {
    expect(FORMATTER_EXECUTABLE).toBe(resolve("node_modules/.bin/oxfmt"));
    const path = process.env["PATH"];
    process.env["PATH"] = "/nonexistent";
    try {
      expect(runFormatCheck(["src/gallery-web/index.html"])).toBe(0);
    } finally {
      process.env["PATH"] = path;
    }
  });
});
