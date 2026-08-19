import { describe, expect, test } from "bun:test";

import type { ArtifactType } from "../../src/shared/contracts/artifact-types";
import type { WorkerInput } from "../../src/validation/tier0/worker-input";
import { runParser } from "../../src/validation/tier0/worker-dispatch";

const revisionSha = "b".repeat(64);

function input(artifactType: ArtifactType, source: string, execution?: "static" | "interactive") {
  return {
    schemaVersion: "facet.tier0.v2" as const,
    requestId: `request-${artifactType}`,
    revisionSha,
    artifactType,
    renderer: "svg" as const,
    source: new TextEncoder().encode(source),
    lexical: {
      rendererRootSvgCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: 0,
    },
    ...(execution === undefined ? {} : { execution }),
  } satisfies WorkerInput;
}

describe("runParser", () => {
  test.each([
    ["markdown", "# heading"],
    ["mermaid", "flowchart TD\n  A --> B"],
    ["svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>'],
    [
      "chart",
      JSON.stringify({
        $schema: "https://vega.github.io/schema/vega-lite/v5.json",
        data: { values: [{ category: "A", amount: 1 }] },
        mark: "bar",
        encoding: {
          x: { field: "category", type: "nominal" },
          y: { field: "amount", type: "quantitative" },
        },
      }),
    ],
    ["html", "<main><p>hello</p></main>"],
  ] as const)("routes %s to its parser", async (artifactType, source) => {
    const result = await runParser(input(artifactType, source));

    expect(result.revisionSha).toBe(revisionSha);
    expect(result.tier).toBe(0);
    expect(result.status).toBe("ok");
    if (artifactType === "mermaid") expect(result.observed.graphCount).toBe(1);
    if (artifactType === "svg") expect(result.observed).toHaveProperty("viewBoxes");
    if (artifactType === "html") expect(result.observed).toHaveProperty("html");
  });

  test("routes interactive TSX to the compiler and returns compiled evidence", async () => {
    const result = await runParser(
      input("tsx", "export default function App() { return <div>Hello</div>; }", "interactive"),
    );

    expect(result.status).toBe("ok");
    expect(result.execution).toBe("interactive");
    expect(result.compiled?.bytesBase64.length).toBeGreaterThan(0);
  });

  test("routes static TSX through HTML parsing", async () => {
    const result = await runParser(
      input("tsx", "export default function App() { return <div>Hello</div>; }", "static"),
    );

    expect(result.status).toBe("ok");
    expect(result.execution).toBe("static");
    expect(result.observed).toHaveProperty("html");
  });

  test.each([
    ["markdown", "<script>alert(1)</script>"],
    ["mermaid", "not a diagram"],
    ["svg", "<svg><script>alert(1)</script></svg>"],
    ["chart", "not json"],
    ["html", "<script>alert(1)</script>"],
  ] as const)("preserves parser errors for %s", async (artifactType, source) => {
    const result = await runParser(input(artifactType, source));

    expect(result.status).toBe("error");
    expect(result.observed.errorCount).toBeGreaterThan(0);
    expect(result.observed.discriminativeErrors?.length).toBeGreaterThan(0);
  });

  test("rejects an unknown artifact type", async () => {
    await expect(runParser(input("unknown" as ArtifactType, "source"))).rejects.toThrow(
      "Unsupported artifact type for tier 0: unknown",
    );
  });
});
