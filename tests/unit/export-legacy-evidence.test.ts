/**
 * Export tolerant-read test: legacy evidence root fallback.
 *
 * Pre explicit-threading default-XDG installs wrote Tier 1 evidence under the
 * legacy child-derived root (`<dataHome>/facet/evidence`) while the DB's
 * render-run rows stored absolute screenshot paths pointing there. After the
 * fix, the service's canonical root is the parent's `paths.evidence`. The
 * export path must still READ a screenshot that lives under the legacy root
 * (read-only tolerance) so an operator's existing evidence stays reachable —
 * without ever writing to the legacy root.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { openDatabase } from "../../src/service/store/database";
import { runMigrations } from "../../src/service/store/migrations";
import { ArtifactRepository } from "../../src/service/store/repository";
import { exportStoredRender } from "../../src/service/export";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

function seedRevision(repository: ArtifactRepository): { artifactId: string; revisionSha: string } {
  const project = repository.createProject({ projectRoot: "/facet" });
  const artifact = repository.createArtifact({
    projectId: project.id,
    slug: "legacy-evidence",
    title: "Legacy evidence",
  });
  const revision = repository.publishRevision({
    artifactId: artifact.id,
    artifactType: "markdown",
    source: new Uint8Array([1, 2, 3]),
  });
  return { artifactId: artifact.id, revisionSha: revision.sha256 };
}

describe("exportStoredRender — legacy evidence root tolerance", () => {
  test("reads a screenshot that lives under the legacy root when the canonical root is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "facet-export-legacy-"));
    const canonical = join(dir, "state", "evidence");
    const legacy = join(dir, "share", "evidence");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(legacy, { recursive: true });

    const db = openDatabase(join(dir, "facet.sqlite"));
    runMigrations(db);
    try {
      const repository = new ArtifactRepository(db, {
        evidenceRoot: canonical,
        legacyEvidenceRoot: legacy,
      });
      const { artifactId, revisionSha } = seedRevision(repository);
      const revision = repository.getRevisionBySha(artifactId, revisionSha);
      if (revision === null) throw new Error("missing seeded revision");

      const screenshotPath = join(legacy, artifactId, revisionSha, "run-1", "screenshot.png");
      mkdirSync(join(legacy, artifactId, revisionSha, "run-1"), { recursive: true });
      writeFileSync(screenshotPath, PNG_BYTES);
      repository.recordRenderRun({
        revisionId: revision.id,
        tier: 1,
        status: "ok",
        expected: {},
        observed: { rendererRootSvgCount: 1 },
        screenshotPath,
      });

      const result = exportStoredRender({
        repository,
        command: { command: "export", requestId: "r-1", artifactId, revisionSha, format: "render" },
        requestId: "r-1",
      });
      expect(result.format).toBe("render");
      expect(Buffer.from(result.bytes, "base64")).toEqual(Buffer.from(PNG_BYTES));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prefers the canonical root when the screenshot lives there (legacy ignored)", () => {
    const dir = mkdtempSync(join(tmpdir(), "facet-export-canonical-"));
    const canonical = join(dir, "state", "evidence");
    const legacy = join(dir, "share", "evidence");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(legacy, { recursive: true });

    const db = openDatabase(join(dir, "facet.sqlite"));
    runMigrations(db);
    try {
      const repository = new ArtifactRepository(db, {
        evidenceRoot: canonical,
        legacyEvidenceRoot: legacy,
      });
      const { artifactId, revisionSha } = seedRevision(repository);
      const revision = repository.getRevisionBySha(artifactId, revisionSha);
      if (revision === null) throw new Error("missing seeded revision");

      const screenshotPath = join(canonical, artifactId, revisionSha, "run-1", "screenshot.png");
      mkdirSync(join(canonical, artifactId, revisionSha, "run-1"), { recursive: true });
      writeFileSync(screenshotPath, PNG_BYTES);
      repository.recordRenderRun({
        revisionId: revision.id,
        tier: 1,
        status: "ok",
        expected: {},
        observed: { rendererRootSvgCount: 1 },
        screenshotPath,
      });

      const result = exportStoredRender({
        repository,
        command: { command: "export", requestId: "r-1", artifactId, revisionSha, format: "render" },
        requestId: "r-1",
      });
      expect(Buffer.from(result.bytes, "base64")).toEqual(Buffer.from(PNG_BYTES));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("still fails typed evidence_unavailable when the screenshot is in neither root", () => {
    const dir = mkdtempSync(join(tmpdir(), "facet-export-missing-"));
    const canonical = join(dir, "state", "evidence");
    const legacy = join(dir, "share", "evidence");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(legacy, { recursive: true });

    const db = openDatabase(join(dir, "facet.sqlite"));
    runMigrations(db);
    try {
      const repository = new ArtifactRepository(db, {
        evidenceRoot: canonical,
        legacyEvidenceRoot: legacy,
      });
      const { artifactId, revisionSha } = seedRevision(repository);
      const revision = repository.getRevisionBySha(artifactId, revisionSha);
      if (revision === null) throw new Error("missing seeded revision");

      repository.recordRenderRun({
        revisionId: revision.id,
        tier: 1,
        status: "ok",
        expected: {},
        observed: { rendererRootSvgCount: 1 },
        screenshotPath: join(dir, "elsewhere", "screenshot.png"),
      });

      expect(() =>
        exportStoredRender({
          repository,
          command: {
            command: "export",
            requestId: "r-1",
            artifactId,
            revisionSha,
            format: "render",
          },
          requestId: "r-1",
        }),
      ).toThrow(/evidence_unavailable|Screenshot evidence unavailable/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
