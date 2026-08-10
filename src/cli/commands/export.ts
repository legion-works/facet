/**
 * `facet export` — fetch source or retained render bytes and write the
 * artifact plus its disclosure sidecar locally.
 *
 * Output paths and overwrite policy stay outside the wire request so the
 * service cannot be used as a general filesystem writer.
 */

import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";

import type { ExportFormat, ExportRequest } from "../../shared/contracts/commands/requests";
import { ExportRequestSchema } from "../../shared/contracts/commands/requests";
import type { ExportResult } from "../../shared/contracts/commands/results";
import type { ArtifactType } from "../../shared/contracts/artifact";
import { FacetError } from "../../shared/errors/facet-error";
import { generateRequestId } from "../../shared/util/time";

export interface ExportPaths {
  readonly artifactPath: string;
  readonly sidecarPath: string;
}

export function buildExportRequest(
  args: Readonly<Record<string, string | boolean>>,
): ExportRequest {
  const artifactId = args["artifact-id"];
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw new FacetError("invalid_request", "export: artifact id is required", {
      retryable: false,
    });
  }
  const revision = args["revision"];
  return ExportRequestSchema.parse({
    command: "export",
    requestId: generateRequestId(),
    artifactId,
    ...(typeof revision === "string" ? { revisionSha: revision } : {}),
    format: typeof args["format"] === "string" ? args["format"] : "source",
  });
}

export function extensionForExport(
  format: ExportFormat,
  artifactType: ArtifactType,
): ".md" | ".svg" | ".json" | ".png" {
  if (format === "render") return ".png";
  if (artifactType === "svg") return ".svg";
  if (artifactType === "chart") return ".json";
  return ".md";
}

function sidecarPathForArtifact(path: string): string {
  const extension = extname(path);
  return extension.length === 0
    ? `${path}.facet.json`
    : `${path.slice(0, -extension.length)}.facet.json`;
}

function sanitizeDerivedNamePart(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.\.+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80)
    .replace(/^[.-]+|[.-]+$/g, "");
}

function derivedSlug(result: ExportResult): string {
  return (
    sanitizeDerivedNamePart(result.sidecar.slug) ||
    sanitizeDerivedNamePart(result.sidecar.artifactId) ||
    "artifact"
  );
}

export function resolveExportPaths(
  result: ExportResult,
  outFlag: string | undefined,
  cwd: string,
): ExportPaths {
  const extension = extensionForExport(result.format, result.sidecar.artifactType);
  const artifactPath =
    outFlag === undefined
      ? resolve(cwd, `${derivedSlug(result)}-${result.sidecar.revisionSha.slice(0, 7)}${extension}`)
      : resolve(cwd, outFlag);
  return { artifactPath, sidecarPath: sidecarPathForArtifact(artifactPath) };
}

export function writeExportFiles(result: ExportResult, paths: ExportPaths, force: boolean): void {
  const artifactExistedBeforeWrite = existsSync(paths.artifactPath);
  const sidecarExistedBeforeWrite = existsSync(paths.sidecarPath);
  if (!force) {
    const existing = [
      artifactExistedBeforeWrite ? paths.artifactPath : null,
      sidecarExistedBeforeWrite ? paths.sidecarPath : null,
    ].filter((path): path is string => path !== null);
    if (existing.length > 0) {
      throw new FacetError(
        "invalid_request",
        `export output already exists: ${existing.join(", ")} (pass --force to replace)`,
        { retryable: false, details: { reason: "output_exists" } },
      );
    }
  }

  mkdirSync(dirname(paths.artifactPath), { recursive: true });
  mkdirSync(dirname(paths.sidecarPath), { recursive: true });
  for (const target of [paths.artifactPath, paths.sidecarPath]) {
    if (existsSync(target) && statSync(target).isDirectory()) {
      throw new Error(`export output is a directory: ${target}`);
    }
  }

  const artifactTempPath = join(
    dirname(paths.artifactPath),
    `.${basename(paths.artifactPath)}.${randomUUID()}.tmp`,
  );
  const sidecarTempPath = join(
    dirname(paths.sidecarPath),
    `.${basename(paths.sidecarPath)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(artifactTempPath, Buffer.from(result.bytes, "base64"), {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(sidecarTempPath, `${JSON.stringify(result.sidecar, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(artifactTempPath, paths.artifactPath);
    renameSync(sidecarTempPath, paths.sidecarPath);
  } catch (error) {
    for (const tempPath of [artifactTempPath, sidecarTempPath]) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Preserve the write or rename failure as the useful error at the CLI boundary.
      }
    }
    throw error;
  }
}
