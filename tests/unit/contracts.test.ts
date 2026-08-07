import { describe, expect, test } from "bun:test";

import {
  FACET_SCHEMA_VERSION,
  FacetEnvelopeSchema,
  errEnvelope,
  okEnvelope,
  parseEnvelope,
  type FacetEnvelope,
  type FacetErrorBody,
} from "../../src/shared/contracts/envelope";
import {
  FacetError,
  FacetErrorCodes,
  type FacetErrorCode,
} from "../../src/shared/errors/facet-error";
import {
  CommandNameSchema,
  CommandRequestSchema,
  CommandResultSchema,
  CreateRequestSchema,
  CreateResultSchema,
  IMPLEMENTED_COMMANDS,
  InstantiateRequestSchema,
  InstantiateResultSchema,
  ListRequestSchema,
  ListResultSchema,
  OpenRequestSchema,
  OpenResultSchema,
  PinRequestSchema,
  PinResultSchema,
  PromoteRequestSchema,
  PromoteResultSchema,
  PublishRequestSchema,
  PublishResultSchema,
  ReadBackRequestSchema,
  ReadBackResultSchema,
  RESERVED_COMMANDS,
  StatusRequestSchema,
  StatusResultSchema,
  checkArtifactTypeSupported,
  checkCommandImplemented,
  type CommandName,
  type CommandRequest,
  type CommandResult,
} from "../../src/shared/contracts/commands";
import { FacetErrorBodySchema } from "../../src/shared/contracts/envelope";
import {
  RenderStatusSchema,
  Tier0ResultSchema,
  Tier1ResultSchema,
  ValidationTierSchema,
} from "../../src/shared/contracts/validation";
import { SOURCE_CAP_BYTES } from "../../src/shared/config/limits";

const REQUEST_ID = "req-0001";

function validCreateRequest() {
  return {
    command: "create" as const,
    requestId: REQUEST_ID,
    projectId: "project-1",
    slug: "my-artifact",
    title: "My artifact",
  };
}

