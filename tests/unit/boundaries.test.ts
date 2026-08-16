import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { main, runBoundaryCheck, type BoundaryRoots } from "../../scripts/check-boundaries";

const tempRoots: string[] = [];

function makeRoot(): BoundaryRoots {
  const dir = mkdtempSync(join(tmpdir(), "facet-boundary-"));
  tempRoots.push(dir);
  const serviceDir = join(dir, "src", "service");
  const frameDir = join(dir, "src", "gallery-web", "frame");
  // walk() does not require the dirs to pre-exist, but creating them
  // makes the on-disk layout match the real repo so workspace-path
  // probes resolve the same way.
  mkdirSync(serviceDir, { recursive: true });
  mkdirSync(frameDir, { recursive: true });
  return { repoRoot: dir, serviceDir, frameDir };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeServiceFile(root: BoundaryRoots, name: string, body: string): string {
  const path = join(root.serviceDir, name);
  writeFileSync(path, body);
  return path;
}

function writeFrameFile(root: BoundaryRoots, name: string, body: string): string {
  const path = join(root.frameDir ?? "", name);
  writeFileSync(path, body);
  return path;
}

describe("boundary check — forbidden package import forms", () => {
  test('catches `import x from "mermaid"` (default import)', () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", `import x from "mermaid";`);
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.specifier).toBe("mermaid");
    expect(v[0]?.reason).toContain("forbidden package import");
  });

  test('catches `import { render } from "mermaid"` (named import)', () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", `import { render } from "mermaid";`);
    const v = runBoundaryCheck(root);
    expect(v.map((x) => x.specifier)).toEqual(["mermaid"]);
  });

  test('catches `import * as m from "mermaid"` (namespace import)', () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", `import * as m from "mermaid";`);
    const v = runBoundaryCheck(root);
    expect(v.map((x) => x.specifier)).toEqual(["mermaid"]);
  });

  test('catches `import "mermaid"` (bare side-effect import)', () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", `import "mermaid";`);
    const v = runBoundaryCheck(root);
    expect(v.map((x) => x.specifier)).toEqual(["mermaid"]);
  });

  test('catches `import("mermaid")` (dynamic import)', () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", `const m = await import("mermaid");`);
    const v = runBoundaryCheck(root);
    expect(v.map((x) => x.specifier)).toEqual(["mermaid"]);
  });

  test('catches `require("mermaid")` (CJS require)', () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", `const m = require("mermaid");`);
    const v = runBoundaryCheck(root);
    expect(v.map((x) => x.specifier)).toEqual(["mermaid"]);
  });

  test('catches `import { parse } from "parse5"` in the byte-dumb service', () => {
    const root = makeRoot();
    writeServiceFile(root, "parse-html.ts", `import { parse } from "parse5";`);
    const violations = runBoundaryCheck(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe("parse5");
    expect(violations[0]?.reason).toContain("forbidden package import");
  });

  test('catches `export * from "mermaid"` (reviewer mutation probe)', () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", `export * from "mermaid";`);
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.specifier).toBe("mermaid");
    expect(v[0]?.reason).toContain("forbidden package import");
  });

  test('catches `export { x } from "mermaid"` (named re-export)', () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", `export { render } from "mermaid";`);
    const v = runBoundaryCheck(root);
    expect(v.map((x) => x.specifier)).toEqual(["mermaid"]);
  });

  test('catches `export type { x } from "mermaid"` (type-only re-export)', () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", `export type { RenderResult } from "mermaid";`);
    const v = runBoundaryCheck(root);
    expect(v.map((x) => x.specifier)).toEqual(["mermaid"]);
  });

  test('catches `export * as ns from "mermaid"` (namespace re-export)', () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", `export * as m from "mermaid";`);
    const v = runBoundaryCheck(root);
    expect(v.map((x) => x.specifier)).toEqual(["mermaid"]);
  });

  test("catches every forbidden package in the closed set", () => {
    const root = makeRoot();
    const pkgs = [
      "marked",
      "mermaid",
      "puppeteer-core",
      "puppeteer",
      "jsdom",
      "happy-dom",
      "linkedom",
      "parse5",
      "vega",
      "vega-lite",
    ];
    pkgs.forEach((pkg, index) => {
      writeServiceFile(root, `p${index}.ts`, `import x from "${pkg}";`);
    });
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(pkgs.length);
    const flagged = v.map((x) => x.specifier).toSorted();
    expect(flagged).toEqual([...pkgs].toSorted());
  });

  test("catches subpath imports (e.g. `marked/lib/...`)", () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", `import x from "marked/lib/lexer";`);
    const v = runBoundaryCheck(root);
    expect(v.map((x) => x.specifier)).toEqual(["marked/lib/lexer"]);
  });
});

