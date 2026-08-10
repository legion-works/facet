import { describe, expect, test } from "bun:test";

import { startGallery, type GalleryRuntime } from "../../src/gallery-web/app";

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly childNodes = [{ textContent: "" }];
  readonly classList = { add: (..._names: string[]) => undefined };
  textContent = "";
  hidden = false;
  private readonly listeners = new Map<string, Listener[]>();
  readonly children: FakeElement[] = [];
  private tier: FakeElement | null = null;
  private bar: FakeElement | null = null;

  setAttribute(name: string, value: string): void {
    if (name === "data-frame-id") this.dataset["frameId"] = value;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  appendChild(child: FakeElement): void {
    this.children.push(child);
    queueMicrotask(() => child.emit("load"));
  }

  querySelector<T>(selector: string): T | null {
    if (selector === ".tier") return this.tier as T | null;
    if (selector === ".bar") return this.bar as T | null;
    const frameId = selector.match(/^\[data-frame-id="(.+)"\]$/)?.[1];
    return (this.children.find((child) => child.dataset["frameId"] === frameId) ??
      null) as T | null;
  }

  attach(selector: ".tier" | ".bar", child: FakeElement): void {
    if (selector === ".tier") this.tier = child;
    else this.bar = child;
  }

  remove(): void {}
  setPointerCapture(_pointerId: number): void {}
  releasePointerCapture(_pointerId: number): void {}
  requestFullscreen(): Promise<void> {
    this.dataset["fullscreen"] = "yes";
    return Promise.resolve();
  }
  getBoundingClientRect(): DOMRect {
    return { left: 10, top: 20, width: 800, height: 600 } as DOMRect;
  }
}

class FakeIframe extends FakeElement {
  constructor(private readonly viewModeEvent: unknown) {
    super();
  }

  readonly contentWindow = {
    postMessage: (_message: unknown, _origin: string, ports: MessagePort[]) => {
      const [ingress, control] = ports;
      ingress!.addEventListener("message", () => {
        control!.postMessage(this.viewModeEvent, []);
        control!.postMessage(
          {
            type: "render-complete",
            observed: {
              rendererRootSvgCount: 1,
              graphCount: 0,
              mermaidNodeCount: 0,
              visibleSvgCount: 1,
              opaqueRegionCount: 0,
              errorCount: 0,
            },
          },
          [],
        );
      });
      ingress!.start();
      queueMicrotask(() => control!.postMessage({ type: "boot-ready" }, []));
    },
  };
}

function createRuntime(
  viewModeEvent: unknown = { type: "view-mode", mode: "native" },
  verdict: Record<string, unknown> | null = null,
) {
  const elements = new Map<string, FakeElement>();
  for (const id of [
    "facet-title",
    "facet-revision",
    "facet-status-line",
    "facet-error",
    "facet-evidence",
    "facet-evidence-counts",
    "facet-evidence-channels",
    "facet-evidence-sha",
    "facet-evidence-divergence",
    "facet-live",
    "facet-live-label",
    "facet-canvas",
    "facet-empty",
    "facet-zoom-in",
    "facet-zoom-out",
    "facet-zoom-reset",
    "facet-fullscreen",
  ])
    elements.set(id, new FakeElement());
  const verdictBadge = new FakeElement();
  verdictBadge.attach(".tier", new FakeElement());
  elements.set("facet-verdict", verdictBadge);
  const swapbar = new FakeElement();
  swapbar.attach(".bar", new FakeElement());
  elements.set("facet-swapbar", swapbar);

  const documentListeners = new Map<string, Listener>();
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) =>
      tag === "iframe" ? new FakeIframe(viewModeEvent) : new FakeElement(),
    addEventListener: (type: string, listener: Listener) => documentListeners.set(type, listener),
  };
  const windowListeners = new Map<string, Listener>();
  const window = {
    location: {
      origin: "http://127.0.0.1:43123",
      href: "http://127.0.0.1:43123/gallery#bootstrap=one-time",
      hostname: "127.0.0.1",
      pathname: "/gallery",
    },
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
    addEventListener: (type: string, listener: Listener) => windowListeners.set(type, listener),
  };
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, ...(init === undefined ? {} : { init }) });
    if (url.endsWith("/bootstrap"))
      return Response.json({
        authorization: "Bearer session-token",
        artifactId: "artifact-1",
        revisionSha: "a".repeat(64),
        lease: { leaseId: "lease-1", expiresAt: Date.now() + 60_000 },
      });
    if (url.includes("/source"))
      return Response.json({
        artifactId: "artifact-1",
        revisionSha: "a".repeat(64),
        artifactType: "markdown",
        source: "# shell",
        verdict,
      });
    if (url.endsWith("/stream")) return new Response(new ReadableStream());
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  return {
    runtime: {
      window,
      document,
      history: {
        replaceState: () => (elements.get("facet-title")!.dataset["cleared"] = "yes"),
      },
      HTMLElement: FakeElement,
      MessageChannel,
      fetch: fetchImpl,
    } as unknown as GalleryRuntime,
    elements,
    requests,
    documentListeners,
    windowListeners,
  };
}

