import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import {
  ExportResultSchema,
  type ExportRequest,
  type ExportResult,
} from "../shared/contracts/commands";
import type { Artifact, Revision } from "../shared/contracts/artifact";
import {
  mediaTypeForEvidenceImage,
  sniffEvidenceImageFormat,
  type EvidenceImageFormat,
} from "../shared/evidence-image";
import { buildExportSidecar } from "../shared/export";
import { FacetError } from "../shared/errors/facet-error";
import { now } from "../shared/util/time";
import { latestStoredVerdict, verdictFromStoredRun } from "./stored-verdict";
import type { ArtifactRepository } from "./store/repository";

export { buildExportSidecar } from "../shared/export";

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

// Legacy evidence roots whose tolerant read has already been reported.
// The service is long-lived, so the migration warning fires at most once
// per process per legacy root.
const loggedLegacyEvidenceRoots = new Set<string>();

function resolveEvidencePath(
  repository: ArtifactRepository,
  screenshotPath: string,
  artifact: Artifact,
  revision: Revision,
): string {
  const evidenceRoot = repository.getEvidenceRoot();
  if (evidenceRoot === undefined) throw evidenceUnavailable(artifact, revision);
  // The stored screenshot path is absolute, so the read root is decided per
  // path, not by "is the canonical root empty": try the canonical root first,
  // then the legacy child-derived root (pre explicit-threading installs wrote
  // evidence there). The legacy root is read-only — never written.
  const roots: Array<{ root: string; legacy: boolean }> = [{ root: evidenceRoot, legacy: false }];
  const legacyRoot = repository.getLegacyEvidenceRoot();
  if (legacyRoot !== undefined && legacyRoot !== evidenceRoot) {
    roots.push({ root: legacyRoot, legacy: true });
  }
  for (const { root, legacy } of roots) {
    try {
      const resolvedRoot = realpathSync(root);
      const resolvedCandidate = realpathSync(screenshotPath);
      const relativeCandidate = relative(resolvedRoot, resolvedCandidate);
      if (
        relativeCandidate.length === 0 ||
        isAbsolute(relativeCandidate) ||
        relativeCandidate === ".." ||
        relativeCandidate.startsWith("../")
      ) {
        // Not under this root — try the next (legacy) root.
        continue;
      }
      if (legacy && !loggedLegacyEvidenceRoots.has(root)) {
        loggedLegacyEvidenceRoots.add(root);
        console.warn(
          `facet: reading legacy evidence root ${root} (tolerant read; new evidence is written to ${evidenceRoot})`,
        );
      }
      return resolvedCandidate;
    } catch {
      // root missing or candidate unresolvable — try the next root
    }
  }
  throw evidenceUnavailable(artifact, revision);
}

export function readStoredRenderEvidence(input: {
  readonly repository: ArtifactRepository;
  readonly artifact: Artifact;
  readonly revision: Revision;
}): {
  bytes: Uint8Array;
  format: EvidenceImageFormat;
  mediaType: ReturnType<typeof mediaTypeForEvidenceImage>;
  verdict: ReturnType<typeof verdictFromStoredRun>;
} {
  const run = input.repository.listRenderRuns({ revisionId: input.revision.id, tier: 1 })[0];
  if (run === undefined || run.screenshotPath === null) {
    throw evidenceUnavailable(input.artifact, input.revision);
  }

  try {
    const screenshotPath = resolveEvidencePath(
      input.repository,
      run.screenshotPath,
      input.artifact,
      input.revision,
    );
    const bytes = new Uint8Array(readFileSync(screenshotPath));
    // File bytes are authoritative because pre-v9 rows have no stored format.
    const format = sniffEvidenceImageFormat(bytes) ?? run.screenshotFormat ?? "png";
    return {
      bytes,
      format,
      mediaType: mediaTypeForEvidenceImage(format),
      verdict: verdictFromStoredRun(input.revision, run),
    };
  } catch (cause) {
    if (cause instanceof FacetError) throw cause;
    throw evidenceUnavailable(input.artifact, input.revision, cause);
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
      artifactId: artifact.id,
      slug: artifact.slug,
      revisionSha: revision.sha256,
      artifactType: revision.artifactType,
      renderer: revision.renderer,
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
  const evidence = readStoredRenderEvidence({
    repository: input.repository,
    artifact,
    revision,
  });
  return ExportResultSchema.parse({
    command: "export",
    requestId: input.requestId,
    format: "render",
    bytes: Buffer.from(evidence.bytes).toString("base64"),
    sidecar: buildExportSidecar({
      artifactId: artifact.id,
      slug: artifact.slug,
      revisionSha: revision.sha256,
      artifactType: revision.artifactType,
      renderer: revision.renderer,
      verdict: evidence.verdict,
      format: "render",
      renderFormat: evidence.format,
      exportedAt: input.exportedAt ?? now(),
    }),
  });
}
