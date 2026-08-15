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

// Gesture-mode defaults: standalone diagram artifacts (the whole
// document IS the diagram) start in pan/zoom; document artifacts start
// fully native (see the operator-escalated gesture ruling captured in
// `installGalleryFrameApi`). Each case gets a fresh shim document +
// registry so renders don't collide with the one-shot `render` guard.
for (const [artifactType, expected] of [
  ["mermaid", "panzoom"],
  ["svg", "panzoom"],
  ["chart", "panzoom"],
  ["markdown", "native"],
  ["html", "native"],
  ["tsx", "native"],
] as const) {
  test(`${artifactType} artifacts default to ${expected} gesture mode`, async () => {
    const shim = parseHTML("<!DOCTYPE html><html><body><main id='artifact'></main></body></html>");
    Object.defineProperty(shim.document, "implementation", { value: fakeImpl, configurable: true });
    globals["document"] = shim.document;
    globals["window"] = shim.window;
    installGalleryFrameApi(createRendererRegistry([[artifactType, async () => {}]]));
    const api = Reflect.get(shim.window, "__facetFrame") as GalleryFrameApi;
    const result = await api.render({
      artifactType,
      renderer: "svg",
      bytes: new Uint8Array([1]),
      ...(artifactType === "tsx" ? { execution: "static" as const } : {}),
    });
    expect(result.defaultGestureMode).toBe(expected);
    expect(result.gestureMode()).toBe(expected);
  });
}

test("setGestureMode toggles the frame between native and panzoom, independent of the artifact's default", async () => {
  const shim = parseHTML("<!DOCTYPE html><html><body><main id='artifact'></main></body></html>");
  Object.defineProperty(shim.document, "implementation", { value: fakeImpl, configurable: true });
  globals["document"] = shim.document;
  globals["window"] = shim.window;
  installGalleryFrameApi(createRendererRegistry([["markdown", async () => {}]]));
  const api = Reflect.get(shim.window, "__facetFrame") as GalleryFrameApi;
  const result = await api.render({
    artifactType: "markdown",
    renderer: "svg",
    bytes: new Uint8Array([1]),
  });
  expect(result.gestureMode()).toBe("native");
  result.setGestureMode("panzoom");
  expect(result.gestureMode()).toBe("panzoom");
  result.setGestureMode(result.defaultGestureMode);
  expect(result.gestureMode()).toBe("native");
});
