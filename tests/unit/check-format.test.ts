import { describe, expect, test } from "bun:test";

import { FORMAT_EXTENSIONS, runFormatCheck, selectFormatPaths } from "../../scripts/check-format";

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

  test("invokes the installed formatter for an explicit repo file", () => {
    expect(runFormatCheck(["src/gallery-web/index.html"])).toBe(0);
  });
});
