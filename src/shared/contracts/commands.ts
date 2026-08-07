import { z } from "zod";

import { FacetError } from "../errors/facet-error";
import {
  ArtifactTypeSchema,
  RESERVED_ARTIFACT_TYPE,
  ReservedArtifactTypeSchema,
  TemplateSchema,
  type Artifact,
  type Revision,
  type Template,
} from "./artifact";

/**
 * Every command verb the protocol recognizes. `export` is reserved (it
 * parses cleanly here so the schema can describe the wire) but the
 * dispatcher must consult `checkCommandImplemented` and return
 * `reserved_not_implemented` before any handler logic runs.
 */
export const CommandNameSchema = z.enum([
  "create",
  "publish",
  "list",
  "readBack",
  "status",
  "open",
  "promote",
  "instantiate",
  "pin",
  "export",
]);
export type CommandName = z.infer<typeof CommandNameSchema>;

export const IMPLEMENTED_COMMANDS: readonly CommandName[] = [
  "create",
  "publish",
  "list",
  "readBack",
  "status",
  "open",
  "promote",
  "instantiate",
  "pin",
];

export const RESERVED_COMMANDS: readonly CommandName[] = ["export"];

const ArtifactEnvelopeSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const RevisionEnvelopeSchema = z.object({
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

const TemplateEnvelopeSchema = TemplateSchema.extend({});

/** `tier: 0 | 1 | "visual"` — the public read-back tier; "visual" is sugar for tier 1. */
const ReadBackTierSchema = z.union([z.literal(0), z.literal(1), z.literal("visual")]);
export type ReadBackTier = z.infer<typeof ReadBackTierSchema>;

/** Normalize a public read-back tier to a numeric validation tier. */
export function normalizeReadBackTier(tier: ReadBackTier): 0 | 1 {
  return tier === "visual" ? 1 : tier;
}

const BaseRequest = z.object({ requestId: z.string().min(1) });

export const CreateRequestSchema = BaseRequest.extend({
  command: z.literal("create"),
  projectId: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
});
export type CreateRequest = z.infer<typeof CreateRequestSchema>;

/**
 * Publish accepts the four implemented artifact types AND the reserved
 * `html` literal — the reserved form parses here so the dispatcher can
 * detect it via `checkArtifactTypeSupported` and return the typed
 * `unsupported_reserved_type` error.
 */
export const PublishArtifactTypeSchema = z.union([ArtifactTypeSchema, ReservedArtifactTypeSchema]);

export const PublishRequestSchema = BaseRequest.extend({
  command: z.literal("publish"),
  artifactId: z.string().min(1),
  artifactType: PublishArtifactTypeSchema,
  bytes: z.instanceof(Uint8Array),
  note: z.string().nullable().optional(),
  parentRevisionId: z.string().min(1).nullable().optional(),
});
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export const ListRequestSchema = BaseRequest.extend({
  command: z.literal("list"),
  projectId: z.string().min(1),
  slugPrefix: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type ListRequest = z.infer<typeof ListRequestSchema>;

export const ReadBackRequestSchema = BaseRequest.extend({
  command: z.literal("readBack"),
  artifactId: z.string().min(1),
  revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
  tier: ReadBackTierSchema,
});
export type ReadBackRequest = z.infer<typeof ReadBackRequestSchema>;

export const StatusRequestSchema = BaseRequest.extend({
  command: z.literal("status"),
  artifactId: z.string().min(1),
});
export type StatusRequest = z.infer<typeof StatusRequestSchema>;

export const OpenRequestSchema = BaseRequest.extend({
  command: z.literal("open"),
  artifactId: z.string().min(1),
  revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
});
export type OpenRequest = z.infer<typeof OpenRequestSchema>;

export const PromoteRequestSchema = BaseRequest.extend({
  command: z.literal("promote"),
  artifactId: z.string().min(1).optional(),
  revisionId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  promotedBy: z.string().min(1),
});
export type PromoteRequest = z.infer<typeof PromoteRequestSchema>;

export const InstantiateRequestSchema = BaseRequest.extend({
  command: z.literal("instantiate"),
  name: z.string().min(1),
  newSlug: z.string().min(1),
  promotedBy: z.string().min(1),
  projectId: z.string().min(1).optional(),
});
export type InstantiateRequest = z.infer<typeof InstantiateRequestSchema>;

export const PinRequestSchema = BaseRequest.extend({
  command: z.literal("pin"),
  revisionId: z.string().min(1),
  pinned: z.boolean(),
});
export type PinRequest = z.infer<typeof PinRequestSchema>;

const ReservedExportRequestSchema = BaseRequest.extend({
  command: z.literal("export"),
  format: z.string().min(1),
});
export type ReservedExportRequest = z.infer<typeof ReservedExportRequestSchema>;

/**
 * Discriminated union of every command request the protocol parses.
 * `export` is included so the schema can describe the wire; the
 * dispatcher must check `checkCommandImplemented` and short-circuit.
 */
export const CommandRequestSchema = z.discriminatedUnion("command", [
  CreateRequestSchema,
  PublishRequestSchema,
  ListRequestSchema,
  ReadBackRequestSchema,
  StatusRequestSchema,
  OpenRequestSchema,
  PromoteRequestSchema,
  InstantiateRequestSchema,
  PinRequestSchema,
  ReservedExportRequestSchema,
]);
export type CommandRequest = z.infer<typeof CommandRequestSchema>;

const BaseResult = z.object({ requestId: z.string().min(1) });

export const CreateResultSchema = BaseResult.extend({
  command: z.literal("create"),
  artifact: ArtifactEnvelopeSchema,
});
export type CreateResult = z.infer<typeof CreateResultSchema>;

export const PublishResultSchema = BaseResult.extend({
  command: z.literal("publish"),
  revision: RevisionEnvelopeSchema,
});
export type PublishResult = z.infer<typeof PublishResultSchema>;

export const ListResultSchema = BaseResult.extend({
  command: z.literal("list"),
  artifacts: z.array(ArtifactEnvelopeSchema),
  nextCursor: z.string().nullable().optional(),
});
export type ListResult = z.infer<typeof ListResultSchema>;

export const VerdictObservedSchema = z.object({
  rendererRootSvgCount: z.number().int().nonnegative(),
  graphCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
});

export const ReadBackResultSchema = BaseResult.extend({
  command: z.literal("readBack"),
  verdict: z.object({
    status: z.string().min(1),
    tier: z.union([z.literal(0), z.literal(1)]),
    artifactId: z.string().min(1),
    revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
    observed: VerdictObservedSchema,
  }),
});
export type ReadBackResult = z.infer<typeof ReadBackResultSchema>;

export const StatusResultSchema = BaseResult.extend({
  command: z.literal("status"),
  artifactId: z.string().min(1),
  revisionCount: z.number().int().nonnegative(),
  pinnedCount: z.number().int().nonnegative(),
  templateCount: z.number().int().nonnegative(),
});
export type StatusResult = z.infer<typeof StatusResultSchema>;

export const OpenResultSchema = BaseResult.extend({
  command: z.literal("open"),
  artifactId: z.string().min(1),
  revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
  frameUrl: z.string().min(1),
});
export type OpenResult = z.infer<typeof OpenResultSchema>;

export const PromoteResultSchema = BaseResult.extend({
  command: z.literal("promote"),
  template: TemplateEnvelopeSchema,
});
export type PromoteResult = z.infer<typeof PromoteResultSchema>;

export const InstantiateResultSchema = BaseResult.extend({
  command: z.literal("instantiate"),
  artifact: ArtifactEnvelopeSchema,
  template: TemplateEnvelopeSchema,
});
export type InstantiateResult = z.infer<typeof InstantiateResultSchema>;

export const PinResultSchema = BaseResult.extend({
  command: z.literal("pin"),
  revisionId: z.string().min(1),
  pinned: z.boolean(),
});
export type PinResult = z.infer<typeof PinResultSchema>;

const ReservedExportResultSchema = BaseResult.extend({
  command: z.literal("export"),
  accepted: z.literal(false),
  reason: z.string().min(1),
});
export type ReservedExportResult = z.infer<typeof ReservedExportResultSchema>;

export const CommandResultSchema = z.discriminatedUnion("command", [
  CreateResultSchema,
  PublishResultSchema,
  ListResultSchema,
  ReadBackResultSchema,
  StatusResultSchema,
  OpenResultSchema,
  PromoteResultSchema,
  InstantiateResultSchema,
  PinResultSchema,
  ReservedExportResultSchema,
]);
export type CommandResult = z.infer<typeof CommandResultSchema>;

/**
 * Returns a `reserved_not_implemented` FacetError for any reserved verb
 * (currently just `export`) and `null` for every implemented verb. The
 * command dispatcher calls this before running any handler.
 */
export function checkCommandImplemented(name: CommandName): FacetError | null {
  if ((RESERVED_COMMANDS as readonly CommandName[]).includes(name)) {
    return new FacetError(
      "reserved_not_implemented",
      `Command '${name}' is reserved and not implemented in this build`,
      { retryable: false, details: { command: name } },
    );
  }
  return null;
}

/**
 * Returns `unsupported_reserved_type` for the reserved `html` artifact
 * type and `null` for every implemented type. The publish dispatcher
 * calls this before passing the bytes into the store.
 */
export function checkArtifactTypeSupported(type: string): FacetError | null {
  if (type === RESERVED_ARTIFACT_TYPE) {
    return new FacetError(
      "unsupported_reserved_type",
      `Artifact type '${type}' is reserved and not supported in this build`,
      { retryable: false, details: { artifactType: type } },
    );
  }
  return null;
}

// Re-export Artifact/Revision/Template for callers that prefer the
// commands module as the one import.
export type { Artifact, Revision, Template };
