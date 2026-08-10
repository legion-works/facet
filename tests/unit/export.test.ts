import { describe, expect, test } from "bun:test";

import type { Artifact, Revision } from "../../src/shared/contracts/artifact";
import type { Verdict } from "../../src/shared/contracts/validation";
import { buildExportSidecar } from "../../src/service/export";

const artifact: Artifact = {
  id: "artifact-1",
  projectId: "project-1",
  slug: "source-artifact",
  title: "Source artifact",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

const revision: Revision = {
  id: "revision-1",
  artifactId: artifact.id,
  revisionNumber: 1,
  parentRevisionId: null,
  artifactType: "markdown",
  renderer: "svg",
  source: new Uint8Array([35, 32, 115, 111, 117, 114, 99, 101]),
  sha256: "a".repeat(64),
  note: null,
  pinned: false,
  createdAt: "2026-08-10T00:00:00.000Z",
};

const observed = {
  rendererRootSvgCount: 1,
  graphCount: 0,
  mermaidNodeCount: 0,
  visibleSvgCount: 1,
  opaqueRegionCount: 0,
  errorCount: 0,
};

const exportedAt = "2026-08-10T01:02:03.000Z";

describe("buildExportSidecar", () => {
  test("omits optional insecure and screenshotError keys for a secure verdict", () => {
    const secureVerdict: Verdict = {
      status: "ok",
      tier: 0,
      artifactId: artifact.id,
      revisionSha: revision.sha256,
      observed,
    };
    const sidecar = buildExportSidecar({
      artifact,
      revision,
      verdict: secureVerdict,
      format: "source",
      exportedAt,
    });

    expect(JSON.stringify(sidecar)).toBe(
      JSON.stringify({
        artifactId: artifact.id,
        slug: artifact.slug,
        revisionSha: revision.sha256,
        artifactType: revision.artifactType,
        renderer: revision.renderer,
        verdict: secureVerdict,
        format: "source",
        exportedAt,
      }),
    );
    expect(JSON.stringify(sidecar)).not.toContain("insecure");
    expect(JSON.stringify(sidecar)).not.toContain("screenshotError");
  });

  test("preserves the stored insecure marker and screenshot error", () => {
    const insecureVerdict: Verdict = {
      status: "error",
      tier: 1,
      artifactId: artifact.id,
      revisionSha: revision.sha256,
      observed,
      insecure: { level: 2, reason: "tier1 unavailable" },
      screenshotError: { code: "screenshot_unavailable", message: "capture failed" },
    };

    const sidecar = buildExportSidecar({
      artifact,
      revision,
      verdict: insecureVerdict,
      format: "source",
      exportedAt,
    });

    expect(JSON.stringify(sidecar)).toBe(
      JSON.stringify({
        artifactId: artifact.id,
        slug: artifact.slug,
        revisionSha: revision.sha256,
        artifactType: revision.artifactType,
        renderer: revision.renderer,
        verdict: {
          status: insecureVerdict.status,
          tier: insecureVerdict.tier,
          artifactId: insecureVerdict.artifactId,
          revisionSha: insecureVerdict.revisionSha,
          observed: insecureVerdict.observed,
          screenshotError: insecureVerdict.screenshotError,
          insecure: insecureVerdict.insecure,
        },
        format: "source",
        exportedAt,
      }),
    );
    expect(sidecar.verdict.insecure).toEqual({ level: 2, reason: "tier1 unavailable" });
    expect(sidecar.verdict.screenshotError).toEqual({
      code: "screenshot_unavailable",
      message: "capture failed",
    });
  });
});