describe("boundary check — template literal dynamic imports", () => {
  // A template-literal dynamic import previously evaded the quote-only
  // regex: `import(`mermaid`)` matched neither the quoted-string pattern
  // nor anything else, so it scanned clean.
  test("catches `import(`mermaid`)` (no-substitution template literal)", () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", "const m = await import(`mermaid`);");
    const v = runBoundaryCheck(root);
    expect(v.map((x) => x.specifier)).toEqual(["mermaid"]);
    expect(v[0]?.reason).toContain("forbidden package import");
  });

  test("catches `require(`mermaid`)` (no-substitution template literal)", () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", "const m = require(`mermaid`);");
    const v = runBoundaryCheck(root);
    expect(v.map((x) => x.specifier)).toEqual(["mermaid"]);
  });

  test("fails closed on a template literal with a substitution — unclassifiable specifier", () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", "const pkg = 'mermaid'; const m = await import(`${pkg}`);");
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toContain("unclassifiable dynamic specifier");
  });

  test("a backtick literal inside a comment stays clean", () => {
    const root = makeRoot();
    writeServiceFile(
      root,
      "a.ts",
      '// const m = await import(`mermaid`);\nimport { Database } from "bun:sqlite";\n',
    );
    expect(runBoundaryCheck(root)).toHaveLength(0);
  });
});

describe("boundary check — multiline dynamic imports (whole-file scan, not per-line)", () => {
  // A per-line scanner never sees the opening
  // `import(`/`require(` and its literal argument on the same scanned
  // unit when legal formatting splits them across lines.
  test("catches a multiline backtick dynamic import", () => {
    const root = makeRoot();
    writeServiceFile(
      root,
      "a.ts",
      "const x = await import(\n  `fast-xml-parser`\n);\nexport default x;\n",
    );
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.specifier).toBe("fast-xml-parser");
    expect(v[0]?.reason).toContain("not on the service allowlist");
  });

  test("catches a multiline quoted dynamic import", () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", 'const x = await import(\n  "mermaid"\n);\nexport default x;\n');
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.specifier).toBe("mermaid");
    expect(v[0]?.reason).toContain("forbidden package import");
  });

  test("a multiline dynamic import inside a block comment stays clean", () => {
    const root = makeRoot();
    writeServiceFile(
      root,
      "a.ts",
      '/**\n * const x = await import(\n *   `fast-xml-parser`\n * );\n */\nimport { Database } from "bun:sqlite";\n',
    );
    expect(runBoundaryCheck(root)).toHaveLength(0);
  });

  test("a static import split across lines (`from` on its own line) is still caught", () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", 'import { render }\n  from\n  "mermaid";\n');
    const v = runBoundaryCheck(root);
    expect(v.map((x) => x.specifier)).toEqual(["mermaid"]);
  });

  test("import(someVar) with a non-literal argument fails closed as unclassifiable", () => {
    const root = makeRoot();
    writeServiceFile(root, "a.ts", "const path = getPath();\nconst m = await import(path);\n");
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.specifier).toBe("path");
    expect(v[0]?.reason).toContain("unclassifiable dynamic specifier");
  });

  test("the documented runner-path injection allowance clears the exact (main.ts, dynamicPath) call site", () => {
    const root = makeRoot();
    writeServiceFile(
      root,
      "main.ts",
      "const dynamicPath = path;\nconst mod = await import(dynamicPath);\n",
    );
    expect(runBoundaryCheck(root)).toHaveLength(0);
  });

  test("the documented runner-path injection allowance is scoped to (file, identifier), not a blanket pass", () => {
    const root = makeRoot();
    // Same identifier name, wrong file: still fails closed.
    writeServiceFile(
      root,
      "not-main.ts",
      "const dynamicPath = getPath();\nawait import(dynamicPath);\n",
    );
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toContain("unclassifiable dynamic specifier");
  });
});

