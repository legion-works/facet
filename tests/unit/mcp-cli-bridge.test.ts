import { describe, expect, test } from "bun:test";
import {
  buildFacetArgs,
  invokeFacet,
  parseFacetStdout,
  type FacetCliInvocation,
} from "../../src/harness-adapters/mcp/cli-bridge";

describe("MCP CLI bridge", () => {
  test("builds the safe no-launch open invocation", () => {
    expect(buildFacetArgs("open", { artifactId: "art-1" })).toEqual([
      "open",
      "--artifact-id",
      "art-1",
      "--no-launch",
    ]);
  });

  test("returns a valid Facet envelope from a CLI runner", async () => {
    const invocations: FacetCliInvocation[] = [];
    const result = await invokeFacet(["status"], {
      runner: async (invocation) => {
        invocations.push(invocation);
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            '{"schemaVersion":"facet.v1","requestId":"req-test","ok":true,"data":{"command":"status"}}\n',
        };
      },
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args.slice(-1)).toEqual(["status"]);
    expect(result).toMatchObject({ ok: true, data: { command: "status" } });
  });

  test("rejects non-envelope stdout", () => {
    expect(() => parseFacetStdout("not-json\n")).toThrowError(/invalid.*envelope/i);
  });
});
