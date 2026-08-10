import {
  ExportResultSchema,
  ExportSidecarSchema,
  type ExportFormat,
  type ExportRequest,
  type ExportResult,
  type ExportSidecar,
} from "../shared/contracts/commands";
import type { Artifact, Revision } from "../shared/contracts/artifact";
import { type Verdict } from "../shared/contracts/validation";
import { FacetError } from "../shared/errors/facet-error";
import { now } from "../shared/util/time";
import { latestStoredVerdict } from "./stored-verdict";
import type { ArtifactRepository } from "./store/repository";

export function buildExportSidecar(input: {
  readonly artifact: Artifact;
  readonly revision: Revision;
  readonly verdict: Verdict;
  readonly format: ExportFormat;
  readonly exportedAt: string;
}): ExportSidecar {
  return ExportSidecarSchema.parse({
    artifactId: input.artifact.id,
    slug: input.artifact.slug,
    revisionSha: input.revision.sha256,
    artifactType: input.revision.artifactType,
    renderer: input.revision.renderer,
    verdict: input.verdict,
    format: input.format,
    exportedAt: input.exportedAt,
  });
}

export function exportStoredSource(input: {
  readonly repository: ArtifactRepository;
  readonly command: ExportRequest;
  readonly requestId: string;
  readonly exportedAt?: string;
}): ExportResult {
  if (input.command.format === "render") {
    throw new FacetError("evidence_unavailable", "Render export is not implemented", {
      retryable: false,
      details: { format: input.command.format },
    });
  }

  const artifact = input.repository.getArtifactById(input.command.artifactId);
  if (artifact === null) {
    throw new FacetError("artifact_not_found", "Artifact not found", {
      retryable: false,
      details: { artifactId: input.command.artifactId },
    });
  }

  const revision =
    input.command.revisionSha === undefined
      ? input.repository.getLatestRevision(input.command.artifactId)
      : input.repository.getRevisionBySha(input.command.artifactId, input.command.revisionSha);
  if (revision === null) {
    throw new FacetError("revision_not_found", "Revision not found", {
      retryable: false,
      details: {
        artifactId: input.command.artifactId,
        ...(input.command.revisionSha === undefined
          ? {}
          : { revisionSha: input.command.revisionSha }),
      },
    });
  }

  const verdict = latestStoredVerdict(input.repository, revision);
  if (verdict === null) {
    throw new FacetError("revision_not_found", "No stored verdict for revision", {
      retryable: false,
      details: { revisionId: revision.id },
    });
  }

  const format = input.command.format;
  return ExportResultSchema.parse({
    command: "export",
    requestId: input.requestId,
    format,
    bytes: Buffer.from(revision.source).toString("base64"),
    sidecar: buildExportSidecar({
      artifact,
      revision,
      verdict,
      format,
      exportedAt: input.exportedAt ?? now(),
    }),
  });
}
