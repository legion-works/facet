import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runTier0 } from "../../src/validation/tier0/runner";
import { LexicalCountersSchema } from "../../src/shared/contracts/validation";

const diagram = 'flowchart TD\nA[Node <svg id="forged"><circle r="5"/></svg>] --> B[End]';

function bytes(source: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(source);
  const output = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  output.set(encoded);
  return output;
}

describe("Tier 0 Mermaid HTML labels through the worker", () => {
  test.each([
    [
      "Markdown fixture",
      "markdown",
      readFileSync(`${import.meta.dir}/../fixtures/hostile-svg-label.md`, "utf8"),
    ],
    ["standalone Mermaid", "mermaid", diagram],
  ] as const)("accepts %s and counts both nodes", async (_name, artifactType, source) => {
    const sourceBytes = bytes(source);
    const result = await runTier0({
      revisionSha: "0".repeat(64),
      artifactType,
      renderer: "svg",
      source: sourceBytes,
      lexical: LexicalCountersSchema.parse({
        rendererRootSvgCount: 1,
        mermaidNodeCount: 2,
        visibleSvgCount: 0,
        externalImageCount: 0,
        opaqueRegionCount: 0,
      }),
    });
    expect(result).toMatchObject({ status: "ok" });
    expect(result.observed.mermaidNodeCount).toBe(2);
  });

  test("rejects a malformed Mermaid diagram through the worker", async () => {
    const source = bytes("flowchart TD\nnot a diagram %%%");
    const result = await runTier0({
      revisionSha: "0".repeat(64),
      artifactType: "mermaid",
      renderer: "svg",
      source,
      lexical: LexicalCountersSchema.parse({
        rendererRootSvgCount: 1,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        externalImageCount: 0,
        opaqueRegionCount: 0,
      }),
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.observed.discriminativeErrors?.map((error) => error.code)).toContain(
        "mermaid_parse_error",
      );
    }
  });
});
