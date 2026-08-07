/**
 * Public command-verb surface. Per-verb request/result schemas live in
 * `requests.ts` and `results.ts`; the discriminator unions that bind
 * them into a single `CommandRequest` / `CommandResult` live here so a
 * caller can `import { CommandRequestSchema, CommandResultSchema } from
 * "../contracts/commands"` without knowing the internal split.
 */

import { z } from "zod";

import type { Artifact, Revision, Template } from "../artifact";

import {
  ArtifactEnvelopeSchema,
  BaseRequestSchema,
  BaseResultSchema,
  ReadBackTierSchema,
  RevisionEnvelopeSchema,
  TemplateEnvelopeSchema,
  normalizeReadBackTier,
  type ArtifactEnvelope,
  type ReadBackTier,
  type RevisionEnvelope,
  type TemplateEnvelope,
} from "./_shared";
import {
  CommandNameSchema,
  IMPLEMENTED_COMMANDS,
  RESERVED_COMMANDS,
  type CommandName,
} from "./names";
import {
  CreateRequestSchema,
  InstantiateRequestSchema,
  ListRequestSchema,
  OpenRequestSchema,
  PinRequestSchema,
  PromoteRequestSchema,
  PublishArtifactTypeSchema,
  PublishRequestSchema,
  ReadBackRequestSchema,
  ReservedExportRequestSchema,
  StatusRequestSchema,
  type CreateRequest,
  type InstantiateRequest,
  type ListRequest,
  type OpenRequest,
  type PinRequest,
  type PromoteRequest,
  type PublishRequest,
  type ReadBackRequest,
  type ReservedExportRequest,
  type StatusRequest,
} from "./requests";
import {
  CreateResultSchema,
  InstantiateResultSchema,
  ListResultSchema,
  OpenResultSchema,
  PinResultSchema,
  PromoteResultSchema,
  PublishResultSchema,
  ReadBackResultSchema,
  ReservedExportResultSchema,
  StatusResultSchema,
  type CreateResult,
  type InstantiateResult,
  type ListResult,
  type OpenResult,
  type PinResult,
  type PromoteResult,
  type PublishResult,
  type ReadBackResult,
  type ReservedExportResult,
  type StatusResult,
} from "./results";
import { checkArtifactTypeSupported, checkCommandImplemented } from "./guards";

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

// Re-export Artifact/Revision/Template so callers can `import { Artifact, Revision, Template } from "..."/commands`.
export type { Artifact, Revision, Template };
export type { ArtifactEnvelope, RevisionEnvelope, TemplateEnvelope };

// Surface the full public API. Anything not re-exported here is internal.
export {
  // shared primitives
  ArtifactEnvelopeSchema,
  BaseRequestSchema,
  BaseResultSchema,
  ReadBackTierSchema,
  RevisionEnvelopeSchema,
  TemplateEnvelopeSchema,
  normalizeReadBackTier,
  // names
  CommandNameSchema,
  IMPLEMENTED_COMMANDS,
  RESERVED_COMMANDS,
  // requests
  CreateRequestSchema,
  PublishRequestSchema,
  PublishArtifactTypeSchema,
  ListRequestSchema,
  ReadBackRequestSchema,
  StatusRequestSchema,
  OpenRequestSchema,
  PromoteRequestSchema,
  InstantiateRequestSchema,
  PinRequestSchema,
  ReservedExportRequestSchema,
  // results
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
  // guards
  checkCommandImplemented,
  checkArtifactTypeSupported,
};

export type { CommandName };
export type {
  CreateRequest,
  PublishRequest,
  ListRequest,
  ReadBackRequest,
  StatusRequest,
  OpenRequest,
  PromoteRequest,
  InstantiateRequest,
  PinRequest,
  ReservedExportRequest,
  CreateResult,
  PublishResult,
  ListResult,
  ReadBackResult,
  StatusResult,
  OpenResult,
  PromoteResult,
  InstantiateResult,
  PinResult,
  ReservedExportResult,
  ReadBackTier,
};
