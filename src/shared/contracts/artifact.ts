import { z } from "zod";

import { TSX_EXECUTION_MODES } from "../tsx/execution";
import { ARTIFACT_TYPES } from "./artifact-types";
import { RENDERERS } from "./renderers";
import { EvidenceImageFormatSchema } from "../evidence-image";

export { ARTIFACT_TYPES, type ArtifactType } from "./artifact-types";
export { RENDERERS, type Renderer } from "./renderers";
export const ArtifactTypeSchema = z.enum(ARTIFACT_TYPES);
export const RendererSchema = z.enum(RENDERERS);

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
  /**
   * TSX execution mode (D2). Only present for `artifactType === "tsx"`
   * — every other type stores `'static'` on disk but the field is
   * absent from the wire form (the dispatch is explicit: `execution`
   * must be absent, not null, for non-TSX artifacts). Derived from
   * the canonical `TSX_EXECUTION_MODES` array so a new mode lands in
   * one place.
   */
  execution: z.enum(TSX_EXECUTION_MODES).optional(),
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
  screenshotFormat: EvidenceImageFormatSchema.nullable().optional(),
  consolePath: z.string().nullable(),
  /**
   * TSX compiled-bundle evidence (D7). The compiled bundle is derived
   * output stored alongside the run, not a wire form — `null` for
   * non-TSX runs and for TSX runs whose compilation did not produce
   * a retained file.
   */
  compiledPath: z.string().nullable().optional(),
  screenshotErrorJson: z.string().nullable(),
  insecureJson: z.string().nullable(),
  /**
   * Retained-evidence carve-out: `true` exempts the row from the
   * last-N retention eviction. Pin/template call sites mark rows
   * retained; the cleanup policy skips them.
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
