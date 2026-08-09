import { describe, expect, test } from "bun:test";

import {
  FacetError,
  FacetErrorCodes,
  type FacetErrorCode,
} from "../../src/shared/errors/facet-error";
import {
  LexicalCountersSchema,
  ProtocolObservationSchema,
  RenderStatusSchema,
  Tier0ResultSchema,
  Tier1ResultSchema,
  ValidationTierSchema,
  VerdictSchema,
} from "../../src/shared/contracts/validation";
import { checkRendererSupported } from "../../src/shared/contracts/commands";
import { SOURCE_CAP_BYTES } from "../../src/shared/config/limits";

describe("FacetError", () => {
  test("encodes the documented error code set including the store codes", () => {
    const requiredCodes: FacetErrorCode[] = [
      "database_corrupt",
      "reserved_not_implemented",
      "unsupported_reserved_type",
      "unknown_schema_version",
      "payload_too_large",
    ];
    for (const code of requiredCodes) {
      expect(FacetErrorCodes).toHaveProperty(code);
    }
  });

  test("constructs, exposes its fields, and serializes to a FacetErrorBody", () => {
    const error = new FacetError("payload_too_large", "Too large", {
      retryable: false,
      details: { sizeBytes: SOURCE_CAP_BYTES + 1, capBytes: SOURCE_CAP_BYTES },
    });
    expect(error.code).toBe("payload_too_large");
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ sizeBytes: SOURCE_CAP_BYTES + 1, capBytes: SOURCE_CAP_BYTES });
    expect(error.toBody()).toEqual({
      code: "payload_too_large",
      message: "Too large",
      retryable: false,
      details: { sizeBytes: SOURCE_CAP_BYTES + 1, capBytes: SOURCE_CAP_BYTES },
    });
  });

  test("FacetError.from wraps a non-FacetError and falls back to invalid_envelope", () => {
    const wrapped = FacetError.from(new Error("nope"));
    expect(wrapped.code).toBe("invalid_envelope");
  });

  test("FacetError.from returns a FacetError unchanged", () => {
    const original = new FacetError("database_corrupt", "bad db");
    expect(FacetError.from(original)).toBe(original);
  });
});

