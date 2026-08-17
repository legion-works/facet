import { buildExportSidecar, extensionForExport } from "../shared/export";
import type { ArtifactType } from "../shared/contracts/artifact-types";
import type { Renderer } from "../shared/contracts/artifact";
import type { ExportSidecar } from "../shared/contracts/commands/results";
import type { Verdict } from "../shared/contracts/validation";

export interface GalleryExportState {
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly slug: string;
  readonly title: string;
  readonly artifactType: ArtifactType;
  readonly renderer: Renderer;
  readonly sourceBytes: Uint8Array;
  readonly verdict: Verdict | null;
  readonly renderBytes: Uint8Array | null;
}

export function commitGalleryExportState(
  current: GalleryExportState | null,
  next: GalleryExportState,
  options: { readonly expired?: boolean; readonly swapSucceeded?: boolean } = {},
): GalleryExportState | null {
  if (options.expired === true || options.swapSucceeded === false) return current;
  return next;
}

export function sourceFilename(state: Pick<GalleryExportState, "slug" | "artifactType">): string {
  return `${state.slug}${extensionForExport("source", state.artifactType)}`;
}

export function renderFilename(state: Pick<GalleryExportState, "slug" | "artifactType">): string {
  return `${state.slug}${extensionForExport("render", state.artifactType)}`;
}

export function sidecarFilename(state: Pick<GalleryExportState, "slug">): string {
  return `${state.slug}.facet.json`;
}

export function buildGallerySidecar(
  state: GalleryExportState,
  exportedAt: string,
): ExportSidecar | null {
  if (state.verdict === null) return null;
  return buildExportSidecar({
    artifactId: state.artifactId,
    slug: state.slug,
    revisionSha: state.revisionSha,
    artifactType: state.artifactType,
    renderer: state.renderer,
    verdict: state.verdict,
    format: "source",
    exportedAt,
  });
}

export function downloadBlob(
  document: Document,
  filename: string,
  bytes: BlobPart,
  type: string,
): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