function validCreateResult() {
  return {
    command: "create" as const,
    requestId: REQUEST_ID,
    artifact: {
      id: "art-1",
      projectId: "project-1",
      slug: "my-artifact",
      title: "My artifact",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  };
}

function validPublishRequest() {
  return {
    command: "publish" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    artifactType: "markdown" as const,
    bytes: new Uint8Array([104, 105]),
    note: null,
  };
}

function validPublishResult() {
  return {
    command: "publish" as const,
    requestId: REQUEST_ID,
    revision: {
      id: "rev-1",
      artifactId: "art-1",
      revisionNumber: 1,
      parentRevisionId: null,
      artifactType: "markdown" as const,
      sha256: "a".repeat(64),
      note: null,
      pinned: false,
      createdAt: "2025-01-01T00:00:00.000Z",
    },
  };
}

function validListRequest() {
  return {
    command: "list" as const,
    requestId: REQUEST_ID,
    projectId: "project-1",
  };
}

function validListResult() {
  return {
    command: "list" as const,
    requestId: REQUEST_ID,
    artifacts: [
      {
        id: "art-1",
        projectId: "project-1",
        slug: "first",
        title: "First",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ],
  };
}

function validReadBackRequest() {
  return {
    command: "readBack" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    revisionSha: "a".repeat(64),
    tier: 0 as const,
  };
}

function validReadBackResult() {
  return {
    command: "readBack" as const,
    requestId: REQUEST_ID,
    verdict: {
      status: "ok" as const,
      tier: 1 as const,
      artifactId: "art-1",
      revisionSha: "a".repeat(64),
      observed: { rendererRootSvgCount: 1, graphCount: 1, errorCount: 0 },
    },
  };
}

function validStatusRequest() {
  return {
    command: "status" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
  };
}

function validStatusResult() {
  return {
    command: "status" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    revisionCount: 5,
    pinnedCount: 1,
    templateCount: 1,
  };
}

function validOpenRequest() {
  return {
    command: "open" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    revisionSha: "a".repeat(64),
  };
}

function validOpenResult() {
  return {
    command: "open" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    revisionSha: "a".repeat(64),
    frameUrl: "facet://frame/art-1/a".repeat(8).slice(0, 64) + "0",
  };
}

function validPromoteRequest() {
  return {
    command: "promote" as const,
    requestId: REQUEST_ID,
    artifactId: "art-1",
    revisionId: "rev-1",
    name: "stable",
    promotedBy: "alice",
  };
}

function validPromoteResult() {
  return {
    command: "promote" as const,
    requestId: REQUEST_ID,
    template: {
      id: "tpl-1",
      artifactId: "art-1",
      revisionId: "rev-1",
      name: "stable",
      description: null,
      promotedBy: "alice",
      promotedAt: "2025-01-01T00:00:00.000Z",
    },
  };
}

function validInstantiateRequest() {
  return {
    command: "instantiate" as const,
    requestId: REQUEST_ID,
    name: "stable",
    newSlug: "instantiated-artifact",
    promotedBy: "bob",
  };
}

function validInstantiateResult() {
  return {
    command: "instantiate" as const,
    requestId: REQUEST_ID,
    artifact: {
      id: "art-2",
      projectId: "project-1",
      slug: "instantiated-artifact",
      title: "stable",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    template: {
      id: "tpl-1",
      artifactId: "art-1",
      revisionId: "rev-1",
      name: "stable",
      description: null,
      promotedBy: "alice",
      promotedAt: "2025-01-01T00:00:00.000Z",
    },
  };
}

function validPinRequest() {
  return {
    command: "pin" as const,
    requestId: REQUEST_ID,
    revisionId: "rev-1",
    pinned: true,
  };
}

function validPinResult() {
  return {
    command: "pin" as const,
    requestId: REQUEST_ID,
    revisionId: "rev-1",
    pinned: true,
  };
}

describe("FACET_SCHEMA_VERSION", () => {
  test("is the literal facet.v1 string", () => {
    expect(FACET_SCHEMA_VERSION).toBe("facet.v1");
  });
});

describe("FacetErrorBody", () => {
  test("accepts primitive details values", () => {
    const body = {
      code: "x",
      message: "y",
      retryable: false,
      details: { a: 1, b: "two", c: true, d: null },
    };
    expect(FacetErrorBodySchema.safeParse(body).success).toBe(true);
  });

  test("rejects non-primitive details values", () => {
    const nested = {
      code: "x",
      message: "y",
      retryable: false,
      details: { a: { nested: "obj" } },
    };
    expect(FacetErrorBodySchema.safeParse(nested).success).toBe(false);
  });

  test("rejects undefined values inside details", () => {
    const undef = {
      code: "x",
      message: "y",
      retryable: false,
      details: { a: undefined },
    };
    expect(FacetErrorBodySchema.safeParse(undef).success).toBe(false);
  });
});

describe("FacetEnvelope", () => {
  test("ok:true envelope round-trips with the data payload intact", () => {
    const envelope: FacetEnvelope<{ value: number }> = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: true,
      data: { value: 7 },
    };
    const parsed = FacetEnvelopeSchema.parse(envelope);
    expect(parsed).toEqual(envelope);
  });

  test("ok:false envelope round-trips with the error body intact", () => {
    const body: FacetErrorBody = {
      code: "reserved_not_implemented",
      message: "not yet",
      retryable: false,
    };
    const envelope: FacetEnvelope<never> = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: false,
      error: body,
    };
    const parsed = FacetEnvelopeSchema.parse(envelope);
    expect(parsed).toEqual(envelope);
  });

  test("okEnvelope/errEnvelope helpers produce schema-valid envelopes", () => {
    const ok = okEnvelope(REQUEST_ID, { hello: "world" });
    const err = errEnvelope(REQUEST_ID, { code: "x", message: "y", retryable: false });
    expect(FacetEnvelopeSchema.parse(ok).ok).toBe(true);
    expect(FacetEnvelopeSchema.parse(err).ok).toBe(false);
  });
});

describe("parseEnvelope", () => {
  test("unknown schemaVersion 'facet.v2' returns unknown_schema_version", () => {
    const result = parseEnvelope({
      schemaVersion: "facet.v2",
      requestId: REQUEST_ID,
      ok: true,
      data: { hello: "world" },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.body.code).toBe("unknown_schema_version");
      expect(result.body.retryable).toBe(false);
    }
  });

  test("non-object input returns invalid_envelope", () => {
    const result = parseEnvelope("not an envelope");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.body.code).toBe("invalid_envelope");
    }
  });

  test("valid ok:true envelope round-trips through parseEnvelope", () => {
    const result = parseEnvelope({
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: true,
      data: { hello: "world" },
    });
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.envelope).toEqual({
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        ok: true,
        data: { hello: "world" },
      });
    }
  });

  test("valid ok:false envelope round-trips through parseEnvelope", () => {
    const result = parseEnvelope({
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: false,
      error: { code: "x", message: "y", retryable: false },
    });
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.envelope.ok).toBe(false);
    }
  });

  test("stdout serialization purity: JSON.stringify of an envelope is exactly one JSON object with no undefined or functions", () => {
    const envelope: FacetEnvelope<{ count: number; nested: { name: string } }> = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: true,
      data: { count: 3, nested: { name: "x" } },
    };
    const json = JSON.stringify(envelope);
    expect(json).not.toContain("undefined");
    expect(json).not.toContain("[object Object]");
    expect(json).not.toMatch(/function\s/);
    // exactly one top-level object — count of leading `{` must equal one
    expect(json.startsWith("{")).toBe(true);
    const round = JSON.parse(json);
    expect(round).toEqual(envelope);
  });
});

