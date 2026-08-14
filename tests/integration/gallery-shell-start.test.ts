import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { startGallery, type GalleryRuntime } from "../../src/gallery-web/app";
import { countPageShim } from "../../src/gallery-web/frame/renderers/registry";

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
  private parent: FakeElement | null = null;
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
    child.parent = this;
    this.children.push(child);
    // A real iframe fires `load` once mounted; the direct shell awaits
    // that event before touching contentWindow.
    if (child instanceof FakeIframe && child.autoLoadOnAppend) {
      queueMicrotask(() => child.emit("load"));
    }
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

  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

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

function pageShimObserved(body: string): ReturnType<typeof countPageShim> {
  const globals = globalThis as Record<string, unknown>;
  const previousDocument = globals.document;
  const { document } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  globals.document = document;
  try {
    return countPageShim();
  } finally {
    globals.document = previousDocument;
  }
}

type PageShimCounts = ReturnType<typeof countPageShim>;

interface FakeRenderResultShape {
  readonly observed: PageShimCounts;
  readonly viewMode: "native" | "css";
  readonly applyViewState: (state: { zoom: number; panX: number; panY: number }) => void;
  readonly readViewState: () => { zoom: number; panX: number; panY: number };
}

function makeRenderResult(
  viewMode: "native" | "css",
  observed: PageShimCounts,
): FakeRenderResultShape {
  let applied: { zoom: number; panX: number; panY: number } | null = null;
  return {
    observed,
    viewMode,
    applyViewState: (state) => {
      applied = { ...state };
    },
    readViewState: () => applied ?? { zoom: 1, panX: 0, panY: 0 },
  };
}

interface FakeFrameConfig {
  readonly viewMode: "native" | "css";
  readonly observed: PageShimCounts;
  /** Override the render promise (default: resolve immediately). */
  readonly render?: (payload: unknown) => Promise<FakeRenderResultShape>;
  /** Disable the auto `load` event fired on append (timeout-path tests). */
  readonly autoLoad?: boolean;
}

class FakeIframe extends FakeElement {
  autoLoadOnAppend = true;
  readonly receivedPayloads: unknown[] = [];
  readonly contentWindow: {
    __facetFrame?: { readonly render?: (payload: unknown) => Promise<unknown> };
  } = {};

  install(config: FakeFrameConfig): void {
    if (config.autoLoad === false) this.autoLoadOnAppend = false;
    // oxlint-disable-next-line no-underscore-dangle
    this.contentWindow.__facetFrame = {
      render: async (payload: unknown) => {
        this.receivedPayloads.push(payload);
        if (config.render !== undefined) return config.render(payload);
        return makeRenderResult(config.viewMode, config.observed);
      },
    };
  }
}

interface GalleryHarness {
  readonly runtime: GalleryRuntime;
  readonly elements: Map<string, FakeElement>;
  readonly requests: { url: string; init?: RequestInit }[];
  readonly documentListeners: Map<string, Listener>;
  readonly windowListeners: Map<string, Listener>;
  /** Every fake iframe created by the shell, in creation order. */
  readonly frames: FakeIframe[];
  /** Per-frame install scripts consumed in creation order (swap tests). */
  readonly pendingFrameConfigs: FakeFrameConfig[];
  readonly defaultObserved: PageShimCounts;
  /** Push a `revision:committed` SSE event into the live stream. */
  emitCommitted(event: { readonly revisionSha: string; readonly revisionNumber: number }): void;
}

