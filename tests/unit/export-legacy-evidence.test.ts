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

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { openDatabase } from "../../src/service/store/database";
import { runMigrations } from "../../src/service/store/migrations";
import { ArtifactRepository } from "../../src/service/store/repository";
import { resolveExportPaths } from "../../src/cli/commands/export";
import { exportStoredRender, readStoredRenderEvidence } from "../../src/service/export";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const WEBP_BYTES = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80, 1, 2, 3, 4]);

function seedRevision(
  repository: ArtifactRepository,
  slug = "legacy-evidence",
): { artifactId: string; revisionSha: string } {
  const project = repository.createProject({ projectRoot: `/facet/${slug}` });
  const artifact = repository.createArtifact({
    projectId: project.id,
    slug,
    title: slug,
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

      const artifact = repository.getArtifactById(artifactId);
      if (artifact === null) throw new Error("missing seeded artifact");
      const evidence = readStoredRenderEvidence({ repository, artifact, revision });
      expect(evidence.bytes).toEqual(PNG_BYTES);
      expect(evidence).toMatchObject({ format: "png", mediaType: "image/png" });
      expect(evidence.verdict).toMatchObject({
        artifactId,
        revisionSha,
        tier: 1,
        status: "ok",
      });

      const result = exportStoredRender({
        repository,
        command: { command: "export", requestId: "r-1", artifactId, revisionSha, format: "render" },
        requestId: "r-1",
      });
      expect(result.format).toBe("render");
      expect(Buffer.from(result.bytes, "base64")).toEqual(Buffer.from(PNG_BYTES));
      expect(result.sidecar).toMatchObject({ renderFormat: "png" });
      expect(resolveExportPaths(result, undefined, "/tmp/facet-cwd").artifactPath).toEndWith(
        ".png",
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps legacy PNG and WebP evidence exports format-correct in one store", () => {
    const dir = mkdtempSync(join(tmpdir(), "facet-export-mixed-format-"));
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
      const legacySeed = seedRevision(repository, "legacy-png");
      const webpSeed = seedRevision(repository, "new-webp");
      const legacyRevision = repository.getRevisionBySha(
        legacySeed.artifactId,
        legacySeed.revisionSha,
      );
      const webpRevision = repository.getRevisionBySha(webpSeed.artifactId, webpSeed.revisionSha);
      const legacyArtifact = repository.getArtifactById(legacySeed.artifactId);
      const webpArtifact = repository.getArtifactById(webpSeed.artifactId);
      if (
        legacyRevision === null ||
        webpRevision === null ||
        legacyArtifact === null ||
        webpArtifact === null
      )
        throw new Error("missing seeded record");

      const legacyPath = join(
        legacy,
        legacySeed.artifactId,
        legacySeed.revisionSha,
        "run-1",
        "screenshot.png",
      );
      const webpPath = join(
        canonical,
        webpSeed.artifactId,
        webpSeed.revisionSha,
        "run-1",
        "screenshot.webp",
      );
      mkdirSync(join(legacy, legacySeed.artifactId, legacySeed.revisionSha, "run-1"), {
        recursive: true,
      });
      mkdirSync(join(canonical, webpSeed.artifactId, webpSeed.revisionSha, "run-1"), {
        recursive: true,
      });
      writeFileSync(legacyPath, PNG_BYTES);
      writeFileSync(webpPath, WEBP_BYTES);
      repository.recordRenderRun({
        revisionId: legacyRevision.id,
        tier: 1,
        status: "ok",
        expected: {},
        observed: { rendererRootSvgCount: 1 },
        screenshotPath: legacyPath,
      });
      repository.recordRenderRun({
        revisionId: webpRevision.id,
        tier: 1,
        status: "ok",
        expected: {},
        observed: { rendererRootSvgCount: 1 },
        screenshotPath: webpPath,
        screenshotFormat: "webp",
      });

      const legacyEvidence = readStoredRenderEvidence({
        repository,
        artifact: legacyArtifact,
        revision: legacyRevision,
      });
      const webpEvidence = readStoredRenderEvidence({
        repository,
        artifact: webpArtifact,
        revision: webpRevision,
      });
      expect(legacyEvidence).toMatchObject({ format: "png", mediaType: "image/png" });
      expect(webpEvidence).toMatchObject({ format: "webp", mediaType: "image/webp" });

      const legacyResult = exportStoredRender({
        repository,
        command: {
          command: "export",
          requestId: "legacy-export",
          artifactId: legacySeed.artifactId,
          revisionSha: legacySeed.revisionSha,
          format: "render",
        },
        requestId: "legacy-export",
      });
      const webpResult = exportStoredRender({
        repository,
        command: {
          command: "export",
          requestId: "webp-export",
          artifactId: webpSeed.artifactId,
          revisionSha: webpSeed.revisionSha,
          format: "render",
        },
        requestId: "webp-export",
      });
      expect(legacyResult.sidecar).toMatchObject({ renderFormat: "png" });
      expect(webpResult.sidecar).toMatchObject({ renderFormat: "webp" });
      expect(resolveExportPaths(legacyResult, undefined, "/tmp/facet-cwd").artifactPath).toEndWith(
        ".png",
      );
      expect(resolveExportPaths(webpResult, undefined, "/tmp/facet-cwd").artifactPath).toEndWith(
        ".webp",
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses sniffed bytes instead of a disagreeing stored screenshot format", () => {
    const dir = mkdtempSync(join(tmpdir(), "facet-export-sniff-authority-"));
    const canonical = join(dir, "state", "evidence");
    mkdirSync(canonical, { recursive: true });
    const db = openDatabase(join(dir, "facet.sqlite"));
    runMigrations(db);
    try {
      const repository = new ArtifactRepository(db, { evidenceRoot: canonical });
      const seed = seedRevision(repository, "stored-format-lie");
      const revision = repository.getRevisionBySha(seed.artifactId, seed.revisionSha);
      const artifact = repository.getArtifactById(seed.artifactId);
      if (revision === null || artifact === null) throw new Error("missing seeded record");
      const screenshotPath = join(
        canonical,
        seed.artifactId,
        seed.revisionSha,
        "run-1",
        "screenshot.png",
      );
      mkdirSync(join(canonical, seed.artifactId, seed.revisionSha, "run-1"), { recursive: true });
      writeFileSync(screenshotPath, WEBP_BYTES);
      repository.recordRenderRun({
        revisionId: revision.id,
        tier: 1,
        status: "ok",
        expected: {},
        observed: { rendererRootSvgCount: 1 },
        screenshotPath,
        screenshotFormat: "png",
      });

      const evidence = readStoredRenderEvidence({ repository, artifact, revision });
      const result = exportStoredRender({
        repository,
        command: {
          command: "export",
          requestId: "format-lie",
          artifactId: seed.artifactId,
          revisionSha: seed.revisionSha,
          format: "render",
        },
        requestId: "format-lie",
      });
      expect(evidence).toMatchObject({ format: "webp", mediaType: "image/webp" });
      expect(result.sidecar).toMatchObject({ renderFormat: "webp" });
      expect(resolveExportPaths(result, undefined, "/tmp/facet-cwd").artifactPath).toEndWith(
        ".webp",
      );
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

  test("rejects a screenshot symlink that resolves outside both evidence roots", () => {
    const dir = mkdtempSync(join(tmpdir(), "facet-export-symlink-escape-"));
    const canonical = join(dir, "state", "evidence");
    const legacy = join(dir, "share", "evidence");
    const outside = join(dir, "outside.png");
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
      writeFileSync(outside, PNG_BYTES);
      symlinkSync(outside, screenshotPath);
      repository.recordRenderRun({
        revisionId: revision.id,
        tier: 1,
        status: "ok",
        expected: {},
        observed: { rendererRootSvgCount: 1 },
        screenshotPath,
      });

      const artifact = repository.getArtifactById(artifactId);
      if (artifact === null) throw new Error("missing seeded artifact");
      expect(() => readStoredRenderEvidence({ repository, artifact, revision })).toThrow(
        /evidence_unavailable|Screenshot evidence unavailable/,
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
