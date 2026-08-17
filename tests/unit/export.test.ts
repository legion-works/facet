import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";

import type { Artifact, Revision } from "../../src/shared/contracts/artifact";
import type { ExportResult } from "../../src/shared/contracts/commands/results";
import { ExportSidecarSchema } from "../../src/shared/contracts/commands/results";
import type { Verdict } from "../../src/shared/contracts/validation";
import {
  buildExportRequest,
  extensionForExport as cliExtensionForExport,
  resolveExportPaths,
  writeExportFiles,
} from "../../src/cli/commands/export";
import {
  buildExportSidecar,
  extensionForExport as sharedExtensionForExport,
} from "../../src/shared/export";
import {
  buildExportSidecar as serviceBuildExportSidecar,
  readStoredRenderEvidence,
} from "../../src/service/export";

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
  externalImageCount: 0,
  errorCount: 0,
};

const exportedAt = "2026-08-10T01:02:03.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function validExportResultFor(
  artifactType: ExportResult["sidecar"]["artifactType"] = "markdown",
  slug = "source-artifact",
): ExportResult {
  return {
    command: "export",
    requestId: "request-1",
    format: "source",
    bytes: Buffer.from([0, 1, 2, 255]).toString("base64"),
    sidecar: {
      artifactId: "artifact-1",
      slug,
      revisionSha: "a".repeat(64),
      artifactType,
      renderer: "svg",
      verdict: {
        status: "ok",
        tier: 0,
        artifactId: "artifact-1",
        revisionSha: "a".repeat(64),
        observed,
      },
      format: "source",
      exportedAt,
    },
  };
}

