import { z } from "zod";

import { VerdictSchema } from "../validation";

import {
  ArtifactEnvelopeSchema,
  BaseResultSchema,
  RevisionEnvelopeSchema,
  TemplateEnvelopeSchema,
} from "./_shared";

export const CreateResultSchema = BaseResultSchema.extend({
  command: z.literal("create"),
  artifact: ArtifactEnvelopeSchema,
});
export type CreateResult = z.infer<typeof CreateResultSchema>;

export const PublishResultSchema = BaseResultSchema.extend({
  command: z.literal("publish"),
  revision: RevisionEnvelopeSchema,
});
export type PublishResult = z.infer<typeof PublishResultSchema>;

export const ListResultSchema = BaseResultSchema.extend({
  command: z.literal("list"),
  artifacts: z.array(ArtifactEnvelopeSchema),
  nextCursor: z.string().nullable().optional(),
});
export type ListResult = z.infer<typeof ListResultSchema>;

/**
 * Read-back result embeds the canonical `VerdictSchema` from
 * `validation.ts`. The two definitions are the SAME object so a
 * `toMatchObject({ verdict })` against a read-back response and a
 * `toMatchObject(...)` against a Tier 1 run produce the same shape.
 */
export const ReadBackResultSchema = BaseResultSchema.extend({
  command: z.literal("readBack"),
  verdict: VerdictSchema,
});
export type ReadBackResult = z.infer<typeof ReadBackResultSchema>;

export const StatusResultSchema = BaseResultSchema.extend({
  command: z.literal("status"),
  artifactId: z.string().min(1),
  revisionCount: z.number().int().nonnegative(),
  pinnedCount: z.number().int().nonnegative(),
  templateCount: z.number().int().nonnegative(),
});
export type StatusResult = z.infer<typeof StatusResultSchema>;

export const OpenResultSchema = BaseResultSchema.extend({
  command: z.literal("open"),
  artifactId: z.string().min(1),
  revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
  frameUrl: z.string().min(1),
  /**
   * Out-of-band lease capability for the SSE route. The lease id is
   * never embedded in `frameUrl`; the client carries it via the
   * `X-Gallery-Lease` header on the stream connect request.
   */
  lease: z.object({
    leaseId: z.string().min(1),
    expiresAt: z.number().int().positive(),
  }),
});
export type OpenResult = z.infer<typeof OpenResultSchema>;

export const PromoteResultSchema = BaseResultSchema.extend({
  command: z.literal("promote"),
  template: TemplateEnvelopeSchema,
});
export type PromoteResult = z.infer<typeof PromoteResultSchema>;

export const InstantiateResultSchema = BaseResultSchema.extend({
  command: z.literal("instantiate"),
  artifact: ArtifactEnvelopeSchema,
  template: TemplateEnvelopeSchema,
});
export type InstantiateResult = z.infer<typeof InstantiateResultSchema>;

export const PinResultSchema = BaseResultSchema.extend({
  command: z.literal("pin"),
  revisionId: z.string().min(1),
  pinned: z.boolean(),
});
export type PinResult = z.infer<typeof PinResultSchema>;

export const ReservedExportResultSchema = BaseResultSchema.extend({
  command: z.literal("export"),
  accepted: z.literal(false),
  reason: z.string().min(1),
});
export type ReservedExportResult = z.infer<typeof ReservedExportResultSchema>;
