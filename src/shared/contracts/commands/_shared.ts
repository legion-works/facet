import { z } from "zod";

import { ArtifactTypeSchema, TemplateSchema } from "../artifact";

/**
 * Shared wire-envelope schemas reused by every command verb's request
 * and result. Kept in one place so a typo in `requestId` or a SHA
 * regex drift is fixed in a single file.
 */
export const ArtifactEnvelopeSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ArtifactEnvelope = z.infer<typeof ArtifactEnvelopeSchema>;

export const RevisionEnvelopeSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  revisionNumber: z.number().int().positive(),
  parentRevisionId: z.string().min(1).nullable(),
  artifactType: ArtifactTypeSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  note: z.string().nullable(),
  pinned: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
});
export type RevisionEnvelope = z.infer<typeof RevisionEnvelopeSchema>;

export const TemplateEnvelopeSchema = TemplateSchema;
export type TemplateEnvelope = z.infer<typeof TemplateEnvelopeSchema>;

/** Every request carries a `requestId` for correlation with its result. */
export const BaseRequestSchema = z.object({ requestId: z.string().min(1) });

/** Every result echoes the request's `requestId`. */
export const BaseResultSchema = z.object({ requestId: z.string().min(1) });

/** Public read-back tier. `0` and `1` are the literal verifier tiers; `"visual"` is sugar for `1`. */
export const ReadBackTierSchema = z.union([z.literal(0), z.literal(1), z.literal("visual")]);
export type ReadBackTier = z.infer<typeof ReadBackTierSchema>;

/** Normalize a public read-back tier to a numeric validation tier. */
export function normalizeReadBackTier(tier: ReadBackTier): 0 | 1 {
  return tier === "visual" ? 1 : tier;
}