describe("CommandName coverage", () => {
  test("exposes the nine implemented command verbs", () => {
    const implemented: CommandName[] = [
      "create",
      "publish",
      "list",
      "readBack",
      "status",
      "open",
      "promote",
      "instantiate",
      "pin",
    ];
    expect(new Set(IMPLEMENTED_COMMANDS)).toEqual(new Set(implemented));
  });

  test("names 'export' as a reserved verb", () => {
    expect(RESERVED_COMMANDS).toContain("export");
  });

  test("CommandNameSchema accepts both implemented and reserved names", () => {
    for (const name of [...IMPLEMENTED_COMMANDS, ...RESERVED_COMMANDS]) {
      expect(CommandNameSchema.safeParse(name).success).toBe(true);
    }
  });

  test("CommandNameSchema rejects unknown names", () => {
    expect(CommandNameSchema.safeParse("delete").success).toBe(false);
    expect(CommandNameSchema.safeParse("").success).toBe(false);
  });
});

describe("command round-trips", () => {
  test("create request and result round-trip", () => {
    const req = validCreateRequest();
    const res = validCreateResult();
    expect(CreateRequestSchema.parse(req)).toEqual(req);
    expect(CreateResultSchema.parse(res)).toEqual(res);
  });

  test("publish request and result round-trip", () => {
    const req = validPublishRequest();
    const res = validPublishResult();
    expect(PublishRequestSchema.parse(req)).toEqual(req);
    expect(PublishResultSchema.parse(res)).toEqual(res);
  });

  test("list request and result round-trip", () => {
    const req = validListRequest();
    const res = validListResult();
    expect(ListRequestSchema.parse(req)).toEqual(req);
    expect(ListResultSchema.parse(res)).toEqual(res);
  });

  test("readBack request accepts tier 0, tier 1, and 'visual' (which normalizes to tier 1)", () => {
    expect(ReadBackRequestSchema.safeParse({ ...validReadBackRequest(), tier: 0 }).success).toBe(
      true,
    );
    expect(ReadBackRequestSchema.safeParse({ ...validReadBackRequest(), tier: 1 }).success).toBe(
      true,
    );
    expect(
      ReadBackRequestSchema.safeParse({ ...validReadBackRequest(), tier: "visual" }).success,
    ).toBe(true);
    expect(ReadBackRequestSchema.safeParse({ ...validReadBackRequest(), tier: 7 }).success).toBe(
      false,
    );
  });

  test("readBack request and result round-trip", () => {
    const req = validReadBackRequest();
    const res = validReadBackResult();
    expect(ReadBackRequestSchema.parse(req)).toEqual(req);
    expect(ReadBackResultSchema.parse(res)).toEqual(res);
  });

  test("status request and result round-trip", () => {
    const req = validStatusRequest();
    const res = validStatusResult();
    expect(StatusRequestSchema.parse(req)).toEqual(req);
    expect(StatusResultSchema.parse(res)).toEqual(res);
  });

  test("open request and result round-trip", () => {
    const req = validOpenRequest();
    const res = validOpenResult();
    expect(OpenRequestSchema.parse(req)).toEqual(req);
    expect(OpenResultSchema.parse(res)).toEqual(res);
  });

  test("promote request and result round-trip", () => {
    const req = validPromoteRequest();
    const res = validPromoteResult();
    expect(PromoteRequestSchema.parse(req)).toEqual(req);
    expect(PromoteResultSchema.parse(res)).toEqual(res);
  });

  test("instantiate request and result round-trip", () => {
    const req = validInstantiateRequest();
    const res = validInstantiateResult();
    expect(InstantiateRequestSchema.parse(req)).toEqual(req);
    expect(InstantiateResultSchema.parse(res)).toEqual(res);
  });

  test("pin request and result round-trip", () => {
    const req = validPinRequest();
    const res = validPinResult();
    expect(PinRequestSchema.parse(req)).toEqual(req);
    expect(PinResultSchema.parse(res)).toEqual(res);
  });

  test("discriminated union of all requests round-trips for implemented verbs", () => {
    const samples: CommandRequest[] = [
      validCreateRequest(),
      validPublishRequest(),
      validListRequest(),
      validReadBackRequest(),
      validStatusRequest(),
      validOpenRequest(),
      validPromoteRequest(),
      validInstantiateRequest(),
      validPinRequest(),
    ];
    for (const sample of samples) {
      const parsed = CommandRequestSchema.parse(sample);
      expect(parsed).toEqual(sample);
    }
  });

  test("discriminated union of all results round-trips for implemented verbs", () => {
    const samples: CommandResult[] = [
      validCreateResult(),
      validPublishResult(),
      validListResult(),
      validReadBackResult(),
      validStatusResult(),
      validOpenResult(),
      validPromoteResult(),
      validInstantiateResult(),
      validPinResult(),
    ];
    for (const sample of samples) {
      const parsed = CommandResultSchema.parse(sample);
      expect(parsed).toEqual(sample);
    }
  });
});

