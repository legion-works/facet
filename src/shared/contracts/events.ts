import { z } from "zod";

import { ArtifactTypeSchema } from "./artifact";

/**
 * Stream lifecycle events emitted on the SSE channel. The wire is
 * `type`-discriminated so clients can pattern-match without parsing a
 * string union.
 */
export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stream:open"),
    streamId: z.string().min(1),
    artifactId: z.string().min(1).nullable(),
    at: z.string().datetime({ offset: true }),
  }),
  z.object({
    type: z.literal("stream:heartbeat"),
    streamId: z.string().min(1),
    at: z.string().datetime({ offset: true }),
  }),
  z.object({
    type: z.literal("stream:close"),
    streamId: z.string().min(1),
    at: z.string().datetime({ offset: true }),
    reason: z.string().min(1),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

/**
 * Emitted whenever a revision commits to the store. The sha is the
 * authoritative identifier clients use to address the revision; the
 * number is the human-readable position in the artifact's history.
 */
export const RevisionCommittedEventSchema = z.object({
  type: z.literal("revision:committed"),
  artifactId: z.string().min(1),
  revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
  revisionNumber: z.number().int().positive(),
  artifactType: ArtifactTypeSchema,
  at: z.string().datetime({ offset: true }),
});
