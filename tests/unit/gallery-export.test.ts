import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { ExportSidecarSchema } from "../../src/shared/contracts/commands/results";
import {
  buildGallerySidecar,
  commitGalleryExportState,
  downloadBlob,
  renderFilename,
  sidecarFilename,
  sourceFilename,
  setDownloadBlobUrlForTests,
  type GalleryExportState,
} from "../../src/gallery-web/export";
import { fetchGalleryEvidence, fetchGallerySource } from "../../src/gallery-web/app";
import {
  disableGalleryExportMenu,
  installGalleryExportMenu,
} from "../../src/gallery-web/export-menu";

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
    renderBytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    renderFormat: "png",
    ...overrides,
  };
}

function exportMenuDom() {
  const dom = parseHTML(`<!doctype html><div id="facet-export">
    <button id="facet-export-toggle" aria-expanded="false"></button>
    <div id="facet-export-menu" hidden>
      <button id="facet-export-source"></button>
      <button id="facet-export-render"></button>
      <button id="facet-export-sidecar"></button>
    </div>
  </div>`);
  return dom;
}

describe("gallery export helpers", () => {
  test("derive source, render, and sidecar filenames from the displayed revision", () => {
    expect(sourceFilename(state())).toBe("example-slug.md");
    expect(renderFilename(state())).toBe("example-slug.png");
    expect(sidecarFilename(state())).toBe("example-slug.facet.json");
    expect(sourceFilename(state({ artifactType: "chart" }))).toBe("example-slug.json");
    expect(sourceFilename(state({ artifactType: "tsx" }))).toBe("example-slug.tsx");
  });

  test("uses the evidence response media type for WebP render downloads", () => {
    const { document, window } = exportMenuDom();
    let blob: Blob | undefined;
    setDownloadBlobUrlForTests({
      createObjectURL: (next) => {
        blob = next;
        return "blob:gallery-webp";
      },
      revokeObjectURL: () => {},
    });
    try {
      const controller = installGalleryExportMenu({ document, isExpired: () => false });
      const webpState: GalleryExportState = {
        ...state({ renderBytes: new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]) }),
        renderFormat: "webp",
      };
      controller.setState(webpState);
      (document.getElementById("facet-export-render") as HTMLButtonElement).dispatchEvent(
        new window.Event("click"),
      );
      expect(renderFilename(webpState)).toBe("example-slug.webp");
      expect(blob?.type).toBe("image/webp");
    } finally {
      setDownloadBlobUrlForTests(undefined);
    }
  });

  test("reads the evidence response content type", async () => {
    const handoff = {
      authorization: "Bearer token",
      artifactId: "artifact-1",
      revisionSha,
      lease: { leaseId: "lease-1", expiresAt: Date.now() + 60_000 },
      headers: new Headers(),
    };
    const evidence = await fetchGalleryEvidence(
      "http://127.0.0.1:43123",
      handoff,
      revisionSha,
      (async () =>
        new Response(new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]), {
          headers: { "content-type": "image/webp" },
        })) as unknown as typeof fetch,
    );
    expect(evidence).toMatchObject({ renderFormat: "webp" });
  });

  test("builds a schema-parsed source sidecar and preserves optional verdict fields", () => {
    const result = buildGallerySidecar(state(), "2026-08-17T01:02:03.000Z");
    expect(result).not.toBeNull();
    const parsed = ExportSidecarSchema.parse(result);
    expect(Object.keys(parsed).toSorted()).toEqual(
      [
        "artifactId",
        "slug",
        "revisionSha",
        "artifactType",
        "renderer",
        "verdict",
        "format",
        "exportedAt",
      ].toSorted(),
    );
    expect(parsed).not.toHaveProperty("renderFormat");
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
    const calls: string[] = [];
    const anchor = {
      href: "",
      download: "",
      click: () => calls.push("click"),
    };
    setDownloadBlobUrlForTests({
      createObjectURL: () => "blob:gallery-export",
      revokeObjectURL: (url: string) => calls.push(`revoke:${url}`),
    });
    try {
      downloadBlob(
        { createElement: (tag: string) => (tag === "a" ? anchor : null) } as unknown as Document,
        "example-slug.png",
        new Uint8Array([1]),
        "image/png",
      );
      expect(anchor.download).toBe("example-slug.png");
      expect(calls).toEqual(["click", "revoke:blob:gallery-export"]);
    } finally {
      setDownloadBlobUrlForTests(undefined);
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

  test("toggles the menu and closes it from Escape or an outside click", () => {
    const { document, window } = exportMenuDom();
    let expired = false;
    installGalleryExportMenu({ document, isExpired: () => expired });
    const toggle = document.getElementById("facet-export-toggle")!;
    const menu = document.getElementById("facet-export-menu")!;

    toggle.dispatchEvent(new window.Event("click"));
    expect(menu.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const escape = new window.Event("keydown");
    Object.defineProperty(escape, "key", { value: "Escape" });
    document.dispatchEvent(escape);
    expect(menu.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.dispatchEvent(new window.Event("click"));
    document.dispatchEvent(new window.Event("click"));
    expect(menu.hidden).toBe(true);
    expired = true;
    toggle.dispatchEvent(new window.Event("click"));
    expect(menu.hidden).toBe(true);
  });

  test("keeps menu clicks open and disabled export items inert until data exists", () => {
    const { document, window } = exportMenuDom();
    const controller = installGalleryExportMenu({ document, isExpired: () => false });
    const menu = document.getElementById("facet-export-menu")!;
    const source = document.getElementById("facet-export-source") as HTMLButtonElement;
    const render = document.getElementById("facet-export-render") as HTMLButtonElement;
    const sidecar = document.getElementById("facet-export-sidecar") as HTMLButtonElement;
    const wrapper = document.getElementById("facet-export")!;

    menu.hidden = false;
    menu.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(menu.hidden).toBe(false);
    expect(source.disabled).toBe(true);
    expect(render.disabled).toBe(true);
    expect(render.title).toBe("no stored render");
    expect(sidecar.disabled).toBe(true);
    expect(sidecar.title).toBe("no stored verdict");
    expect(controller.getState()).toBeNull();
    expect(wrapper.contains(menu)).toBe(true);
  });

  test("clears nullable state and disables every item after terminal expiry", () => {
    const { document } = exportMenuDom();
    let expired = false;
    const controller = installGalleryExportMenu({ document, isExpired: () => expired });
    const source = document.getElementById("facet-export-source") as HTMLButtonElement;
    const render = document.getElementById("facet-export-render") as HTMLButtonElement;
    const sidecar = document.getElementById("facet-export-sidecar") as HTMLButtonElement;

    controller.setState(state({ verdict: null, renderBytes: null }));
    expect(controller.getState()).not.toBeNull();
    expect(source.disabled).toBe(false);
    expect(render.disabled).toBe(true);
    expect(sidecar.disabled).toBe(true);
    controller.setState(null);
    expect(controller.getState()).toBeNull();
    expired = true;
    controller.setState(state());
    expect(controller.getState()).toBeNull();
    controller.clear();
    disableGalleryExportMenu(document);
    expect(source.disabled).toBe(true);
    expect(render.disabled).toBe(true);
    expect(sidecar.disabled).toBe(true);
  });
});
