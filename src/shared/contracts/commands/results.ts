import { z } from "zod";

import { Tier1ResultSchema, VerdictSchema } from "../validation";
import { ArtifactTypeSchema, RendererSchema } from "../artifact";
import { EvidenceImageFormatSchema } from "../../evidence-image";
import { ExportFormatSchema } from "./requests";

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
  verdict: VerdictSchema,
  /**
   * Deprecated compatibility field. Publish is browser-free; visual
   * read-back owns Tier 1 verification.
   */
  tier1Verdict: Tier1ResultSchema.nullable().optional(),
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
  renderer: RendererSchema,
  verdict: VerdictSchema,
});
export type ReadBackResult = z.infer<typeof ReadBackResultSchema>;

export const StatusResultSchema = BaseResultSchema.extend({
  command: z.literal("status"),
  artifactId: z.string().min(1).optional(),
  latestRevisionSha: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  revisionCount: z.number().int().nonnegative().optional(),
  pinnedCount: z.number().int().nonnegative().optional(),
  templateCount: z.number().int().nonnegative().optional(),
  state: z.enum(["dormant", "active"]).optional(),
  process: z
    .object({
      pid: z.number().int().positive(),
      uptimeMs: z.number().nonnegative(),
      rssBytes: z.number().nonnegative().nullable(),
      pssBytes: z.number().nonnegative().nullable(),
    })
    .nullable()
    .optional(),
  dbBytes: z.number().int().nonnegative().optional(),
  evidenceBytes: z.number().int().nonnegative().optional(),
  activeLeases: z.number().int().nonnegative().optional(),
  activeJobs: z.number().int().nonnegative().optional(),
  browserJobs: z.number().int().nonnegative().optional(),
  idleDeadline: z.number().int().positive().nullable().optional(),
  version: z.string().min(1).optional(),
  contractVersion: z.string().min(1).optional(),
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

export const ExportSidecarSchema = z
  .object({
    artifactId: z.string().min(1),
    slug: z.string().min(1),
    revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
    artifactType: ArtifactTypeSchema,
    renderer: RendererSchema,
    verdict: VerdictSchema,
    format: ExportFormatSchema,
    renderFormat: EvidenceImageFormatSchema.optional(),
    exportedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((value, context) => {
    if (value.format === "render" && value.renderFormat === undefined) {
      context.addIssue({ code: "custom", message: "render exports require renderFormat" });
    }
    if (value.format === "source" && value.renderFormat !== undefined) {
      context.addIssue({ code: "custom", message: "source exports must omit renderFormat" });
    }
  });
export type ExportSidecar = z.infer<typeof ExportSidecarSchema>;

function isBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  let paddingStart = value.length;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isUpper || isLower || isDigit || code === 43 || code === 47) continue;
    if (code === 61) {
      paddingStart = index;
      break;
    }
    return false;
  }
  const padding = value.length - paddingStart;
  if (padding > 2) return false;
  for (let index = paddingStart; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

export const ExportResultSchema = BaseResultSchema.extend({
  command: z.literal("export"),
  format: ExportFormatSchema,
  bytes: z.string().refine(isBase64, "Invalid base64"),
  sidecar: ExportSidecarSchema,
});
export type ExportResult = z.infer<typeof ExportResultSchema>;
