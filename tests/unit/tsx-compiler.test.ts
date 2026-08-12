import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compileTsx } from "../../src/validation/tier0/tsx/compiler";

const STATIC_SOURCE = readFileSync(
  resolve(import.meta.dir, "../fixtures/tsx/static-source.tsx"),
  "utf8",
);

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
});