describe("gallery shell startup", () => {
  test("labels opaque and layout partial verdicts and reports opaque evidence", async () => {
    const harness = createRuntime(undefined, {
      status: "partial:opaque_content",
      tier: 1,
      revisionSha: "a".repeat(64),
      artifactId: "artifact-1",
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 1,
        errorCount: 0,
      },
    });
    await startGallery(harness.runtime);

    const badge = harness.elements.get("facet-verdict")!;
    expect(badge.childNodes[0]?.textContent).toBe("partial");
    expect(badge.querySelector<FakeElement>(".tier")?.textContent).toBe("· opaque · T1");
    expect(badge.dataset["status"]).toBe("partial:opaque_content");
    expect(harness.elements.get("facet-evidence-counts")?.textContent).toContain("opaque 1");

    const layoutHarness = createRuntime(undefined, {
      status: "partial:layout_unverified",
      tier: 1,
      revisionSha: "a".repeat(64),
      artifactId: "artifact-1",
      observed: {
        rendererRootSvgCount: 1,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 1,
        opaqueRegionCount: 0,
        errorCount: 0,
      },
    });
    await startGallery(layoutHarness.runtime);
    expect(
      layoutHarness.elements.get("facet-verdict")?.querySelector<FakeElement>(".tier")?.textContent,
    ).toBe("· layout · T1");
  });

  test("labels insecure verdicts and preserves the full L3 status", async () => {
    const harness = createRuntime(undefined, {
      status: "insecure:unvalidated",
      tier: 0,
      revisionSha: "a".repeat(64),
      artifactId: "artifact-1",
      insecure: { level: 3, reason: "manual insecure level 3" },
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        errorCount: 0,
      },
    });
    await startGallery(harness.runtime);
    const badge = harness.elements.get("facet-verdict")!;
    expect(badge.dataset["status"]).toBe("insecure:unvalidated");
    expect(badge.querySelector<FakeElement>(".tier")?.textContent).toBe("· INSECURE L3 · T0");
  });

  test("composes opaque detail before the insecure marker and tier", async () => {
    const harness = createRuntime(undefined, {
      status: "partial:opaque_content",
      tier: 1,
      revisionSha: "a".repeat(64),
      artifactId: "artifact-1",
      insecure: { level: 2, reason: "manual insecure level 2" },
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 1,
        errorCount: 0,
      },
    });
    await startGallery(harness.runtime);
    expect(
      harness.elements.get("facet-verdict")?.querySelector<FakeElement>(".tier")?.textContent,
    ).toBe("· opaque · INSECURE L2 · T1");
  });

  test("boots one frame, renders source, binds controls, and releases its lease", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);

    expect(harness.elements.get("facet-title")?.textContent).toBe("facet");
    expect(harness.elements.get("facet-revision")?.textContent).toBe("aaaaaaaaaaaa");
    expect(harness.elements.get("facet-status-line")?.textContent).toBe("displayed");
    expect(harness.elements.get("facet-live-label")?.textContent).toBe("connecting");
    expect(harness.elements.get("facet-title")?.dataset["cleared"]).toBe("yes");

    let prevented = false;
    harness.elements.get("facet-canvas")?.emit("wheel", {
      preventDefault: () => (prevented = true),
      deltaY: -100,
      clientX: 410,
      clientY: 320,
    });
    harness.documentListeners.get("keydown")?.({
      key: "ArrowRight",
      shiftKey: true,
      preventDefault() {},
    });
    harness.elements.get("facet-fullscreen")?.emit("click");
    harness.windowListeners.get("beforeunload")?.({});
    await Promise.resolve();

    expect(prevented).toBe(true);
    expect(harness.elements.get("facet-canvas")?.dataset["fullscreen"]).toBe("yes");
    expect(harness.requests.some(({ url }) => url.endsWith("/api/v1/gallery/release"))).toBe(true);
  });

  test("clears iframe CSS transforms after a frame selects native SVG viewBox zoom", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    await Promise.resolve();

    const canvas = harness.elements.get("facet-canvas")!;
    const iframe = canvas.children[0] as FakeIframe;
    expect(canvas.dataset["viewMode"]).toBe("native");
    expect(iframe.style["transform"]).toBe("");
  });

  test("ignores a forged view-mode event with extra fields", async () => {
    const harness = createRuntime({ type: "view-mode", mode: "native", forged: true });
    await startGallery(harness.runtime);
    await Promise.resolve();

    const canvas = harness.elements.get("facet-canvas")!;
    const iframe = canvas.children[0] as FakeIframe;
    expect(canvas.dataset["viewMode"]).toBe("css");
    expect(iframe.style["transform"]).toBe("translate(0px, 0px) scale(1)");
  });
});
