import { z } from "zod";

import { ArtifactTypeSchema, RendererSchema } from "../../shared/contracts/artifact";

const RevisionShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ExecutionSchema = z.enum(["static", "interactive"]);
const ReadBackTierSchema = z.union([z.literal(0), z.literal(1), z.literal("visual")]);

export const PublishToolShape = {
  artifactId: z.string().min(1),
  type: ArtifactTypeSchema,
  execution: ExecutionSchema.optional(),
  renderer: RendererSchema.optional(),
  sourceText: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  parentRevisionId: z.string().min(1).optional(),
};
export const PublishToolSchema = z.object(PublishToolShape).strict();
export type PublishToolInput = z.infer<typeof PublishToolSchema>;

export const ReadBackToolShape = {
  artifactId: z.string().min(1),
  revisionSha: RevisionShaSchema.optional(),
  tier: ReadBackTierSchema.optional(),
};
export const ReadBackToolSchema = z.object(ReadBackToolShape).strict();
export type ReadBackToolInput = z.infer<typeof ReadBackToolSchema>;

export const StatusToolShape = {
  artifactId: z.string().min(1).optional(),
  start: z.boolean().optional(),
};
export const StatusToolSchema = z.object(StatusToolShape).strict();
export type StatusToolInput = z.infer<typeof StatusToolSchema>;

export const ExportToolShape = {
  artifactId: z.string().min(1),
  revisionSha: RevisionShaSchema.optional(),
  format: z.enum(["source", "render"]).default("source"),
  outDir: z.string().min(1),
  force: z.boolean().optional(),
  includeBytes: z.boolean().optional(),
};
export const ExportToolSchema = z.object(ExportToolShape).strict();
export type ExportToolInput = z.infer<typeof ExportToolSchema>;

export const OpenUrlToolShape = {
  artifactId: z.string().min(1),
  revisionSha: RevisionShaSchema.optional(),
};
export const OpenUrlToolSchema = z.object(OpenUrlToolShape).strict();
export type OpenUrlToolInput = z.infer<typeof OpenUrlToolSchema>;
