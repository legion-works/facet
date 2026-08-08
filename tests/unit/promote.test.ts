import { describe, expect, test } from "bun:test";

import { FacetError } from "../../src/shared/errors/facet-error";
import { buildPromoteRequest } from "../../src/cli/commands/promote";

describe("buildPromoteRequest", () => {
  const valid = {
    "revision-id": "rev-1",
    name: "release-template",
    "promoted-by": "operator@example.test",
  };

  test("builds an operator promotion request with optional metadata", () => {
    const request = buildPromoteRequest({
      ...valid,
      "artifact-id": "artifact-1",
      description: "stable",
    });
    expect(request).toMatchObject({
      command: "promote",
      revisionId: "rev-1",
      name: "release-template",
      promotedBy: "operator@example.test",
      artifactId: "artifact-1",
      description: "stable",
    });
    expect(request.requestId).toMatch(/^req-/);
  });

  test.each([
    ["revision-id", { ...valid, "revision-id": "" }],
    ["name", { ...valid, name: "" }],
    ["promoted-by", { ...valid, "promoted-by": "" }],
  ])("rejects missing %s with typed invalid_request", (_name, args) => {
    expect(() => buildPromoteRequest(args)).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
  });

  test("rejects non-string operator arguments", () => {
    expect(() => buildPromoteRequest({ ...valid, name: true })).toThrow(FacetError);
    expect(() => buildPromoteRequest({ ...valid, "promoted-by": false })).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
  });
});
