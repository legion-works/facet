import { describe, expect, test } from "bun:test";

import { parseWorkerInput } from "../../src/validation/tier0/worker-input";

const revisionSha = "a".repeat(64);

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: "facet.tier0.v2",
    requestId: "request-1",
    revisionSha,
    artifactType: "markdown",
    renderer: "svg",
    sourceBase64: Buffer.from("# heading").toString("base64"),
    lexical: {
      rendererRootSvgCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: 0,
    },
    ...overrides,
  });
}

describe("parseWorkerInput", () => {
  test("decodes a valid envelope into worker bytes", () => {
    const parsed = parseWorkerInput(envelope());

    expect(parsed.schemaVersion).toBe("facet.tier0.v2");
    expect(parsed.requestId).toBe("request-1");
    expect(parsed.source).toEqual(new TextEncoder().encode("# heading"));
    expect(parsed.execution).toBeUndefined();
  });

  test("rejects malformed JSON", () => {
    expect(() => parseWorkerInput("{")).toThrow();
  });

  test.each([
    ["missing schema", { schemaVersion: undefined }, "unknown schemaVersion"],
    ["missing request id", { requestId: undefined }, "invalid requestId"],
    ["invalid revision", { revisionSha: "not-a-sha" }, "invalid revisionSha"],
    ["unknown artifact", { artifactType: "pdf" }, "invalid artifactType"],
    ["invalid renderer", { renderer: "webgl" }, "invalid renderer"],
    ["missing source", { sourceBase64: undefined }, "missing sourceBase64"],
    ["missing lexical counters", { lexical: undefined }, "invalid lexical counters"],
  ])("rejects %s", (_name, overrides, message) => {
    expect(() => parseWorkerInput(envelope(overrides))).toThrow(message);
  });

  test("requires execution mode for TSX", () => {
    expect(() => parseWorkerInput(envelope({ artifactType: "tsx" }))).toThrow(
      "TSX input requires execution mode",
    );
  });

  test("rejects execution mode on non-TSX input", () => {
    expect(() => parseWorkerInput(envelope({ execution: "interactive" }))).toThrow(
      "execution is only valid for TSX input",
    );
  });
});