describe("reserved 'export' command verb", () => {
  test("parses as a valid request but checkCommandImplemented returns reserved_not_implemented", () => {
    const exportReq = {
      command: "export" as const,
      requestId: REQUEST_ID,
      format: "pdf",
    };
    // The schema should still parse the verb itself
    expect(CommandNameSchema.safeParse(exportReq.command).success).toBe(true);
    const error = checkCommandImplemented(exportReq.command);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("reserved_not_implemented");
    expect(error?.retryable).toBe(false);
    expect(error?.toBody()).toEqual({
      code: "reserved_not_implemented",
      message: error!.message,
      retryable: false,
      details: { command: "export" },
    });
  });

  test("checkCommandImplemented returns null for every implemented verb", () => {
    for (const name of IMPLEMENTED_COMMANDS) {
      expect(checkCommandImplemented(name)).toBeNull();
    }
  });
});

describe("reserved 'html' artifact type", () => {
  test("checkArtifactTypeSupported('html') returns unsupported_reserved_type", () => {
    const error = checkArtifactTypeSupported("html");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("unsupported_reserved_type");
    expect(error?.retryable).toBe(false);
  });

  test("checkArtifactTypeSupported accepts every implemented type", () => {
    expect(checkArtifactTypeSupported("markdown")).toBeNull();
    expect(checkArtifactTypeSupported("mermaid")).toBeNull();
    expect(checkArtifactTypeSupported("svg")).toBeNull();
    expect(checkArtifactTypeSupported("chart")).toBeNull();
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
});

describe("Tier0/Tier1 result schemas", () => {
  test("Tier0ResultSchema accepts the verdict-style observed shape", () => {
    const sample = {
      revisionSha: "a".repeat(64),
      tier: 0 as const,
      status: "ok" as const,
      expected: { rendererRootSvgCount: 0, mermaidNodeCount: 0, visibleSvgCount: 0 },
      observed: { rendererRootSvgCount: 0, mermaidNodeCount: 0, visibleSvgCount: 0, errorCount: 0 },
    };
    expect(Tier0ResultSchema.safeParse(sample).success).toBe(true);
  });

  test("Tier1ResultSchema accepts the verdict-style observed shape", () => {
    const sample = {
      revisionSha: "a".repeat(64),
      tier: 1 as const,
      status: "ok" as const,
      expected: { rendererRootSvgCount: 1, mermaidNodeCount: 2, visibleSvgCount: 1 },
      observed: {
        rendererRootSvgCount: 1,
        mermaidNodeCount: 2,
        visibleSvgCount: 1,
        errorCount: 0,
      },
      screenshotPath: null,
      consolePath: null,
    };
    expect(Tier1ResultSchema.safeParse(sample).success).toBe(true);
  });
});

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
