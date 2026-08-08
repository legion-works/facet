/**
 * Command dispatcher.
 *
 * Pure handler: maps a parsed-and-validated `CommandRequest` to its
 * repository call, returning the result body that the envelope wrapper
 * will hand back to the caller. The dispatcher never touches HTTP
 * concerns (headers, status codes) — those live in router.ts.
 *
 * Errors are surfaced as `FacetError` so the router's envelope helper
 * can map them to the typed error response.
 */

import {
  checkArtifactTypeSupported,
  normalizeReadBackTier,
  type ArtifactEnvelope,
  type CommandRequest,
} from "../shared/contracts/commands";
import { VerdictObservedSchema, VerdictSchema, type Verdict } from "../shared/contracts/validation";
import { FacetError } from "../shared/errors/facet-error";
import { SOURCE_CAP_BYTES } from "../shared/config/limits";

import type { GalleryLeaseManager } from "./security/leases";
import type { IdleController } from "./lifecycle/idle-controller";
import type { ArtifactRepository } from "./store/repository";

export interface DispatcherDeps {
  readonly repository: ArtifactRepository;
  readonly leases: GalleryLeaseManager;
  readonly idle: IdleController;
}

function mapArtifact(a: import("../shared/contracts/artifact").Artifact): ArtifactEnvelope {
  return {
    id: a.id,
    projectId: a.projectId,
    slug: a.slug,
    title: a.title,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function buildVerdict(input: {
  artifactId: string;
  revisionSha: string;
  tier: 0 | 1;
  status: string;
  observed: unknown;
}): Verdict {
  const observed = VerdictObservedSchema.parse(input.observed);
  return VerdictSchema.parse({
    status: input.status,
    tier: input.tier,
    artifactId: input.artifactId,
    revisionSha: input.revisionSha,
    observed,
  });
}

export async function dispatch(
  deps: DispatcherDeps,
  command: CommandRequest,
  requestId: string,
): Promise<unknown> {
  switch (command.command) {
    case "create": {
      const project = deps.repository.getOrCreateProjectById(command.projectId, "/facet");
      const artifact = deps.repository.createArtifact({
        projectId: project.id,
        slug: command.slug,
        title: command.title,
      });
      return { command: "create", requestId, artifact: mapArtifact(artifact) };
    }
    case "publish": {
      const unsupported = checkArtifactTypeSupported(command.artifactType);
      if (unsupported !== null) throw unsupported;
      const bytes = Uint8Array.from(command.bytes);
      if (bytes.byteLength > SOURCE_CAP_BYTES) {
        throw new FacetError("payload_too_large", "Publish bytes exceed SOURCE_CAP_BYTES", {
          retryable: false,
          details: { sizeBytes: bytes.byteLength, capBytes: SOURCE_CAP_BYTES },
        });
      }
      const revision = deps.repository.publishRevision({
        artifactId: command.artifactId,
        artifactType: command.artifactType,
        source: bytes,
        ...(command.note !== undefined ? { note: command.note } : {}),
        ...(command.parentRevisionId !== undefined
          ? { parentRevisionId: command.parentRevisionId }
          : {}),
      });
      const { source: _source, ...envelope } = revision;
      void _source;
      return { command: "publish", requestId, revision: envelope };
    }
    case "list": {
      const project = deps.repository.getOrCreateProjectById(command.projectId, "/facet");
      const artifacts = deps.repository.listArtifacts({
        projectId: project.id,
        ...(command.slugPrefix !== undefined ? { slugPrefix: command.slugPrefix } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
      });
      return {
        command: "list",
        requestId,
        artifacts: artifacts.map(mapArtifact),
        nextCursor: null,
      };
    }
    case "readBack": {
      const revision = deps.repository.getRevisionBySha(command.artifactId, command.revisionSha);
      if (revision === null) {
        throw new FacetError("revision_not_found", "Revision not found", {
          retryable: false,
          details: { artifactId: command.artifactId, revisionSha: command.revisionSha },
        });
      }
      const tier = normalizeReadBackTier(command.tier);
      const runs = deps.repository.listRenderRuns({ revisionId: revision.id, tier });
      if (runs.length === 0) {
        throw new FacetError("revision_not_found", "No render runs recorded for revision", {
          retryable: false,
          details: { revisionId: revision.id, tier },
        });
      }
      const observedJson = JSON.parse(runs[0]!.observedJson);
      const verdict = buildVerdict({
        artifactId: command.artifactId,
        revisionSha: command.revisionSha,
        tier,
        status: runs[0]!.status,
        observed: observedJson,
      });
      return { command: "readBack", requestId, verdict };
    }
    case "status": {
      const counts = deps.repository.statusForArtifact({ artifactId: command.artifactId });
      return {
        command: "status",
        requestId,
        artifactId: command.artifactId,
        revisionCount: counts.revisionCount,
        pinnedCount: counts.pinnedCount,
        templateCount: counts.templateCount,
      };
    }
    case "open": {
      const revision = deps.repository.getRevisionBySha(command.artifactId, command.revisionSha);
      if (revision === null) {
        throw new FacetError("revision_not_found", "Revision not found", {
          retryable: false,
          details: { artifactId: command.artifactId, revisionSha: command.revisionSha },
        });
      }
      const lease = deps.leases.issue({ artifactId: command.artifactId, pid: process.pid });
      deps.idle.acquire(`lease:${lease.leaseId}`);
      const frameUrl = `facet://frame/${command.artifactId}/${command.revisionSha}?lease=${lease.leaseId}`;
      return {
        command: "open",
        requestId,
        artifactId: command.artifactId,
        revisionSha: command.revisionSha,
        frameUrl,
      };
    }
    case "promote": {
      const template = deps.repository.promoteRevision({
        ...(command.artifactId !== undefined ? { artifactId: command.artifactId } : {}),
        revisionId: command.revisionId,
        name: command.name,
        promotedBy: command.promotedBy,
        ...(command.description !== undefined ? { description: command.description } : {}),
      });
      return { command: "promote", requestId, template };
    }
    case "instantiate": {
      const template = deps.repository.findTemplateByName(command.name);
      if (template === null) {
        throw new FacetError("template_not_found", "Template not found", {
          retryable: false,
          details: { name: command.name },
        });
      }
      const project = deps.repository.getOrCreateProjectById(
        command.projectId ?? template.artifactId,
        "/facet",
      );
      const artifact = deps.repository.createArtifact({
        projectId: project.id,
        slug: command.newSlug,
        title: template.name,
      });
      return {
        command: "instantiate",
        requestId,
        artifact: mapArtifact(artifact),
        template,
      };
    }
    case "pin": {
      const revision = deps.repository.getRevisionById(command.revisionId);
      if (revision === null) {
        throw new FacetError("revision_not_found", "Revision not found", {
          retryable: false,
          details: { revisionId: command.revisionId },
        });
      }
      if (command.pinned) {
        deps.repository.pinRevision(command.revisionId);
      }
      return {
        command: "pin",
        requestId,
        revisionId: command.revisionId,
        pinned: command.pinned,
      };
    }
    case "export": {
      // Handled at the router's reserved-verb guard — never reached here.
      throw new FacetError("reserved_not_implemented", "export reserved", { retryable: false });
    }
    default: {
      const exhaustive: never = command;
      void exhaustive;
      throw new FacetError("invalid_request", "Unhandled command", { retryable: false });
    }
  }
}