describe("boundary check — workspace path probes", () => {
  test("catches a relative import that resolves under src/validation/", () => {
    const root = makeRoot();
    // Create src/validation/peer.ts so the relative path resolves.
    const validationDir = join(root.repoRoot, "src", "validation");
    mkdirSync(validationDir, { recursive: true });
    writeFileSync(join(validationDir, "peer.ts"), "export const x = 1;");
    writeServiceFile(root, "a.ts", `import { x } from "../validation/peer";`);
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toContain("forbidden workspace import");
    expect(v[0]?.reason).toContain("src/validation/");
  });

  test("catches a relative import that resolves under src/gallery-web/frame/", () => {
    const root = makeRoot();
    const frameDir = join(root.repoRoot, "src", "gallery-web", "frame");
    mkdirSync(frameDir, { recursive: true });
    writeFileSync(join(frameDir, "peer.ts"), "export const x = 1;");
    writeServiceFile(root, "a.ts", `import { x } from "../gallery-web/frame/peer";`);
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toContain("forbidden workspace import");
    expect(v[0]?.reason).toContain("src/gallery-web/frame/");
  });
});

describe("boundary check — gallery frame zod guard", () => {
  test('catches `import "zod"` in src/gallery-web/frame/', () => {
    const root = makeRoot();
    writeFrameFile(root, "a.ts", `import { z } from "zod";`);
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toContain("zod must not cross the gallery-frame boundary");
  });

  test('catches `import z from "zod"` and `import * as z from "zod"`', () => {
    const root = makeRoot();
    writeFrameFile(root, "a.ts", `import z from "zod";`);
    writeFrameFile(root, "b.ts", `import * as z from "zod";`);
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(2);
  });
});

describe("boundary check — allowlist fails closed on unlisted packages", () => {
  // The guard used to be a DENYLIST, which could only reject packages someone
  // had remembered to list. Proven against the real repo before this changed:
  // `src/service/` importing `fast-xml-parser` — an XML parser, inside the
  // component defined by not parsing — reported "service boundary clean".
  // These tests pin the inverted direction: unknown external = rejected.
  test("an unlisted parser package is rejected even though no denylist names it", () => {
    const root = makeRoot();
    writeServiceFile(root, "p.ts", `import { XMLParser } from "fast-xml-parser";\n`);
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toContain("not on the service allowlist");
  });

  test("a scoped package outside the allowlist is rejected", () => {
    const root = makeRoot();
    writeServiceFile(root, "p.ts", `import x from "@scope/renderer";\n`);
    expect(runBoundaryCheck(root)).toHaveLength(1);
  });

  test("a subpath of an allowed package stays allowed", () => {
    const root = makeRoot();
    writeServiceFile(root, "p.ts", `import { z } from "zod/v4";\n`);
    expect(runBoundaryCheck(root)).toHaveLength(0);
  });

  test("prose in comments is not scanned as an import specifier", () => {
    // A doc comment reading `distinguishes "no host" from "wrong host"` matched
    // the re-export regex and produced a false positive the moment the check
    // began failing closed. A guard that cries wolf gets overridden.
    const root = makeRoot();
    writeServiceFile(
      root,
      "c.ts",
      `/**\n * Distinguishes "no host" from "wrong host" \u2014 both fail closed.\n */\n` +
        `// see the note above, copied from "some-package"\n` +
        `import { Database } from "bun:sqlite";\n`,
    );
    expect(runBoundaryCheck(root)).toHaveLength(0);
  });
});

describe("boundary check — clean surface", () => {
  test("the repository entrypoint reports a clean boundary", () => {
    expect(main()).toBe(0);
  });

  test("a service file with only safe relative imports produces zero violations", () => {
    const root = makeRoot();
    writeServiceFile(
      root,
      "store.ts",
      `import { openDatabase } from "./database";\nimport type { Project } from "./schema";\n`,
    );
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(0);
  });

  test("a service file with allowed zod and bun: imports produces zero violations", () => {
    const root = makeRoot();
    writeServiceFile(
      root,
      "a.ts",
      `import { Database } from "bun:sqlite";\nimport { z } from "zod";\nimport path from "node:path";\n`,
    );
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(0);
  });

  test("missing frame dir is skipped gracefully (no violations reported)", () => {
    const root: BoundaryRoots = {
      repoRoot: mkdtempSync(join(tmpdir(), "facet-noframe-")),
      serviceDir: mkdtempSync(join(tmpdir(), "facet-noframe-svc-")),
    };
    tempRoots.push(root.repoRoot, root.serviceDir);
    writeServiceFile(
      { repoRoot: root.repoRoot, serviceDir: root.serviceDir } as BoundaryRoots,
      "a.ts",
      `import { z } from "zod";`,
    );
    const v = runBoundaryCheck(root);
    expect(v).toHaveLength(0);
  });
});