describe("limits", () => {
  test("SOURCE_CAP_BYTES matches the ADR 0001 D2 value of 5 MiB", () => {
    expect(SOURCE_CAP_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("validation tier and render status", () => {
  test("ValidationTierSchema accepts only 0 and 1", () => {
    expect(ValidationTierSchema.safeParse(0).success).toBe(true);
    expect(ValidationTierSchema.safeParse(1).success).toBe(true);
    expect(ValidationTierSchema.safeParse(2).success).toBe(false);
  });

  test("RenderStatusSchema accepts the full closed set", () => {
    const statuses = [
      "ok",
      "error",
      "partial:layout_unverified",
      "partial:opaque_content",
      "tampered",
      "timeout",
      "shim_only",
      "probe_only",
    ];
    for (const status of statuses) {
      expect(RenderStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(RenderStatusSchema.safeParse("unknown").success).toBe(false);
  });

  test("checkRendererSupported only permits canvas for charts", () => {
    expect(checkRendererSupported("chart", "canvas")).toBeNull();
    expect(checkRendererSupported("markdown", "canvas")).toMatchObject({ code: "invalid_request" });
  });

  test("opaque region counters reject negative values", () => {
    expect(
      LexicalCountersSchema.safeParse({
        rendererRootSvgCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: -1,
      }).success,
    ).toBe(false);
    expect(
      ProtocolObservationSchema.safeParse({
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        viewBoxes: [],
        errorCount: 0,
        discriminativeErrors: [],
        opaqueRegionCount: -1,
      }).success,
    ).toBe(false);
  });
});

describe("canonical verdict / unified observed shape", () => {
  test("VerdictSchema accepts the canonical observed (rendererRootSvgCount, graphCount, mermaidNodeCount, visibleSvgCount, errorCount)", () => {
    const sample = {
      status: "ok" as const,
      tier: 1 as const,
      artifactId: "art-1",
      revisionSha: "a".repeat(64),
      observed: {
        rendererRootSvgCount: 2,
        graphCount: 2,
        mermaidNodeCount: 40,
        visibleSvgCount: 2,
        errorCount: 0,
        opaqueRegionCount: 0,
      },
    };
    expect(VerdictSchema.safeParse(sample).success).toBe(true);
  });

  test("VerdictSchema accepts the optional viewBoxes and discriminativeErrors fields", () => {
    const sample = {
      status: "tampered" as const,
      tier: 1 as const,
      artifactId: "art-1",
      revisionSha: "a".repeat(64),
      observed: {
        rendererRootSvgCount: 1,
        graphCount: 1,
        mermaidNodeCount: 2,
        visibleSvgCount: 1,
        viewBoxes: ["0 0 100 100"],
        errorCount: 0,
        opaqueRegionCount: 0,
        discriminativeErrors: [{ code: "forged", message: "page tried to override report" }],
      },
    };
    expect(VerdictSchema.safeParse(sample).success).toBe(true);
  });

  test("VerdictSchema rejects a string-only status (not from the closed RenderStatus set)", () => {
    const sample = {
      status: "kinda_ok",
      tier: 0 as const,
      artifactId: "art-1",
      revisionSha: "a".repeat(64),
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 0,
        opaqueRegionCount: 0,
      },
    };
    expect(VerdictSchema.safeParse(sample).success).toBe(false);
  });
});

describe("Tier0/Tier1 result schemas derive from VerdictSchema", () => {
  test("Tier0ResultSchema extends VerdictSchema: status/tier/artifactId/revisionSha/observed plus expected", () => {
    const sample = {
      revisionSha: "a".repeat(64),
      tier: 0 as const,
      status: "ok" as const,
      artifactId: "art-1",
      expected: {
        rendererRootSvgCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
      },
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 0,
        opaqueRegionCount: 0,
      },
    };
    expect(Tier0ResultSchema.safeParse(sample).success).toBe(true);
  });

  test("Tier1ResultSchema extends Tier0ResultSchema with screenshotPath and consolePath", () => {
    const sample = {
      revisionSha: "a".repeat(64),
      tier: 1 as const,
      status: "ok" as const,
      artifactId: "art-1",
      expected: {
        rendererRootSvgCount: 1,
        mermaidNodeCount: 2,
        visibleSvgCount: 1,
        opaqueRegionCount: 0,
      },
      observed: {
        rendererRootSvgCount: 1,
        graphCount: 1,
        mermaidNodeCount: 2,
        visibleSvgCount: 1,
        errorCount: 0,
        opaqueRegionCount: 0,
      },
      screenshotPath: null,
      consolePath: null,
    };
    expect(Tier1ResultSchema.safeParse(sample).success).toBe(true);
  });

  test("Tier1ResultSchema requires screenshots for every partial status", () => {
    const base = {
      revisionSha: "a".repeat(64),
      tier: 1 as const,
      artifactId: "art-1",
      expected: {
        rendererRootSvgCount: 1,
        mermaidNodeCount: 2,
        visibleSvgCount: 1,
        opaqueRegionCount: 0,
      },
      observed: {
        rendererRootSvgCount: 1,
        graphCount: 1,
        mermaidNodeCount: 2,
        visibleSvgCount: 1,
        errorCount: 0,
        opaqueRegionCount: 0,
      },
      consolePath: null,
    };
    for (const status of ["partial:layout_unverified", "partial:opaque_content"] as const) {
      expect(Tier1ResultSchema.safeParse({ ...base, status, screenshotPath: null }).success).toBe(
        false,
      );
      expect(
        Tier1ResultSchema.safeParse({ ...base, status, screenshotPath: "/tmp/screenshot.png" })
          .success,
      ).toBe(true);
    }
  });
});
