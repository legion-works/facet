import { describe, expect, test } from "bun:test";

import { buildTemplatesRequest } from "../../src/cli/commands/templates";
import { parseArgs, renderHelp } from "../../src/cli/parser";
import { presentEnvelope } from "../../src/cli/presenter";
import { TemplatesRequestSchema, TemplatesResultSchema } from "../../src/shared/contracts/commands";
import { MAX_LIST_LIMIT } from "../../src/shared/config/limits";

describe("facet templates", () => {
  test("enforces list limit on both CLI and wire", () => {
    expect(buildTemplatesRequest({ limit: "2" })).toMatchObject({ command: "templates", limit: 2 });
    expect(() => buildTemplatesRequest({ limit: String(MAX_LIST_LIMIT + 1) })).toThrowError(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(
      TemplatesRequestSchema.safeParse({
        requestId: "r",
        command: "templates",
        limit: MAX_LIST_LIMIT + 1,
      }).success,
    ).toBe(false);
    expect(parseArgs(["templates", "--limit", "2"])).toMatchObject({
      kind: "verb",
      verb: "templates",
      args: { limit: "2" },
    });
    expect(renderHelp("templates")).toContain("--limit");
  });

  test("renders a template table with source verdict and override", () => {
    const result = {
      requestId: "r",
      command: "templates" as const,
      templates: [
        {
          name: "stable",
          artifactId: "art",
          revisionId: "rev",
          revisionSha: "a".repeat(64),
          promotedBy: "operator",
          promotedAt: "2026-01-01T00:00:00.000Z",
          promotionOverride: "error",
          sourceVerdict: { status: "ok" as const, tier: 1 as const },
        },
      ],
    };
    expect(TemplatesResultSchema.safeParse(result).success).toBe(true);
    const lines = presentEnvelope(
      { schemaVersion: "facet.v1", requestId: "r", ok: true, data: result },
      { color: false },
    );
    expect(lines[0]).toBe("NAME · SHA · VERDICT · OVERRIDE · BY · DATE");
    expect(lines[1]).toBe("stable · aaaaaaaaaaaa · ✓ ok t1 · error · operator · 2026-01-01");
    expect(lines[1]!.length).toBeLessThanOrEqual(100);
    expect(result.templates[0]?.revisionSha).toHaveLength(64);
    const long = {
      ...result,
      templates: [
        {
          ...result.templates[0]!,
          name: "a very long template name",
          promotedBy: "a very long operator name",
          promotionOverride: "no_visual_verification",
          sourceVerdict: { status: "partial:external_resources" as const, tier: 1 as const },
        },
      ],
    };
    const longLine = presentEnvelope(
      { schemaVersion: "facet.v1", requestId: "r", ok: true, data: long },
      { color: false },
    )[1];
    expect(longLine).toContain("◐ partial:external_resources t1");
    expect(longLine!.length).toBeLessThanOrEqual(100);
    const withoutOverride = {
      ...result,
      templates: [{ ...result.templates[0]!, promotionOverride: null }],
    };
    expect(
      presentEnvelope(
        { schemaVersion: "facet.v1", requestId: "r", ok: true, data: withoutOverride },
        { color: false },
      )[1],
    ).toContain(" ·  · operator · ");
  });
});
