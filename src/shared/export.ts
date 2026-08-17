import type { ArtifactType } from "./contracts/artifact-types";
import type { ExportFormat, ExportSidecar } from "./contracts/commands";
import { ExportSidecarSchema } from "./contracts/commands/results";

const SOURCE_EXTENSION_BY_ARTIFACT = {
  markdown: ".md",
  mermaid: ".md",
  svg: ".svg",
  chart: ".json",
  html: ".html",
  tsx: ".tsx",
} as const satisfies Record<ArtifactType, ".md" | ".svg" | ".json" | ".html" | ".tsx">;

export function extensionForExport(
  format: ExportFormat,
  artifactType: ArtifactType,
): ".md" | ".svg" | ".json" | ".html" | ".tsx" | ".png" {
  return format === "render" ? ".png" : SOURCE_EXTENSION_BY_ARTIFACT[artifactType];
}

export function buildExportSidecar(input: ExportSidecar): ExportSidecar {
  return ExportSidecarSchema.parse(input);
}
