import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { compileTsx, compileTsxAtWorkRootForTests } from "../../src/validation/tier0/tsx/compiler";

const STATIC_SOURCE = readFileSync(
  resolve(import.meta.dir, "../fixtures/tsx/static-source.tsx"),
  "utf8",
);
const INTERACTIVE_SOURCE = readFileSync(
  resolve(import.meta.dir, "../fixtures/tsx/interactive-source.tsx"),
  "utf8",
);
const NODE_MODULES = resolve(import.meta.dir, "../../node_modules");

function portabilityRoot(name: string): { readonly root: string; readonly temporaryRoot: string } {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `facet-tsx-portability-${name}-`));
  const root = join(temporaryRoot, "nested", name);
  mkdirSync(root, { recursive: true });
  symlinkSync(NODE_MODULES, join(root, "node_modules"), "dir");
  return { root, temporaryRoot };
}

describe("TSX compiler", () => {
  test("compiles static source to derived HTML", async () => {
    const result = await compileTsx({ source: STATIC_SOURCE, execution: "static" });

    expect(result.mediaType).toBe("text/html");
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.html).toContain("<p");
    expect(result.sha256).toBe(createHash("sha256").update(result.bytes).digest("hex"));
  });

  test("rejects denied AST capabilities before writing compiled output", async () => {
    await expect(
      compileTsx({
        source: `export default function App(){ fetch("https://example.invalid"); return null; }`,
        execution: "interactive",
      }),
    ).rejects.toMatchObject({
      code: "tsx_ast_denied",
      details: {
        errorsJson: expect.stringContaining("tsx_capability_fetch"),
      },
    });
  });

  test("interactive compilation does not produce an SSR expectation", async () => {
    const result = await compileTsx({
      source: `export default function App(){ return <button>ok</button>; }`,
      execution: "interactive",
    });

    expect(result.mediaType).toBe("text/javascript");
    expect(result.html).toBeUndefined();
  });

  test("emits a readable, production-sized React runtime for interactive artifacts", async () => {
    const result = await compileTsx({
      source: `export default function App(){ return <button>ok</button>; }`,
      execution: "interactive",
    });
    const bundle = new TextDecoder().decode(result.bytes);

    expect(result.bytes.byteLength).toBeGreaterThan(10_000);
    expect(result.bytes.byteLength).toBeLessThan(600_000);
    expect(bundle).toContain("interactive TSX mount is missing");
    expect(bundle).not.toContain('A props object containing a "key" prop is being spread into JSX');
    expect(bundle).toContain("\nfunction App() {\n  return");
  });

  test("concurrent static compiles keep each artifact's own rendered content", async () => {
    const labels = ["artifact-alpha", "artifact-bravo", "artifact-charlie"] as const;
    const results = await Promise.all(
      labels.map((label) =>
        compileTsx({
          source: `import React from "react";
export default function Artifact(){ return <h1>${label}</h1>; }`,
          execution: "static",
        }),
      ),
    );

    for (const [index, result] of results.entries()) {
      expect(result.html, labels[index]).toBe(`<h1>${labels[index]}</h1>`);
    }
  });

  test("normalizes interactive bundle bytes across checkout-like roots without host paths", async () => {
    const shallow = portabilityRoot("shallow");
    const deep = portabilityRoot("deep");
    const deepRoot = join(deep.root, "one", "more", "checkout");
    mkdirSync(deepRoot, { recursive: true });
    symlinkSync(NODE_MODULES, join(deepRoot, "node_modules"), "dir");
    try {
      const shallowResult = await compileTsxAtWorkRootForTests(
        { source: INTERACTIVE_SOURCE, execution: "interactive" },
        shallow.root,
      );
      const deepResult = await compileTsxAtWorkRootForTests(
        { source: INTERACTIVE_SOURCE, execution: "interactive" },
        deepRoot,
      );

      expect(shallowResult.sha256).toBe(deepResult.sha256);
      expect(shallowResult.bytes.byteLength).toBe(deepResult.bytes.byteLength);
      expect(new TextDecoder().decode(shallowResult.bytes)).not.toContain("/home/");
      expect(new TextDecoder().decode(deepResult.bytes)).not.toContain("/home/");
    } finally {
      rmSync(shallow.temporaryRoot, { recursive: true, force: true });
      rmSync(deep.temporaryRoot, { recursive: true, force: true });
    }
  });
});
