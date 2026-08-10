import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

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
import { latestStoredVerdict, verdictFromStoredRun } from "./stored-verdict";
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

function resolveExportTarget(
  repository: ArtifactRepository,
  command: ExportRequest,
): { artifact: Artifact; revision: Revision } {
  const artifact = repository.getArtifactById(command.artifactId);
  if (artifact === null) {
    throw new FacetError("artifact_not_found", "Artifact not found", {
      retryable: false,
      details: { artifactId: command.artifactId },
    });
  }

  const revision =
    command.revisionSha === undefined
      ? repository.getLatestRevision(command.artifactId)
      : repository.getRevisionBySha(command.artifactId, command.revisionSha);
  if (revision === null) {
    throw new FacetError("revision_not_found", "Revision not found", {
      retryable: false,
      details: {
        artifactId: command.artifactId,
        ...(command.revisionSha === undefined ? {} : { revisionSha: command.revisionSha }),
      },
    });
  }
  return { artifact, revision };
}

function evidenceUnavailable(artifact: Artifact, revision: Revision, cause?: unknown): FacetError {
  return new FacetError("evidence_unavailable", "Screenshot evidence unavailable", {
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
    details: { artifactId: artifact.id, revisionSha: revision.sha256 },
  });
}

function resolveEvidencePath(
  repository: ArtifactRepository,
  screenshotPath: string,
  artifact: Artifact,
  revision: Revision,
): string {
  const evidenceRoot = repository.getEvidenceRoot();
  if (evidenceRoot === undefined) throw evidenceUnavailable(artifact, revision);
  try {
    const resolvedRoot = realpathSync(evidenceRoot);
    const resolvedCandidate = realpathSync(screenshotPath);
    const relativeCandidate = relative(resolvedRoot, resolvedCandidate);
    if (
      relativeCandidate.length === 0 ||
      isAbsolute(relativeCandidate) ||
      relativeCandidate === ".." ||
      relativeCandidate.startsWith("../")
    ) {
      throw new Error("Screenshot evidence is outside the evidence root");
    }
    return resolvedCandidate;
  } catch (cause) {
    throw evidenceUnavailable(artifact, revision, cause);
  }
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

  const { artifact, revision } = resolveExportTarget(input.repository, input.command);

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

export function exportStoredRender(input: {
  readonly repository: ArtifactRepository;
  readonly command: ExportRequest;
  readonly requestId: string;
  readonly exportedAt?: string;
}): ExportResult {
  const { artifact, revision } = resolveExportTarget(input.repository, input.command);

  const run = input.repository.listRenderRuns({ revisionId: revision.id, tier: 1 })[0];
  if (run === undefined || run.screenshotPath === null) {
    throw evidenceUnavailable(artifact, revision);
  }

  let bytes: Uint8Array;
  try {
    const screenshotPath = resolveEvidencePath(
      input.repository,
      run.screenshotPath,
      artifact,
      revision,
    );
    bytes = new Uint8Array(readFileSync(screenshotPath));
  } catch (cause) {
    if (cause instanceof FacetError) throw cause;
    throw evidenceUnavailable(artifact, revision, cause);
  }

  const verdict = verdictFromStoredRun(revision, run);
  return ExportResultSchema.parse({
    command: "export",
    requestId: input.requestId,
    format: "render",
    bytes: Buffer.from(bytes).toString("base64"),
    sidecar: buildExportSidecar({
      artifact,
      revision,
      verdict,
      format: "render",
      exportedAt: input.exportedAt ?? now(),
    }),
  });
}
