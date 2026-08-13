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

function portabilityRoot(name: string): string {
  const root = join(mkdtempSync(join(tmpdir(), `facet-tsx-portability-${name}-`)), "nested", name);
  mkdirSync(root, { recursive: true });
  symlinkSync(NODE_MODULES, join(root, "node_modules"), "dir");
  return root;
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

  test("normalizes interactive bundle bytes across checkout-like roots without host paths", async () => {
    const shallowRoot = portabilityRoot("shallow");
    const deepRoot = join(portabilityRoot("deep"), "one", "more", "checkout");
    mkdirSync(deepRoot, { recursive: true });
    symlinkSync(NODE_MODULES, join(deepRoot, "node_modules"), "dir");
    try {
      const shallow = await compileTsxAtWorkRootForTests(
        { source: INTERACTIVE_SOURCE, execution: "interactive" },
        shallowRoot,
      );
      const deep = await compileTsxAtWorkRootForTests(
        { source: INTERACTIVE_SOURCE, execution: "interactive" },
        deepRoot,
      );

      expect(shallow.sha256).toBe(deep.sha256);
      expect(shallow.bytes.byteLength).toBe(deep.bytes.byteLength);
      expect(new TextDecoder().decode(shallow.bytes)).not.toContain("/home/");
      expect(new TextDecoder().decode(deep.bytes)).not.toContain("/home/");
    } finally {
      rmSync(shallowRoot, { recursive: true, force: true });
      rmSync(resolve(deepRoot, "../../.."), { recursive: true, force: true });
    }
  });
});
