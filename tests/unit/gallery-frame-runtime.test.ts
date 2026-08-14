import { beforeAll, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { GalleryFrameApi } from "../../src/gallery-web/frame/runtime";

const { document: shimDocument, window: shimWindow } = parseHTML(
  "<!DOCTYPE html><html><body><main id='artifact'></main></body></html>",
);
const fakeImpl = {
  createHTMLDocument: (html: string): Document =>
    (parseHTML(html) as unknown as { document: Document }).document,
};
Object.defineProperty(shimDocument, "implementation", { value: fakeImpl, configurable: true });
const globals = globalThis as Record<string, unknown>;
globals["document"] = shimDocument;
globals["window"] = shimWindow;
globals["Element"] = shimWindow.Element;
globals["HTMLElement"] = shimWindow.HTMLElement;
globals["Node"] = shimWindow.Node;
globals["DocumentFragment"] = shimWindow.DocumentFragment;
globals["HTMLTemplateElement"] = shimWindow.HTMLTemplateElement;

let createRendererRegistry: typeof import("../../src/gallery-web/frame/renderers/registry").createRendererRegistry;
let installGalleryFrameApi: typeof import("../../src/gallery-web/frame/runtime").installGalleryFrameApi;

beforeAll(async () => {
  ({ createRendererRegistry } = await import("../../src/gallery-web/frame/renderers/registry"));
  ({ installGalleryFrameApi } = await import("../../src/gallery-web/frame/runtime"));
});

test("installs a one-shot direct frame API that resolves renderer observations", async () => {
  installGalleryFrameApi(
    createRendererRegistry([
      [
        "markdown",
        async () => {
          shimDocument.getElementById("artifact")!.textContent = "rendered";
        },
      ],
    ]),
  );

  const api = Reflect.get(shimWindow, "__facetFrame") as GalleryFrameApi | undefined;
  expect(api).toBeDefined();

  const result = await api!.render({
    artifactType: "markdown",
    renderer: "svg",
    bytes: new Uint8Array([1, 2, 3]),
  });

  expect(result.observed.errorCount).toBe(0);
  expect(result.applyViewState).toBeTypeOf("function");
  await expect(
    api!.render({
      artifactType: "markdown",
      renderer: "svg",
      bytes: new Uint8Array([4, 5, 6]),
    }),
  ).rejects.toThrow(/already rendered/);
});
