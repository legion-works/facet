import { z } from "zod";

import { ARTIFACT_TYPES } from "./artifact-types";
import { RENDERERS } from "./renderers";

export { ARTIFACT_TYPES, type ArtifactType } from "./artifact-types";
export { RENDERERS, type Renderer } from "./renderers";
export const ArtifactTypeSchema = z.enum(ARTIFACT_TYPES);
export const RendererSchema = z.enum(RENDERERS);

/** HTML identifies a reserved format and is deliberately excluded from ArtifactTypeSchema and store writes. */
export const RESERVED_ARTIFACT_TYPE = "html" as const;
export const ReservedArtifactTypeSchema = z.literal(RESERVED_ARTIFACT_TYPE);
export type ReservedArtifactType = z.infer<typeof ReservedArtifactTypeSchema>;

const IdSchema = z.string().min(1);
const IsoTimestampSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ByteSourceSchema = z.instanceof(Uint8Array);

export const ProjectSchema = z.object({
  id: IdSchema,
  projectRoot: z.string().min(1),
  createdAt: IsoTimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const ArtifactSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  slug: z.string().min(1),
  title: z.string().min(1),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const RevisionSchema = z.object({
  id: IdSchema,
  artifactId: IdSchema,
  revisionNumber: z.number().int().positive(),
  parentRevisionId: IdSchema.nullable(),
  artifactType: ArtifactTypeSchema,
  renderer: RendererSchema,
  source: ByteSourceSchema,
  sha256: Sha256Schema,
  note: z.string().nullable(),
  pinned: z.boolean(),
  createdAt: IsoTimestampSchema,
});
export type Revision = z.infer<typeof RevisionSchema>;

export const RenderRunSchema = z.object({
  id: IdSchema,
  revisionId: IdSchema,
  tier: z.union([z.literal(0), z.literal(1)]),
  status: z.string().min(1),
  expectedJson: z.string(),
  observedJson: z.string(),
  screenshotPath: z.string().nullable(),
  consolePath: z.string().nullable(),
  screenshotErrorJson: z.string().nullable(),
  insecureJson: z.string().nullable(),
  /**
   * Retained-evidence carve-out: `true` exempts the row from the
   * last-N retention eviction. Pin/template call sites mark rows
   * retained (Task 14); the cleanup policy skips them.
   */
  retained: z.boolean(),
  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema,
});
export type RenderRun = z.infer<typeof RenderRunSchema>;

export const TemplateSchema = z.object({
  id: IdSchema,
  artifactId: IdSchema,
  revisionId: IdSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  promotedBy: z.string().min(1),
  promotedAt: IsoTimestampSchema,
});
export type Template = z.infer<typeof TemplateSchema>;
