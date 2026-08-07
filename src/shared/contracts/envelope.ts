import { z } from "zod";

/**
 * The single protocol version this build speaks. Any envelope carrying a
 * different value is rejected with `unknown_schema_version` so future
 * schema bumps can fail loud rather than silently mis-parse.
 */
export const FACET_SCHEMA_VERSION = "facet.v1" as const;
export type FacetSchemaVersion = typeof FACET_SCHEMA_VERSION;

export const SchemaVersionSchema = z.literal(FACET_SCHEMA_VERSION);

const PrimitiveDetailsSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * Wire body of every error response. `details` only accepts JSON-safe
 * primitives so the envelope round-trips through `JSON.parse(JSON.stringify(...))`
 * without losing type information — and without leaking functions, errors,
 * or undefined into the wire format.
 */
export const FacetErrorBodySchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), PrimitiveDetailsSchema).optional(),
});
export type FacetErrorBody = z.infer<typeof FacetErrorBodySchema>;

/**
 * Both arms use `.strict()` so an envelope can carry ONLY the fields
 * its discriminator allows. `ok:true` may not smuggle an `error` key
 * (and vice versa), and no arm accepts extra top-level keys. Without
 * this, a forged envelope with `ok:true` plus an `error` body would
 * parse cleanly and confuse every downstream consumer that branches on
 * the discriminator.
 */
const EnvelopeOkSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    requestId: z.string().min(1),
    ok: z.literal(true),
    data: z.unknown(),
  })
  .strict();

const EnvelopeErrSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    requestId: z.string().min(1),
    ok: z.literal(false),
    error: FacetErrorBodySchema,
  })
  .strict();

export const FacetEnvelopeSchema = z.discriminatedUnion("ok", [
  EnvelopeOkSchema,
  EnvelopeErrSchema,
]);

export type FacetEnvelope<T> =
  | {
      schemaVersion: FacetSchemaVersion;
      requestId: string;
      ok: true;
      data: T;
    }
  | {
      schemaVersion: FacetSchemaVersion;
      requestId: string;
      ok: false;
      error: FacetErrorBody;
    };

/** Build a typed ok envelope carrying `data`. */
export function okEnvelope<T>(requestId: string, data: T): FacetEnvelope<T> {
  return {
    schemaVersion: FACET_SCHEMA_VERSION,
    requestId,
    ok: true,
    data,
  };
}

/** Build a typed error envelope carrying `error`. */
export function errEnvelope(requestId: string, error: FacetErrorBody): FacetEnvelope<never> {
  return {
    schemaVersion: FACET_SCHEMA_VERSION,
    requestId,
    ok: false,
    error,
  };
}

export type ParseEnvelopeResult =
  | { ok: true; envelope: FacetEnvelope<unknown> }
  | { ok: false; body: FacetErrorBody };

/**
 * Parse an arbitrary value as a Facet envelope. Returns a typed
 * `unknown_schema_version` body when the value carries a future schema
 * version, a typed `invalid_envelope` body for every other parse failure,
 * and a typed `ok: true` result for well-formed inputs.
 */
export function parseEnvelope(input: unknown): ParseEnvelopeResult {
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      body: {
        code: "invalid_envelope",
        message: "Envelope must be a JSON object",
        retryable: false,
      },
    };
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.schemaVersion !== FACET_SCHEMA_VERSION) {
    return {
      ok: false,
      body: {
        code: "unknown_schema_version",
        message: `Unknown schema version: ${String(candidate.schemaVersion)}`,
        retryable: false,
        details: { received: String(candidate.schemaVersion ?? "undefined") },
      },
    };
  }
  const parsed = FacetEnvelopeSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, envelope: parsed.data as FacetEnvelope<unknown> };
  }
  return {
    ok: false,
    body: {
      code: "invalid_envelope",
      message: parsed.error.issues[0]?.message ?? "Envelope failed validation",
      retryable: false,
      details: { issueCount: parsed.error.issues.length },
    },
  };
}