function createRuntime(
  viewMode: "native" | "css" = "native",
  verdict: Record<string, unknown> | null = null,
  observed = pageShimObserved('<svg data-facet-renderer-root="true" viewBox="0 0 10 10"></svg>'),
): GalleryHarness {
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
    "facet-expired",
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
  const frames: FakeIframe[] = [];
  const pendingFrameConfigs: FakeFrameConfig[] = [];
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => {
      if (tag !== "iframe") return new FakeElement();
      const frame = new FakeIframe();
      const config = pendingFrameConfigs.shift();
      frame.install(config ?? { viewMode, observed });
      frames.push(frame);
      return frame;
    },
    addEventListener: (type: string, listener: Listener) => documentListeners.set(type, listener),
  };
  const windowListeners = new Map<string, Listener>();
  const sessionStorageData = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) =>
      sessionStorageData.has(key) ? (sessionStorageData.get(key) as string) : null,
    setItem: (key: string, value: string) => {
      sessionStorageData.set(key, value);
    },
    removeItem: (key: string) => {
      sessionStorageData.delete(key);
    },
    clear: () => sessionStorageData.clear(),
  };
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
    sessionStorage,
  };
  const requests: { url: string; init?: RequestInit }[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
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
    if (url.includes("/source")) {
      const revisionSha = new URL(url).searchParams.get("revisionSha") ?? "a".repeat(64);
      return Response.json({
        artifactId: "artifact-1",
        revisionSha,
        artifactType: "markdown",
        source: `# ${revisionSha.slice(0, 8)}`,
        verdict,
      });
    }
    if (url.endsWith("/stream")) return new Response(stream);
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
      fetch: fetchImpl,
    } as unknown as GalleryRuntime,
    elements,
    requests,
    documentListeners,
    windowListeners,
    frames,
    pendingFrameConfigs,
    defaultObserved: observed,
    emitCommitted(event) {
      const payload = {
        type: "revision:committed",
        artifactId: "artifact-1",
        artifactType: "markdown",
        at: new Date().toISOString(),
        ...event,
      };
      streamController?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function isIframe(child: FakeElement): child is FakeIframe {
  return child instanceof FakeIframe;
}

describe("gallery shell startup", () => {
  test("accepts the page-shim observation shape with and without HTML counts", async () => {
    const svgHarness = createRuntime();
    await startGallery(svgHarness.runtime);
    expect(svgHarness.elements.get("facet-status-line")?.textContent).toBe("displayed");

    const htmlHarness = createRuntime(
      "native",
      null,
      pageShimObserved(
        '<main data-facet-renderer-root="true"><h1>HTML artifact</h1><img src="https://example.com/report.png"></main>',
      ),
    );
    await startGallery(htmlHarness.runtime);
    expect(htmlHarness.elements.get("facet-status-line")?.textContent).toBe("displayed");
  });

  test("labels opaque and layout partial verdicts and reports opaque evidence", async () => {
    const harness = createRuntime("native", {
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

    const layoutHarness = createRuntime("native", {
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

  test("labels external-resource partial verdicts and reports HTML evidence", async () => {
    const harness = createRuntime("native", {
      status: "partial:external_resources",
      tier: 1,
      revisionSha: "a".repeat(64),
      artifactId: "artifact-1",
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        errorCount: 0,
        html: {
          rendererRootCount: 1,
          headingCount: 2,
          tableCount: 1,
          listCount: 1,
          imageCount: 3,
          canvasCount: 0,
          externalImageCount: 2,
        },
      },
    });
    await startGallery(harness.runtime);

    expect(
      harness.elements.get("facet-verdict")?.querySelector<FakeElement>(".tier")?.textContent,
    ).toBe("· external · T1");
    expect(harness.elements.get("facet-evidence-counts")?.textContent).toBe(
      "roots 1 · headings 2 · tables 1 · lists 1 · images 3 · canvas 0 · external 2",
    );
  });

  test("labels insecure verdicts and preserves the full L3 status", async () => {
    const harness = createRuntime("native", {
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
    const harness = createRuntime("native", {
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

  test("boots one frame, renders source, binds controls, and closes the SSE stream on unload", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);

    expect(harness.elements.get("facet-title")?.textContent).toBe("facet");
    expect(harness.elements.get("facet-revision")?.textContent).toBe("aaaaaaaaaaaa");
    expect(harness.elements.get("facet-status-line")?.textContent).toBe("displayed");
    expect(harness.elements.get("facet-live-label")?.textContent).toBe("live");
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
    // The shell no longer releases the lease on beforeunload — the lease
    // expires via the service's per-lease TTL, so a F5 refresh can reuse
    // it. Eagerly releasing would defeat the sessionStorage re-attach
    // path; the SSE stream closure still runs (the stream survives the
    // request log filter because its fetch is on the global `fetch`,
    // not the harness shim).
    expect(harness.requests.some(({ url }) => url.endsWith("/api/v1/gallery/release"))).toBe(false);
  });

  test("clears iframe CSS transforms after a frame selects native SVG viewBox zoom", async () => {
    const harness = createRuntime("native");
    await startGallery(harness.runtime);
    await Promise.resolve();

    const canvas = harness.elements.get("facet-canvas")!;
    const iframe = canvas.children[0] as FakeIframe;
    expect(canvas.dataset["viewMode"]).toBe("native");
    expect(iframe.style["transform"]).toBe("");
  });

  test("applies CSS transforms when the render result reports the css view mode", async () => {
    const harness = createRuntime("css");
    await startGallery(harness.runtime);
    await Promise.resolve();

    const canvas = harness.elements.get("facet-canvas")!;
    const iframe = canvas.children[0] as FakeIframe;
    expect(canvas.dataset["viewMode"]).toBe("css");
    expect(iframe.style["transform"]).toBe("translate(0px, 0px) scale(1)");
  });

  test("two rapid revision commits serialize: newest revision wins, exactly one frame at settle", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    const canvas = harness.elements.get("facet-canvas")!;

    // Script the two swap frames BEFORE the commits: the first commit's
    // render resolves only when released; the newest commit's resolves.
    let releaseFirstRender: (() => void) | null = null;
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: () =>
        new Promise((resolve) => {
          releaseFirstRender = () => resolve(makeRenderResult("native", harness.defaultObserved));
        }),
    });
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
    });

    const firstSha = "a2".padEnd(64, "a");
    const newestSha = "b2".padEnd(64, "b");
    harness.emitCommitted({ revisionSha: firstSha, revisionNumber: 2 });
    harness.emitCommitted({ revisionSha: newestSha, revisionNumber: 3 });
    // The first swap's frame is mounted off-screen; the newest commit
    // is queued behind it (latest-wins).
    await waitFor(() => canvas.children.filter(isIframe).length >= 2);
    expect(releaseFirstRender).not.toBeNull();
    expect(harness.elements.get("facet-revision")?.textContent).toBe("aaaaaaaaaaaa");
    releaseFirstRender!();
    await waitFor(
      () => harness.elements.get("facet-revision")?.textContent === newestSha.slice(0, 12),
    );
    // Exactly one frame remains — the intermediate swap's frame and the
    // initial frame were both removed; no orphan.
    const survivors = canvas.children.filter(isIframe);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toBe(harness.frames[2]);
    // The newest commit's bytes reached the frame, not the intermediate's.
    expect(harness.frames[2]!.receivedPayloads).toHaveLength(1);
    const payload = harness.frames[2]!.receivedPayloads[0] as { bytes: Uint8Array };
    expect(new TextDecoder().decode(payload.bytes)).toContain(newestSha.slice(0, 8));
  });
});
