import { describe, expect, test } from "bun:test";

import { ExportSidecarSchema } from "../../src/shared/contracts/commands/results";
import {
  buildGallerySidecar,
  commitGalleryExportState,
  downloadBlob,
  renderFilename,
  sidecarFilename,
  sourceFilename,
  type GalleryExportState,
} from "../../src/gallery-web/export";
import { fetchGalleryEvidence, fetchGallerySource } from "../../src/gallery-web/app";

const revisionSha = "a".repeat(64);
const observed = {
  rendererRootSvgCount: 1,
  graphCount: 0,
  mermaidNodeCount: 0,
  visibleSvgCount: 1,
  opaqueRegionCount: 0,
  externalImageCount: 0,
  errorCount: 0,
};

const verdict = {
  status: "ok" as const,
  tier: 1 as const,
  artifactId: "artifact-1",
  revisionSha,
  observed,
  insecure: { level: 2 as const, reason: "manual insecure level 2" },
};

function state(overrides: Partial<GalleryExportState> = {}): GalleryExportState {
  return {
    artifactId: "artifact-1",
    revisionSha,
    slug: "example-slug",
    title: "Example",
    artifactType: "markdown",
    renderer: "svg",
    sourceBytes: new Uint8Array([35, 32, 101, 120, 97, 109, 112, 108, 101]),
    verdict,
    renderBytes: new Uint8Array([137, 80, 78, 71]),
    ...overrides,
  };
}

describe("gallery export helpers", () => {
  test("derive source, render, and sidecar filenames from the displayed revision", () => {
    expect(sourceFilename(state())).toBe("example-slug.md");
    expect(renderFilename(state())).toBe("example-slug.png");
    expect(sidecarFilename(state())).toBe("example-slug.facet.json");
    expect(sourceFilename(state({ artifactType: "chart" }))).toBe("example-slug.json");
    expect(sourceFilename(state({ artifactType: "tsx" }))).toBe("example-slug.tsx");
  });

  test("builds a schema-parsed source sidecar and preserves optional verdict fields", () => {
    const result = buildGallerySidecar(state(), "2026-08-17T01:02:03.000Z");
    expect(result).not.toBeNull();
    const parsed = ExportSidecarSchema.parse(result);
    expect(Object.keys(parsed).toSorted()).toEqual(
      Object.keys(ExportSidecarSchema.shape).toSorted(),
    );
    expect(parsed.format).toBe("source");
    expect(parsed.verdict).toEqual(verdict);
  });

  test("refuses to fabricate a sidecar when the displayed revision has no verdict", () => {
    expect(buildGallerySidecar(state({ verdict: null }), "2026-08-17T01:02:03.000Z")).toBeNull();
  });

  test("does not commit late evidence or a failed swap over the last completed revision", () => {
    const previous = state();
    const next = state({ revisionSha: "b".repeat(64), slug: "next" });
    expect(commitGalleryExportState(previous, next, { expired: true })).toBe(previous);
    expect(commitGalleryExportState(previous, next, { swapSucceeded: false })).toBe(previous);
    expect(commitGalleryExportState(previous, next)).toBe(next);
  });

  test("downloads a blob with the exact filename and revokes its object URL after click", () => {
    const globals = globalThis as Record<string, unknown>;
    const originalURL = globals.URL;
    const originalDocument = globals.document;
    const calls: string[] = [];
    const anchor = {
      href: "",
      download: "",
      click: () => calls.push("click"),
    };
    globals.URL = {
      createObjectURL: () => "blob:gallery-export",
      revokeObjectURL: (url: string) => calls.push(`revoke:${url}`),
    };
    globals.document = { createElement: (tag: string) => (tag === "a" ? anchor : null) };
    try {
      downloadBlob(
        globals.document as unknown as Document,
        "example-slug.png",
        new Uint8Array([1]),
        "image/png",
      );
      expect(anchor.download).toBe("example-slug.png");
      expect(calls).toEqual(["click", "revoke:blob:gallery-export"]);
    } finally {
      if (originalURL === undefined) delete globals.URL;
      else globals.URL = originalURL;
      if (originalDocument === undefined) delete globals.document;
      else globals.document = originalDocument;
    }
  });

  test("keeps published TSX source bytes separate from compiled frame bytes", async () => {
    const source = "export default function Showcase() { return <main>source</main>; }";
    const renderBytes = new Uint8Array([1, 2, 3, 4]);
    const handoff = {
      authorization: "Bearer token",
      artifactId: "artifact-1",
      revisionSha,
      lease: { leaseId: "lease-1", expiresAt: Date.now() + 60_000 },
      headers: new Headers(),
    };
    const result = await fetchGallerySource(
      "http://127.0.0.1:43123",
      handoff,
      revisionSha,
      (async () =>
        Response.json({
          artifactId: "artifact-1",
          revisionSha,
          slug: "tsx-showcase",
          title: "TSX showcase",
          artifactType: "tsx",
          renderer: "svg",
          source,
          renderBytesBase64: btoa(String.fromCharCode(...renderBytes)),
          verdict: null,
        })) as unknown as typeof fetch,
    );
    expect(new TextDecoder().decode(result.sourceBytes)).toBe(source);
    expect(result.bytes).toEqual(renderBytes);
  });

  test("rejects a 404 evidence response without the typed unavailable code", async () => {
    const handoff = {
      authorization: "Bearer token",
      artifactId: "artifact-1",
      revisionSha,
      lease: { leaseId: "lease-1", expiresAt: Date.now() + 60_000 },
      headers: new Headers(),
    };
    await expect(
      fetchGalleryEvidence("http://127.0.0.1:43123", handoff, revisionSha, (async () =>
        Response.json(
          { error: { code: "other_not_found" } },
          { status: 404 },
        )) as unknown as typeof fetch),
    ).rejects.toThrow("Gallery evidence fetch failed (404)");
  });
});