describe("export CLI helpers", () => {
  test("exports the shared stored-render evidence reader", () => {
    expect(readStoredRenderEvidence).toBeTypeOf("function");
  });

  test("CLI and service surfaces consume the shared export helpers", () => {
    expect(cliExtensionForExport).toBe(sharedExtensionForExport);
    expect(serviceBuildExportSidecar).toBe(buildExportSidecar);
  });

  test("builds only service-owned request fields and defaults to source", () => {
    expect(
      buildExportRequest({ "artifact-id": "artifact-1", out: "out.md", force: true }),
    ).toMatchObject({
      command: "export",
      artifactId: "artifact-1",
      format: "source",
    });
    expect(
      buildExportRequest({
        "artifact-id": "artifact-1",
        revision: "a".repeat(64),
        format: "render",
      }),
    ).toMatchObject({
      command: "export",
      artifactId: "artifact-1",
      revisionSha: "a".repeat(64),
      format: "render",
    });
    expect(
      buildExportRequest({ "artifact-id": "artifact-1", out: "out.md", force: true }),
    ).not.toHaveProperty("out");
    expect(
      buildExportRequest({ "artifact-id": "artifact-1", out: "out.md", force: true }),
    ).not.toHaveProperty("force");
  });

  test("maps source artifact types and render to the CLI extension", () => {
    expect(cliExtensionForExport("source", "markdown")).toBe(".md");
    expect(cliExtensionForExport("source", "mermaid")).toBe(".md");
    expect(cliExtensionForExport("source", "svg")).toBe(".svg");
    expect(cliExtensionForExport("source", "chart")).toBe(".json");
    expect(cliExtensionForExport("source", "html")).toBe(".html");
    expect(cliExtensionForExport("source", "tsx")).toBe(".tsx");
    expect(cliExtensionForExport("render", "markdown")).toBe(".png");
  });

  test("resolves default, explicit, absolute, and extensionless output paths", () => {
    const result = validExportResultFor("markdown");
    expect(resolveExportPaths(result, undefined, "/tmp/facet-cwd")).toEqual({
      artifactPath: "/tmp/facet-cwd/source-artifact-aaaaaaa.md",
      sidecarPath: "/tmp/facet-cwd/source-artifact-aaaaaaa.facet.json",
    });
    expect(resolveExportPaths(result, "nested/custom.bin", "/tmp/facet-cwd")).toEqual({
      artifactPath: "/tmp/facet-cwd/nested/custom.bin",
      sidecarPath: "/tmp/facet-cwd/nested/custom.facet.json",
    });
    expect(resolveExportPaths(result, "/tmp/custom.svg", "/tmp/facet-cwd")).toEqual({
      artifactPath: "/tmp/custom.svg",
      sidecarPath: "/tmp/custom.facet.json",
    });
    expect(resolveExportPaths(result, "extensionless", "/tmp/facet-cwd").sidecarPath).toBe(
      "/tmp/facet-cwd/extensionless.facet.json",
    );
  });

  test("sanitizes hostile slugs before composing the derived default filename", () => {
    const cwd = "/tmp/facet-cwd";
    for (const slug of ["../../../etc/passwd", "/etc/evil", "embedded\nnewline"]) {
      const paths = resolveExportPaths(validExportResultFor("markdown", slug), undefined, cwd);
      const relativeArtifact = relative(cwd, paths.artifactPath);
      expect(isAbsolute(relativeArtifact)).toBe(false);
      expect(relativeArtifact.startsWith("../")).toBe(false);
      expect(paths.artifactPath.startsWith(`${cwd}/`)).toBe(true);
      expect(paths.artifactPath).not.toContain("\n");
    }
  });

  test("preflights the mandatory pair before writing when only the sidecar exists", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-export-cli-unit-"));
    tempDirs.push(root);
    const result = validExportResultFor();
    const paths = resolveExportPaths(result, join(root, "artifact.md"), root);
    writeFileSync(paths.sidecarPath, "existing sidecar\n");

    expect(() => writeExportFiles(result, paths, false)).toThrow(/already exists/);
    expect(existsSync(paths.artifactPath)).toBe(false);
    expect(readFileSync(paths.sidecarPath, "utf8")).toBe("existing sidecar\n");
  });

  test("preflights an existing artifact before writing when only the sidecar is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-export-cli-unit-"));
    tempDirs.push(root);
    const result = validExportResultFor();
    const paths = resolveExportPaths(result, join(root, "artifact.md"), root);
    writeFileSync(paths.artifactPath, "existing artifact\n");

    expect(() => writeExportFiles(result, paths, false)).toThrow(/already exists/);
    expect(readFileSync(paths.artifactPath, "utf8")).toBe("existing artifact\n");
    expect(existsSync(paths.sidecarPath)).toBe(false);
  });

  test("rolls back a fresh artifact when sidecar writing fails", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-export-cli-unit-"));
    tempDirs.push(root);
    const result = validExportResultFor();
    const paths = resolveExportPaths(result, join(root, "artifact.md"), root);
    mkdirSync(paths.sidecarPath);

    expect(() => writeExportFiles(result, paths, true)).toThrow();
    expect(existsSync(paths.artifactPath)).toBe(false);
    expect(existsSync(paths.sidecarPath)).toBe(true);
  });

  test("does not unlink a pre-existing artifact path when sidecar writing fails under force", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-export-cli-unit-"));
    tempDirs.push(root);
    const result = validExportResultFor();
    const paths = resolveExportPaths(result, join(root, "artifact.md"), root);
    writeFileSync(paths.artifactPath, "existing artifact\n");
    mkdirSync(paths.sidecarPath);

    expect(() => writeExportFiles(result, paths, true)).toThrow();
    expect(existsSync(paths.artifactPath)).toBe(true);
    expect(readFileSync(paths.artifactPath, "utf8")).toBe("existing artifact\n");
  });

  test("preserves a pre-existing artifact when the sidecar target is a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-export-cli-unit-"));
    tempDirs.push(root);
    const result = validExportResultFor();
    const paths = resolveExportPaths(result, join(root, "artifact.md"), root);
    writeFileSync(paths.artifactPath, "existing artifact\n");
    mkdirSync(paths.sidecarPath);

    expect(() => writeExportFiles(result, paths, true)).toThrow();
    expect(readFileSync(paths.artifactPath, "utf8")).toBe("existing artifact\n");
    expect(readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("rolls back the first rename when the second rename fails", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-export-cli-unit-"));
    tempDirs.push(root);
    const result = validExportResultFor();
    const paths = resolveExportPaths(result, join(root, "artifact.md"), root);
    let renameCalls = 0;
    const renameFile = (
      from: Parameters<typeof renameSync>[0],
      to: Parameters<typeof renameSync>[1],
    ) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error("simulated second rename failure");
      renameSync(from, to);
    };

    expect(() => writeExportFiles(result, paths, false, renameFile)).toThrow(
      "simulated second rename failure",
    );
    expect(renameCalls).toBe(2);
    expect(existsSync(paths.artifactPath)).toBe(false);
    expect(existsSync(paths.sidecarPath)).toBe(false);
    expect(readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("restores displaced artifact and sidecar content after a forced pair failure", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-export-cli-unit-"));
    tempDirs.push(root);
    const result = validExportResultFor();
    const paths = resolveExportPaths(result, join(root, "artifact.md"), root);
    writeFileSync(paths.artifactPath, "old artifact\n");
    writeFileSync(paths.sidecarPath, "old sidecar\n");
    let renameCalls = 0;
    const renameFile = (
      from: Parameters<typeof renameSync>[0],
      to: Parameters<typeof renameSync>[1],
    ) => {
      renameCalls += 1;
      if (renameCalls === 4) throw new Error("simulated second rename failure");
      renameSync(from, to);
    };

    expect(() => writeExportFiles(result, paths, true, renameFile)).toThrow(
      "simulated second rename failure",
    );
    expect(readFileSync(paths.artifactPath, "utf8")).toBe("old artifact\n");
    expect(readFileSync(paths.sidecarPath, "utf8")).toBe("old sidecar\n");
    expect(
      readdirSync(root).filter((name) => name.includes(".tmp") || name.includes(".bak")),
    ).toEqual([]);
  });

  test("writes unchanged bytes and a mandatory JSON sidecar, replacing both with force", () => {
    const root = mkdtempSync(join(tmpdir(), "facet-export-cli-unit-"));
    tempDirs.push(root);
    const result = validExportResultFor("chart");
    const paths = resolveExportPaths(result, join(root, "chart.json"), root);
    writeExportFiles(result, paths, true);

    expect(new Uint8Array(readFileSync(paths.artifactPath))).toEqual(
      new Uint8Array([0, 1, 2, 255]),
    );
    expect(JSON.parse(readFileSync(paths.sidecarPath, "utf8"))).toEqual(result.sidecar);
  });
});

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
      artifactId: artifact.id,
      slug: artifact.slug,
      revisionSha: revision.sha256,
      artifactType: revision.artifactType,
      renderer: revision.renderer,
      verdict: secureVerdict,
      format: "source",
      exportedAt,
    });

    expect(Object.keys(sidecar).toSorted()).toEqual(
      Object.keys(ExportSidecarSchema.shape).toSorted(),
    );

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
      artifactId: artifact.id,
      slug: artifact.slug,
      revisionSha: revision.sha256,
      artifactType: revision.artifactType,
      renderer: revision.renderer,
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

  test("preserves external-resource status and HTML observables in the export sidecar", () => {
    const htmlVerdict: Verdict = {
      status: "partial:external_resources",
      tier: 1,
      artifactId: artifact.id,
      revisionSha: revision.sha256,
      observed: {
        ...observed,
        html: {
          rendererRootCount: 1,
          headingCount: 2,
          tableCount: 1,
          listCount: 1,
          imageCount: 3,
          canvasCount: 0,
          externalImageCount: 2,
        },
      },
    };
    const sidecar = buildExportSidecar({
      artifactId: artifact.id,
      slug: artifact.slug,
      revisionSha: revision.sha256,
      artifactType: "html",
      renderer: revision.renderer,
      verdict: htmlVerdict,
      format: "source",
      exportedAt,
    });

    expect(sidecar.verdict.status).toBe("partial:external_resources");
    expect(sidecar.verdict.observed.html?.externalImageCount).toBe(2);
  });

  test("preserves the TSX execution marker; non-tsx verdicts omit it on the wire", () => {
    // The execution marker is emitted for TSX static and interactive
    // verdicts and ABSENT — not null — for every
    // other artifact type. The ExportSidecarSchema parses the
    // verdict through VerdictSchema, so this test confirms the
    // marker round-trips for TSX and is rejected for non-TSX.
    const tsxVerdict: Verdict = {
      status: "ok",
      tier: 1,
      artifactId: artifact.id,
      revisionSha: revision.sha256,
      observed,
      execution: "static",
    };
    const tsxSidecar = buildExportSidecar({
      artifactId: artifact.id,
      slug: artifact.slug,
      revisionSha: revision.sha256,
      artifactType: "tsx",
      renderer: revision.renderer,
      verdict: tsxVerdict,
      format: "source",
      exportedAt,
    });
    expect(tsxSidecar.verdict.execution).toBe("static");

    const nonTsxVerdict: Verdict = {
      status: "ok",
      tier: 1,
      artifactId: artifact.id,
      revisionSha: revision.sha256,
      observed,
    };
    const nonTsxSidecar = buildExportSidecar({
      artifactId: artifact.id,
      slug: artifact.slug,
      revisionSha: revision.sha256,
      artifactType: "markdown",
      renderer: revision.renderer,
      verdict: nonTsxVerdict,
      format: "source",
      exportedAt,
    });
    expect(nonTsxSidecar.verdict).not.toHaveProperty("execution");
    expect(JSON.stringify(nonTsxSidecar)).not.toContain('"execution"');
  });
});
