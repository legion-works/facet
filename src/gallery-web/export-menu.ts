import {
  buildGallerySidecar,
  commitGalleryExportState,
  downloadBlob,
  renderFilename,
  sidecarFilename,
  sourceFilename,
  type GalleryExportState,
} from "./export";

export interface GalleryExportMenuOptions {
  readonly document: Document;
  readonly isExpired: () => boolean;
}

export interface GalleryExportMenuController {
  readonly getState: () => GalleryExportState | null;
  readonly setState: (next: GalleryExportState) => void;
  readonly sync: () => void;
}

export function disableGalleryExportMenu(document: Document): void {
  for (const id of ["facet-export-source", "facet-export-render", "facet-export-sidecar"]) {
    const item = document.getElementById(id) as HTMLButtonElement | null;
    if (item !== null) item.disabled = true;
  }
}

export function installGalleryExportMenu(
  options: GalleryExportMenuOptions,
): GalleryExportMenuController {
  const { document } = options;
  let state: GalleryExportState | null = null;
  const toggle = document.getElementById("facet-export-toggle");
  const menu = document.getElementById("facet-export-menu");
  const source = document.getElementById("facet-export-source") as HTMLButtonElement | null;
  const render = document.getElementById("facet-export-render") as HTMLButtonElement | null;
  const sidecar = document.getElementById("facet-export-sidecar") as HTMLButtonElement | null;
  const sync = (): void => {
    const terminal = options.isExpired();
    if (source !== null) source.disabled = terminal || state === null;
    if (render !== null) {
      const available = state?.renderBytes != null;
      render.disabled = terminal || !available;
      render.title = available ? "" : "no stored render";
    }
    if (sidecar !== null) {
      const available = state?.verdict != null;
      sidecar.disabled = terminal || !available;
      sidecar.title = available ? "" : "no stored verdict";
    }
  };
  toggle?.addEventListener("click", () => {
    if (options.isExpired() || menu === null) return;
    menu.hidden = !menu.hidden;
    toggle.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu === null || menu.hidden) return;
    menu.hidden = true;
    toggle?.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("click", (event) => {
    if (menu === null || menu.hidden) return;
    const target = event.target as Node | null;
    const wrapper = document.getElementById("facet-export");
    if (wrapper !== null && target !== null && wrapper.contains(target)) return;
    menu.hidden = true;
    toggle?.setAttribute("aria-expanded", "false");
  });
  source?.addEventListener("click", () => {
    if (state === null) return;
    downloadBlob(document, sourceFilename(state), state.sourceBytes, "application/octet-stream");
  });
  render?.addEventListener("click", () => {
    if (state?.renderBytes == null) return;
    downloadBlob(document, renderFilename(state), state.renderBytes, "image/png");
  });
  sidecar?.addEventListener("click", () => {
    if (state === null) return;
    const value = buildGallerySidecar(state, new Date().toISOString());
    if (value === null) return;
    downloadBlob(
      document,
      sidecarFilename(state),
      `${JSON.stringify(value, null, 2)}\n`,
      "application/json",
    );
  });
  sync();
  return {
    getState: () => state,
    setState: (next) => {
      state = commitGalleryExportState(state, next, { expired: options.isExpired() });
      sync();
    },
    sync,
  };
}
