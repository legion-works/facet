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

interface DiagramRegionEngagementState {
  readonly activeRegion: string | null;
  readonly armedRegion: string | null;
}

type DiagramRegionEngagementEvent =
  | { readonly type: "pointerenter" | "pointerleave" | "activate"; readonly region: string }
  | { readonly type: "dismiss" };

type DiagramRegionEngagementTransition = (
  state: DiagramRegionEngagementState,
  event: DiagramRegionEngagementEvent,
) => DiagramRegionEngagementState;

beforeAll(async () => {
  ({ createRendererRegistry } = await import("../../src/gallery-web/frame/renderers/registry"));
  ({ installGalleryFrameApi } = await import("../../src/gallery-web/frame/runtime"));
});

test("diagram regions switch the active region only after the newly entered region is activated", async () => {
  const runtime = await import("../../src/gallery-web/frame/runtime");
  const transition = Reflect.get(runtime, "nextDiagramRegionEngagement") as
    | DiagramRegionEngagementTransition
    | undefined;

  expect(transition).toBeTypeOf("function");
  const next = transition!;
  const idle = { activeRegion: null, armedRegion: null };
  const armedA = next(idle, { type: "pointerenter", region: "A" });
  expect(armedA).toEqual({ activeRegion: null, armedRegion: "A" });
  expect(next(armedA, { type: "pointerleave", region: "A" })).toEqual(idle);
  const activeA = next(armedA, { type: "activate", region: "A" });
  expect(activeA).toEqual({ activeRegion: "A", armedRegion: null });
  const armedB = next(activeA, { type: "pointerenter", region: "B" });
  expect(armedB).toEqual({ activeRegion: "A", armedRegion: "B" });
  expect(next(armedB, { type: "activate", region: "B" })).toEqual({
    activeRegion: "B",
    armedRegion: null,
  });
  expect(next(activeA, { type: "dismiss" })).toEqual(idle);
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

const GESTURE_LISTENER_TYPES = [
  "wheel",
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
] as const;

/** Spy on one element's own addEventListener/removeEventListener — an own-property override shadows the prototype method, so this only observes calls against THIS element instance. */
function spyOnListeners(element: Element): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const originalAdd = element.addEventListener.bind(element);
  const originalRemove = element.removeEventListener.bind(element);
  Object.defineProperty(element, "addEventListener", {
    value: (type: string, ...rest: unknown[]) => {
      added.push(type);
      // oxlint-disable-next-line no-explicit-any
      return (originalAdd as any)(type, ...rest);
    },
    configurable: true,
  });
  Object.defineProperty(element, "removeEventListener", {
    value: (type: string, ...rest: unknown[]) => {
      removed.push(type);
      // oxlint-disable-next-line no-explicit-any
      return (originalRemove as any)(type, ...rest);
    },
    configurable: true,
  });
  return { added, removed };
}

// MUST-1 fix proof: native mode is not a listener that no-ops, it is
// the complete absence of the wheel/pointer listeners on the DOM —
// the shell-review mutation that replaced setGestureMode's install/
// remove with a no-op left this test failing (added stayed empty on
// panzoom entry, removed stayed empty on the way back to native).
test("gesture listeners are installed only in panzoom mode and fully removed in native mode", async () => {
  const shim = parseHTML("<!DOCTYPE html><html><body><main id='artifact'></main></body></html>");
  Object.defineProperty(shim.document, "implementation", { value: fakeImpl, configurable: true });
  globals["document"] = shim.document;
  globals["window"] = shim.window;
  const container = shim.document.getElementById("artifact")!;
  const spy = spyOnListeners(container);

  installGalleryFrameApi(createRendererRegistry([["markdown", async () => {}]]));
  const api = Reflect.get(shim.window, "__facetFrame") as GalleryFrameApi;
  const result = await api.render({
    artifactType: "markdown",
    renderer: "svg",
    bytes: new Uint8Array([1]),
  });

  // A fresh document artifact render defaults to native — zero gesture
  // listeners on the container, by construction not by early return.
  expect(result.gestureMode()).toBe("native");
  for (const type of GESTURE_LISTENER_TYPES) {
    expect(spy.added).not.toContain(type);
  }

  result.setGestureMode("panzoom");
  for (const type of GESTURE_LISTENER_TYPES) {
    expect(spy.added.filter((entry) => entry === type)).toHaveLength(1);
  }

  result.setGestureMode("native");
  for (const type of GESTURE_LISTENER_TYPES) {
    expect(spy.removed.filter((entry) => entry === type)).toHaveLength(1);
  }

  // Re-entering panzoom re-installs exactly once more (no leaked
  // duplicate listener from a missed removal).
  result.setGestureMode("panzoom");
  for (const type of GESTURE_LISTENER_TYPES) {
    expect(spy.added.filter((entry) => entry === type)).toHaveLength(2);
  }
});

// The artifact root's pointer-events must be suppressed in panzoom
// mode regardless of whether panzoom was the artifact's DEFAULT
// (mermaid/svg/chart render straight into it, no toggle click
// involved) or reached via the toolbar toggle. A raw SVG root is an
// SVGSVGElement, not an HTMLElement — a naive `instanceof HTMLElement`
// guard silently no-ops on exactly this default-panzoom path while
// still working for the html/tsx CSS-fallback toggle path (raw SVG
// anchors kept taking pointer focus while the shell toggle read
// latched).
test("default panzoom mode suppresses pointer-events on a raw SVG artifact root, not just the toggled path", async () => {
  const shim = parseHTML("<!DOCTYPE html><html><body><main id='artifact'></main></body></html>");
  Object.defineProperty(shim.document, "implementation", { value: fakeImpl, configurable: true });
  globals["document"] = shim.document;
  globals["window"] = shim.window;
  installGalleryFrameApi(
    createRendererRegistry([
      [
        "svg",
        async (ctx) => {
          const svg = ctx.container.ownerDocument.createElementNS(
            "http://www.w3.org/2000/svg",
            "svg",
          );
          svg.setAttribute("viewBox", "0 0 100 100");
          ctx.container.appendChild(svg);
        },
      ],
    ]),
  );
  const api = Reflect.get(shim.window, "__facetFrame") as GalleryFrameApi;
  const result = await api.render({
    artifactType: "svg",
    renderer: "svg",
    bytes: new Uint8Array([1]),
  });

  // svg is a STANDALONE_DIAGRAM_TYPES entry — panzoom is the default,
  // no toggle click needed to reach this state.
  expect(result.defaultGestureMode).toBe("panzoom");
  expect(result.gestureMode()).toBe("panzoom");
  const root = shim.document.getElementById("artifact")!.firstElementChild as SVGElement;
  expect(root.style.pointerEvents).toBe("none");

  result.setGestureMode("native");
  expect(root.style.pointerEvents).toBe("");
});

// Markdown appends a fragment directly into the container, which can
// produce MULTIPLE top-level siblings (e.g. a paragraph followed by a
// standalone link/control). Suppressing pointer-events on only
// `firstElementChild` left every later sibling interactive during a
// panzoom drag.
test("panzoom mode suppresses pointer-events on every top-level rendered sibling, not just the first", async () => {
  const shim = parseHTML("<!DOCTYPE html><html><body><main id='artifact'></main></body></html>");
  Object.defineProperty(shim.document, "implementation", { value: fakeImpl, configurable: true });
  globals["document"] = shim.document;
  globals["window"] = shim.window;
  installGalleryFrameApi(
    createRendererRegistry([
      [
        "markdown",
        async (ctx) => {
          const first = ctx.container.ownerDocument.createElement("p");
          first.textContent = "first block";
          const second = ctx.container.ownerDocument.createElement("a");
          second.textContent = "a link outside the first block";
          ctx.container.append(first, second);
        },
      ],
    ]),
  );
  const api = Reflect.get(shim.window, "__facetFrame") as GalleryFrameApi;
  const result = await api.render({
    artifactType: "markdown",
    renderer: "svg",
    bytes: new Uint8Array([1]),
  });

  const container = shim.document.getElementById("artifact")!;
  expect(container.children).toHaveLength(2);
  result.setGestureMode("panzoom");
  for (const child of Array.from(container.children)) {
    expect((child as HTMLElement).style.pointerEvents).toBe("none");
  }

  result.setGestureMode("native");
  for (const child of Array.from(container.children)) {
    expect((child as HTMLElement).style.pointerEvents).toBe("");
  }
});

// Sibling of the pointer-events guard above, on the zoom-transform
// path instead: an svg-type artifact whose root has no parseable
// `viewBox` fails `renderedSvg()`'s check and falls into the
// CSS-fallback `applyViewState` branch, but the root there is still an
// SVGElement rather than an HTMLElement. The same `instanceof
// HTMLElement` guard would silently skip the zoom transform on that
// root; the shared `.style` duck-type check covers it.
test("applyViewState scales a viewBox-less SVG artifact root through the CSS-fallback transform", async () => {
  const shim = parseHTML("<!DOCTYPE html><html><body><main id='artifact'></main></body></html>");
  Object.defineProperty(shim.document, "implementation", { value: fakeImpl, configurable: true });
  globals["document"] = shim.document;
  globals["window"] = shim.window;
  installGalleryFrameApi(
    createRendererRegistry([
      [
        "svg",
        async (ctx) => {
          const svg = ctx.container.ownerDocument.createElementNS(
            "http://www.w3.org/2000/svg",
            "svg",
          );
          // Deliberately no viewBox attribute — renderedSvg() returns
          // null for this root, routing applyViewState into the
          // CSS-fallback (else) branch instead of the native svg.svg.style.width path.
          ctx.container.appendChild(svg);
        },
      ],
    ]),
  );
  const api = Reflect.get(shim.window, "__facetFrame") as GalleryFrameApi;
  const result = await api.render({
    artifactType: "svg",
    renderer: "svg",
    bytes: new Uint8Array([1]),
  });

  result.applyViewState({ zoom: 2, panX: 0, panY: 0 });
  const root = shim.document.getElementById("artifact")!.firstElementChild as SVGElement;
  expect(root.style.transform).toBe("scale(2)");
  expect(root.style.transformOrigin).toBe("top left");
});
