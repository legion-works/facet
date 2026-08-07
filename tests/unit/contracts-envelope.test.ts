import { describe, expect, test } from "bun:test";

import {
  FACET_SCHEMA_VERSION,
  FacetEnvelopeSchema,
  FacetErrorBodySchema,
  errEnvelope,
  okEnvelope,
  parseEnvelope,
  type FacetEnvelope,
  type FacetErrorBody,
} from "../../src/shared/contracts/envelope";

const REQUEST_ID = "req-0001";

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

describe("FacetEnvelope (strict discrimination)", () => {
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

  test("ok:true with an `error` key is REJECTED (strict discrimination)", () => {
    const forged = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: true,
      data: { hello: "world" },
      error: { code: "x", message: "y", retryable: false },
    };
    expect(FacetEnvelopeSchema.safeParse(forged).success).toBe(false);
  });

  test("ok:false with a `data` key is REJECTED (strict discrimination)", () => {
    const forged = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: false,
      error: { code: "x", message: "y", retryable: false },
      data: { hello: "world" },
    };
    expect(FacetEnvelopeSchema.safeParse(forged).success).toBe(false);
  });

  test("extra top-level key on ok:true is REJECTED", () => {
    const forged = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: true,
      data: { hello: "world" },
      extra: "not allowed",
    };
    expect(FacetEnvelopeSchema.safeParse(forged).success).toBe(false);
  });

  test("extra top-level key on ok:false is REJECTED", () => {
    const forged = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: false,
      error: { code: "x", message: "y", retryable: false },
      debug: "should not survive",
    };
    expect(FacetEnvelopeSchema.safeParse(forged).success).toBe(false);
  });

  test("missing requestId is REJECTED on ok:true", () => {
    const forged = {
      schemaVersion: FACET_SCHEMA_VERSION,
      ok: true,
      data: { hello: "world" },
    };
    expect(FacetEnvelopeSchema.safeParse(forged).success).toBe(false);
  });

  test("missing requestId is REJECTED on ok:false", () => {
    const forged = {
      schemaVersion: FACET_SCHEMA_VERSION,
      ok: false,
      error: { code: "x", message: "y", retryable: false },
    };
    expect(FacetEnvelopeSchema.safeParse(forged).success).toBe(false);
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

  test("forged ok:true+error envelope is rejected by parseEnvelope", () => {
    const result = parseEnvelope({
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: true,
      data: { hello: "world" },
      error: { code: "x", message: "y", retryable: false },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.body.code).toBe("invalid_envelope");
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
