import { z } from "zod";

import { ArtifactTypeSchema, ReservedArtifactTypeSchema } from "../artifact";

import { BaseRequestSchema, ReadBackTierSchema } from "./_shared";

/**
 * Wire-encoded byte payload for publish. JSON cannot carry a Uint8Array
 * directly; the v1 contract uses base64 (per D1 review) so a 5 MiB
 * source fits in ~7 MiB of JSON. The schema validates base64 syntax;
 * the dispatcher enforces SOURCE_CAP_BYTES on the decoded length and
 * throws `payload_too_large` so the wire response is a typed 413
 * rather than a schema-level 400.
 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export const PublishBytesSchema = z.string().superRefine((value, ctx) => {
  if (value.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "publish.bytes is empty",
    });
    return;
  }
  if (!BASE64_RE.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "publish.bytes is not valid base64",
    });
  }
});

/**
 * Publish accepts the four implemented artifact types AND the reserved
 * `html` literal — the reserved form parses here so the dispatcher can
 * detect it via `checkArtifactTypeSupported` and return the typed
 * `unsupported_reserved_type` error.
 */
export const PublishArtifactTypeSchema = z.union([ArtifactTypeSchema, ReservedArtifactTypeSchema]);

export const CreateRequestSchema = BaseRequestSchema.extend({
  command: z.literal("create"),
  projectId: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
});
export type CreateRequest = z.infer<typeof CreateRequestSchema>;

export const PublishRequestSchema = BaseRequestSchema.extend({
  command: z.literal("publish"),
  artifactId: z.string().min(1),
  artifactType: PublishArtifactTypeSchema,
  bytes: PublishBytesSchema,
  note: z.string().nullable().optional(),
  parentRevisionId: z.string().min(1).nullable().optional(),
});
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export const ListRequestSchema = BaseRequestSchema.extend({
  command: z.literal("list"),
  projectId: z.string().min(1),
  slugPrefix: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type ListRequest = z.infer<typeof ListRequestSchema>;

export const ReadBackRequestSchema = BaseRequestSchema.extend({
  command: z.literal("readBack"),
  artifactId: z.string().min(1),
  revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
  tier: ReadBackTierSchema,
});
export type ReadBackRequest = z.infer<typeof ReadBackRequestSchema>;

export const StatusRequestSchema = BaseRequestSchema.extend({
  command: z.literal("status"),
  artifactId: z.string().min(1),
});
export type StatusRequest = z.infer<typeof StatusRequestSchema>;

export const OpenRequestSchema = BaseRequestSchema.extend({
  command: z.literal("open"),
  artifactId: z.string().min(1),
  revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
});
export type OpenRequest = z.infer<typeof OpenRequestSchema>;

export const PromoteRequestSchema = BaseRequestSchema.extend({
  command: z.literal("promote"),
  artifactId: z.string().min(1).optional(),
  revisionId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  promotedBy: z.string().min(1),
});
export type PromoteRequest = z.infer<typeof PromoteRequestSchema>;

export const InstantiateRequestSchema = BaseRequestSchema.extend({
  command: z.literal("instantiate"),
  name: z.string().min(1),
  newSlug: z.string().min(1),
  projectId: z.string().min(1).optional(),
});
export type InstantiateRequest = z.infer<typeof InstantiateRequestSchema>;

export const PinRequestSchema = BaseRequestSchema.extend({
  command: z.literal("pin"),
  revisionId: z.string().min(1),
  pinned: z.boolean(),
});
export type PinRequest = z.infer<typeof PinRequestSchema>;

export const ReservedExportRequestSchema = BaseRequestSchema.extend({
  command: z.literal("export"),
  format: z.string().min(1),
});
export type ReservedExportRequest = z.infer<typeof ReservedExportRequestSchema>;
