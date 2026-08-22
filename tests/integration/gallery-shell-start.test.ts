import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { startGallery, type GalleryRuntime } from "../../src/gallery-web/app";
import { countPageShim } from "../../src/gallery-web/frame/renderers/registry";
import {
  EMPTY_VIEW_STATE,
  MAX_ZOOM,
  MIN_ZOOM,
  type ViewState,
} from "../../src/gallery-web/view-state";
import {
  installFakeFrameApi,
  makeFakeRenderResult,
  type FakeRenderResultShape,
} from "../helpers/fake-frame";
import { setDownloadBlobUrlForTests } from "../../src/gallery-web/export";

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly childNodes = [{ textContent: "" }];
  readonly classList = {
    add: (..._names: string[]) => undefined,
    toggle: (_name: string, _force?: boolean) => undefined,
  };
  textContent = "";
  hidden = false;
  private readonly listeners = new Map<string, Listener[]>();
  readonly children: FakeElement[] = [];
  private parent: FakeElement | null = null;
  private tier: FakeElement | null = null;
  private bar: FakeElement | null = null;

  private readonly attributes: Record<string, string> = {};

  setAttribute(name: string, value: string): void {
    if (name === "data-frame-id") this.dataset["frameId"] = value;
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  click(): void {
    this.emit("click");
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

class FakeLinkElement extends FakeElement {
  private currentHref = "";
  hrefWrites = 0;
  readonly hrefHistory: string[] = [];

  get href(): string {
    return this.currentHref;
  }

  set href(value: string) {
    this.currentHref = value;
    this.hrefWrites += 1;
    this.hrefHistory.push(value);
  }
}

class FakeCanvasElement extends FakeElement {
  width = 0;
  height = 0;
  readonly context = {
    fillStyle: "",
    font: "",
    textAlign: "center",
    textBaseline: "middle",
    fillText() {},
  };

  getContext(_kind: string): CanvasRenderingContext2D {
    return this.context as unknown as CanvasRenderingContext2D;
  }

  toDataURL(_kind: string): string {
    return `data:image/png;base64,${this.width}x${this.height}:${this.context.fillStyle}`;
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

interface FakeFrameConfig {
  readonly viewMode: "native" | "css";
  readonly observed: PageShimCounts;
  /** Override the render promise (default: resolve immediately). */
  readonly render?: (payload: unknown) => Promise<FakeRenderResultShape<PageShimCounts>>;
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
    installFakeFrameApi(this, config);
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
  /** Push a `stream:close` SSE event into the live stream. */
  emitStreamClose(reason: string): void;
  /** Notify the shell's prefers-color-scheme listener. */
  emitColorSchemeChange(matches: boolean): void;
  readonly colorSchemeListeners: Set<Listener>;
  readonly sessionStorage: { getItem(key: string): string | null };
}

interface RuntimeOptions {
  readonly bootstrapStatus?: number;
  readonly sourceStatus?: number;
  readonly evidenceStatus?: number;
  readonly evidenceGate?: Promise<void>;
}

function createRuntime(
  viewMode: "native" | "css" = "native",
  verdict: Record<string, unknown> | null = null,
  observed = pageShimObserved('<svg data-facet-renderer-root="true" viewBox="0 0 10 10"></svg>'),
  options: RuntimeOptions = {},
): GalleryHarness {
  const elements = new Map<string, FakeElement>();
  for (const id of [
    "facet-favicon",
    "facet-title",
    "facet-artifact-title",
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
    "facet-panzoom-toggle",
    "facet-theme-toggle",
    "facet-export",
    "facet-export-toggle",
    "facet-export-menu",
    "facet-export-source",
    "facet-export-render",
    "facet-export-sidecar",
    "facet-fullscreen",
  ])
    elements.set(id, id === "facet-favicon" ? new FakeLinkElement() : new FakeElement());
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
    title: "facet gallery",
    documentElement: new FakeElement(),
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => {
      if (tag === "canvas") return new FakeCanvasElement();
      if (tag !== "iframe") return new FakeElement();
      const frame = new FakeIframe();
      const config = pendingFrameConfigs.shift();
      frame.install(config ?? { viewMode, observed });
      frames.push(frame);
      return frame;
    },
    addEventListener: (type: string, listener: Listener) => documentListeners.set(type, listener),
  };
  (globalThis as Record<string, unknown>).document = document;
  const windowListeners = new Map<string, Listener>();
  const colorSchemeListeners = new Set<Listener>();
  let colorSchemeMatches = false;
  const matchMedia = (_query: string) => ({
    get matches(): boolean {
      return colorSchemeMatches;
    },
    addEventListener: (_type: string, listener: Listener) => colorSchemeListeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) =>
      colorSchemeListeners.delete(listener),
  });
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
      if (options.bootstrapStatus !== undefined)
        return new Response(null, { status: options.bootstrapStatus });
    if (url.endsWith("/bootstrap"))
      return Response.json({
        authorization: "Bearer session-token",
        artifactId: "artifact-1",
        revisionSha: "a".repeat(64),
        lease: { leaseId: "lease-1", expiresAt: Date.now() + 60_000 },
      });
    if (url.includes("/source")) {
      if (options.sourceStatus !== undefined)
        return new Response(null, { status: options.sourceStatus });
      const revisionSha = new URL(url).searchParams.get("revisionSha") ?? "a".repeat(64);
      return Response.json({
        artifactId: "artifact-1",
        revisionSha,
        slug: "source-artifact",
        title:
          revisionSha === "a".repeat(64) ? "Initial title" : `Title ${revisionSha.slice(0, 8)}`,
        artifactType: "markdown",
        source: `# ${revisionSha.slice(0, 8)}`,
        verdict:
          revisionSha === "a".repeat(64) || verdict === null
            ? verdict
            : { ...verdict, status: verdict.status === "ok" ? "error" : "ok" },
      });
    }
    if (url.includes("/evidence")) {
      if (options.evidenceStatus !== undefined)
        return new Response(null, { status: options.evidenceStatus });
      const revisionSha = new URL(url).searchParams.get("revisionSha") ?? "a".repeat(64);
      if (revisionSha !== "a".repeat(64) && options.evidenceGate !== undefined) {
        await options.evidenceGate;
      }
      if (revisionSha === "a".repeat(64))
        return Response.json({ error: { code: "evidence_unavailable" } }, { status: 404 });
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        status: 200,
        headers: { "content-type": "image/png" },
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
      matchMedia,
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
    emitStreamClose(reason) {
      const payload = {
        type: "stream:close",
        streamId: "stream-1",
        reason,
        at: new Date().toISOString(),
      };
      streamController?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
    },
    emitColorSchemeChange(matches) {
      colorSchemeMatches = matches;
      for (const listener of colorSchemeListeners) listener({ matches });
    },
    colorSchemeListeners,
    sessionStorage,
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
    expect(harness.elements.get("facet-artifact-title")?.textContent).toBe("Initial title");
    expect((harness.runtime.document as unknown as { title: string }).title).toBe(
      "Initial title · facet",
    );
    const favicon = harness.elements.get("facet-favicon") as FakeLinkElement;
    expect(favicon.href).toContain("data:image/png;base64,32x32:");
    expect(harness.elements.get("facet-revision")?.textContent).toBe("aaaaaaaaaaaa");
    expect(harness.elements.get("facet-status-line")?.textContent).toBe("displayed");
    expect(harness.elements.get("facet-live-label")?.textContent).toBe("live");
    expect(harness.elements.get("facet-title")?.dataset["cleared"]).toBe("yes");

    harness.documentListeners.get("keydown")?.({
      key: "ArrowRight",
      shiftKey: true,
      preventDefault() {},
    });
    harness.documentListeners.get("keydown")?.({
      key: "ArrowRight",
      shiftKey: true,
      preventDefault() {},
    });
    harness.elements.get("facet-fullscreen")?.emit("click");
    harness.windowListeners.get("beforeunload")?.({});
    await Promise.resolve();

    expect(harness.elements.get("facet-canvas")?.dataset["fullscreen"]).toBe("yes");
    // The shell no longer releases the lease on beforeunload — the lease
    // expires via the service's per-lease TTL, so a F5 refresh can reuse
    // it. Eagerly releasing would defeat the sessionStorage re-attach
    // path; the SSE stream closure still runs (the stream survives the
    // request log filter because its fetch is on the global `fetch`,
    // not the harness shim).
    expect(harness.requests.some(({ url }) => url.endsWith("/api/v1/gallery/release"))).toBe(false);
  });

  test("threads the shell resolved theme through initial and revision-swap frames", async () => {
    const harness = createRuntime();
    (
      harness.runtime as unknown as {
        currentResolvedTheme: () => "dark" | "light";
      }
    ).currentResolvedTheme = () => "light";

    await startGallery(harness.runtime);

    const initialFrame = harness.frames[0]!;
    expect(new URL(initialFrame.getAttribute("src")!).searchParams.get("theme")).toBe("light");
    expect(initialFrame.receivedPayloads).toEqual([expect.objectContaining({ theme: "light" })]);

    harness.emitCommitted({ revisionSha: "b2".padEnd(64, "b"), revisionNumber: 2 });
    await waitFor(
      () => harness.frames.length === 2 && harness.frames[1]!.receivedPayloads.length === 1,
    );

    const swappedFrame = harness.frames[1]!;
    expect(new URL(swappedFrame.getAttribute("src")!).searchParams.get("theme")).toBe("light");
    expect(swappedFrame.receivedPayloads).toEqual([expect.objectContaining({ theme: "light" })]);
  });

  test("system mode falls back to dark when matchMedia is unavailable", async () => {
    const harness = createRuntime();
    delete (harness.runtime as unknown as { matchMedia?: unknown }).matchMedia;
    await startGallery(harness.runtime);
    expect(
      (harness.runtime.document as unknown as { documentElement: FakeElement }).documentElement
        .dataset["theme"],
    ).toBe("dark");
  });

  test("theme toolbar cycles system, dark, and light while persisting the selected mode", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);

    const toggle = harness.elements.get("facet-theme-toggle")!;
    expect(toggle.textContent).toBe("theme: system");
    expect(toggle.dataset["themeMode"]).toBe("system");
    expect(
      (harness.runtime.document as unknown as { documentElement: FakeElement }).documentElement
        .dataset["theme"],
    ).toBe("light");
    expect(harness.colorSchemeListeners.size).toBe(1);

    toggle.click();
    await waitFor(
      () =>
        (harness.runtime.document as unknown as { documentElement: FakeElement }).documentElement
          .dataset["theme"] === "dark",
    );
    expect(toggle.textContent).toBe("theme: dark");
    expect(toggle.dataset["themeMode"]).toBe("dark");
    expect(
      (harness.runtime.document as unknown as { documentElement: FakeElement }).documentElement
        .dataset["theme"],
    ).toBe("dark");
    expect(JSON.parse(harness.sessionStorage.getItem("facet:gallery-session") ?? "{}").theme).toBe(
      "dark",
    );
    expect(harness.colorSchemeListeners.size).toBe(0);

    toggle.click();
    await waitFor(
      () =>
        (harness.runtime.document as unknown as { documentElement: FakeElement }).documentElement
          .dataset["theme"] === "light",
    );
    expect(toggle.textContent).toBe("theme: light");
    expect(JSON.parse(harness.sessionStorage.getItem("facet:gallery-session") ?? "{}").theme).toBe(
      "light",
    );

    toggle.click();
    await waitFor(
      () =>
        JSON.parse(harness.sessionStorage.getItem("facet:gallery-session") ?? "{}").theme ===
        "system",
    );
    expect(toggle.textContent).toBe("theme: system");
    expect(JSON.parse(harness.sessionStorage.getItem("facet:gallery-session") ?? "{}").theme).toBe(
      "system",
    );
    expect(harness.colorSchemeListeners.size).toBe(1);

    harness.emitColorSchemeChange(true);
    await waitFor(
      () =>
        (harness.runtime.document as unknown as { documentElement: FakeElement }).documentElement
          .dataset["theme"] === "dark",
    );
    expect(
      (harness.runtime.document as unknown as { documentElement: FakeElement }).documentElement
        .dataset["theme"],
    ).toBe("dark");

    harness.emitStreamClose("lease_expired");
    await waitFor(
      () => harness.elements.get("facet-status-line")?.textContent === "session expired",
    );
    expect(harness.colorSchemeListeners.size).toBe(0);
  });

  test("terminal expiry prevents a deferred theme swap from restoring gallery state", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    let releaseRender: (() => void) | null = null;
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: () =>
        new Promise((resolve) => {
          releaseRender = () => resolve(makeFakeRenderResult("native", harness.defaultObserved));
        }),
    });
    const toggle = harness.elements.get("facet-theme-toggle")!;
    toggle.click();
    await waitFor(
      () => harness.elements.get("facet-canvas")?.children.filter(isIframe).length === 2,
    );
    await waitFor(() => releaseRender !== null);

    const favicon = harness.elements.get("facet-favicon") as FakeLinkElement;
    harness.emitStreamClose("lease_expired");
    await waitFor(
      () => harness.elements.get("facet-status-line")?.textContent === "session expired",
    );
    const terminalFaviconWrites = favicon.hrefWrites;
    const terminalTheme = (harness.runtime.document as unknown as { documentElement: FakeElement })
      .documentElement.dataset["theme"];
    releaseRender!();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(harness.elements.get("facet-status-line")?.textContent).toBe("session expired");
    expect(harness.elements.get("facet-revision")?.textContent).toBe("aaaaaaaaaaaa");
    expect(harness.elements.get("facet-artifact-title")?.textContent).toBe("Initial title");
    expect((harness.runtime.document as unknown as { title: string }).title).toBe(
      "Initial title · facet",
    );
    expect(harness.sessionStorage.getItem("facet:gallery-session")).toBeNull();
    expect(
      (harness.runtime.document as unknown as { documentElement: FakeElement }).documentElement
        .dataset["theme"],
    ).toBe(terminalTheme);
    expect(favicon.hrefWrites).toBe(terminalFaviconWrites);
    expect(harness.elements.get("facet-canvas")?.children.filter(isIframe)).toHaveLength(1);
  });

  test("terminal expiry between theme render success and frame commit never restores session state", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    const swapBar = harness.elements.get("facet-swapbar")?.querySelector<FakeElement>(".bar");
    if (swapBar === null || swapBar === undefined) throw new Error("theme swap bar missing");
    const style = new Proxy(swapBar.style, {
      set(target, property, value) {
        target[property as string] = value as string;
        if (property === "width" && value === "80%") harness.emitStreamClose("lease_expired");
        return true;
      },
    });
    (swapBar as unknown as { style: Record<string, string> }).style = style;

    harness.elements.get("facet-theme-toggle")?.click();
    await waitFor(
      () => harness.elements.get("facet-status-line")?.textContent === "session expired",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(harness.sessionStorage.getItem("facet:gallery-session")).toBeNull();
    expect(
      (harness.runtime.document as unknown as { documentElement: FakeElement }).documentElement
        .dataset["theme"],
    ).toBe("light");
    expect(harness.elements.get("facet-canvas")?.children.filter(isIframe)).toHaveLength(1);
  });

  test("theme swaps preserve the current frame view state and unmount the old frame", async () => {
    const harness = createRuntime();
    const viewState = { zoom: 2.4, panX: 45, panY: -18 };
    const appliedViewState: { value: ViewState | null } = { value: null };
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: async () => ({
        observed: harness.defaultObserved,
        viewMode: "native",
        applyViewState: () => {},
        readViewState: () => ({ ...viewState }),
        defaultGestureMode: "native",
        gestureMode: () => "native",
        setGestureMode: () => {},
        resetDiagramRegions: () => {},
      }),
    });
    await startGallery(harness.runtime);
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: async () => ({
        observed: harness.defaultObserved,
        viewMode: "native",
        applyViewState: (next: ViewState) => {
          appliedViewState.value = next;
        },
        readViewState: () => ({ ...viewState }),
        defaultGestureMode: "native",
        gestureMode: () => "native",
        setGestureMode: () => {},
        resetDiagramRegions: () => {},
      }),
    });

    harness.elements.get("facet-theme-toggle")?.click();
    await waitFor(() => appliedViewState.value !== null);
    const restoredViewState = appliedViewState.value;
    if (restoredViewState === null) throw new Error("theme swap never restored the view state");
    expect(restoredViewState).toEqual(viewState);
    expect(harness.elements.get("facet-canvas")?.children.filter(isIframe)).toEqual([
      harness.frames[1]!,
    ]);
  });

  test("keeps render disabled without stored evidence and enables it after a completed revision swap", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    const render = harness.elements.get("facet-export-render")! as unknown as {
      disabled?: boolean;
      title?: string;
    };
    const sidecar = harness.elements.get("facet-export-sidecar")! as unknown as {
      disabled?: boolean;
      title?: string;
    };
    expect(render.disabled).toBe(true);
    expect(render.title).toBe("no stored render");
    expect(sidecar.disabled).toBe(true);
    expect(sidecar.title).toBe("no stored verdict");

    // Reuse the current harness's stream and source fixture; the later source
    // response remains unverified, while evidence returns PNG bytes.
    harness.pendingFrameConfigs.push({ viewMode: "native", observed: harness.defaultObserved });
    harness.emitCommitted({ revisionSha: "b2".padEnd(64, "b"), revisionNumber: 2 });
    await waitFor(() => render.disabled === false);
    expect(render.title).toBe("");
    expect(sidecar.disabled).toBe(true);
  });

  test("does not export stale source bytes while swapped revision evidence is unresolved", async () => {
    let evidenceStarted = false;
    let resolveEvidence!: () => void;
    const evidenceGate = new Promise<void>((resolve) => {
      resolveEvidence = () => {
        resolve();
      };
    });
    const harness = createRuntime("native", null, undefined, {
      evidenceGate: new Promise<void>((resolve) => {
        evidenceStarted = true;
        void evidenceGate.then(resolve);
      }),
    });
    const downloads: Blob[] = [];
    setDownloadBlobUrlForTests({
      createObjectURL: (blob) => {
        downloads.push(blob);
        return "blob:gallery-shell-start";
      },
      revokeObjectURL: () => undefined,
    });
    try {
      await startGallery(harness.runtime);
      const source = harness.elements.get("facet-export-source")!;
      expect((source as unknown as { disabled?: boolean }).disabled).toBe(false);
      harness.pendingFrameConfigs.push({ viewMode: "native", observed: harness.defaultObserved });
      harness.emitCommitted({ revisionSha: "b2".padEnd(64, "b"), revisionNumber: 2 });
      await waitFor(
        () =>
          evidenceStarted &&
          harness.elements.get("facet-artifact-title")?.textContent === "Title b2bbbbbb",
      );

      source.emit("click");
      expect(downloads).toHaveLength(0);

      resolveEvidence();
      await waitFor(() => (source as unknown as { disabled?: boolean }).disabled === false);
      source.emit("click");
      expect(downloads).toHaveLength(1);
      expect(new TextDecoder().decode(await downloads[0]!.arrayBuffer())).toBe("# b2bbbbbb");
    } finally {
      setDownloadBlobUrlForTests(undefined);
    }
  });

  test("sets idle grey before asynchronous bootstrap and tints the completed verdict", async () => {
    const harness = createRuntime("native", {
      status: "ok",
      tier: 0,
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
    const startup = startGallery(harness.runtime);
    const favicon = harness.elements.get("facet-favicon") as FakeLinkElement;
    expect(favicon.href).toContain("#77809a");
    expect(favicon.hrefWrites).toBe(1);
    await startup;
    expect(favicon.href).toContain("#86e1fc");
    expect(favicon.hrefWrites).toBe(2);
  });

  test("sets expired grey when bootstrap is already unauthorized", async () => {
    const harness = createRuntime("native", null, undefined, { bootstrapStatus: 401 });
    await startGallery(harness.runtime);

    const favicon = harness.elements.get("facet-favicon") as FakeLinkElement;
    expect(favicon.href).toContain("#77809a");
    expect(favicon.hrefWrites).toBe(2);
    expect(
      (harness.elements.get("facet-export-source") as unknown as { disabled?: boolean }).disabled,
    ).toBe(true);
    expect(
      (harness.elements.get("facet-export-sidecar") as unknown as { disabled?: boolean }).disabled,
    ).toBe(true);
  });

  test("sets expired grey when the initial source fetch is unauthorized", async () => {
    const harness = createRuntime("native", null, undefined, { sourceStatus: 401 });
    await startGallery(harness.runtime);

    const favicon = harness.elements.get("facet-favicon") as FakeLinkElement;
    expect(favicon.href).toContain("#77809a");
    expect(favicon.hrefWrites).toBe(2);
  });

  test("sets expired state when the initial evidence fetch is unauthorized", async () => {
    const harness = createRuntime("native", null, undefined, { evidenceStatus: 401 });
    await startGallery(harness.runtime);
    expect(harness.elements.get("facet-status-line")?.textContent).toBe("session expired");
    expect(
      (harness.elements.get("facet-export-render") as unknown as { disabled?: boolean }).disabled,
    ).toBe(true);
  });

  test("a stream:close with reason lease_expired renders the expired state and clears the session", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    expect(harness.sessionStorage.getItem("facet:gallery-session")).not.toBeNull();

    harness.emitStreamClose("lease_expired");
    await waitFor(
      () => harness.elements.get("facet-status-line")?.textContent === "session expired",
    );

    expect(harness.elements.get("facet-empty")?.hidden).toBe(true);
    expect(harness.elements.get("facet-status-line")?.textContent).toBe("session expired");
    expect(harness.elements.get("facet-error")?.textContent).toContain("session expired");
    expect(harness.sessionStorage.getItem("facet:gallery-session")).toBeNull();
    expect((harness.elements.get("facet-favicon") as FakeLinkElement).href).toContain("#77809a");
  });

  test("lease expiry closes an open export menu and resets its expanded ARIA state", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    const toggle = harness.elements.get("facet-export-toggle")!;
    const menu = harness.elements.get("facet-export-menu")!;
    menu.hidden = true;
    toggle.emit("click");
    expect(menu.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    harness.emitStreamClose("lease_expired");
    await waitFor(
      () => harness.elements.get("facet-status-line")?.textContent === "session expired",
    );

    expect(menu.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  test("lease expiry blocks shell view-state controls behind the terminal screen", async () => {
    const harness = createRuntime();
    let applied = 0;
    let gestureChanges = 0;
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: async () => ({
        observed: harness.defaultObserved,
        viewMode: "native",
        applyViewState: () => {
          applied += 1;
        },
        readViewState: () => EMPTY_VIEW_STATE,
        defaultGestureMode: "native",
        gestureMode: () => "native",
        setGestureMode: () => {
          gestureChanges += 1;
        },
        resetDiagramRegions: () => {},
      }),
    });
    await startGallery(harness.runtime);

    harness.emitStreamClose("lease_expired");
    await waitFor(
      () => harness.elements.get("facet-status-line")?.textContent === "session expired",
    );
    const stateAtExpiry = { applied, gestureChanges };
    harness.elements.get("facet-zoom-in")?.emit("click");
    harness.elements.get("facet-panzoom-toggle")?.emit("click");
    harness.elements.get("facet-zoom-reset")?.emit("click");

    expect(applied).toBe(stateAtExpiry.applied);
    expect(gestureChanges).toBe(stateAtExpiry.gestureChanges);
  });

  test("a stream:close with an unrelated reason stays idle and keeps the session", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);

    harness.emitStreamClose("client_disconnect");
    await waitFor(() => harness.elements.get("facet-live-label")?.textContent === "idle");

    expect(harness.elements.get("facet-expired")?.hidden).toBe(true);
    expect(harness.sessionStorage.getItem("facet:gallery-session")).not.toBeNull();
  });

  test("shell never CSS-transforms the iframe, and delegates view state to the frame document", async () => {
    const harness = createRuntime("css");
    let appliedState: any = null;
    harness.pendingFrameConfigs.push({
      viewMode: "css",
      observed: harness.defaultObserved,
      render: async () => ({
        observed: harness.defaultObserved,
        viewMode: "css",
        applyViewState: (state: any) => {
          appliedState = state;
        },
        readViewState: () => appliedState ?? EMPTY_VIEW_STATE,
        defaultGestureMode: "native",
        gestureMode: () => "native",
        setGestureMode: () => {},
        resetDiagramRegions: () => {},
      }),
    });
    await startGallery(harness.runtime);
    await Promise.resolve();

    const canvas = harness.elements.get("facet-canvas")!;
    const iframe = canvas.children[0] as FakeIframe;

    // Simulate a zoom intent via toolbar
    harness.elements.get("facet-zoom-in")?.emit("click");

    // The shell should NOT apply a transform to the iframe
    expect(iframe.style["transform"]).toBeUndefined();
    // The frame document should receive the view state directly
    expect(appliedState).not.toBeNull();
    expect(appliedState.zoom).toBeGreaterThan(1);
  });

  // The zoom button sitting at its clamp bound (0.25x / 8x) disables
  // instead of silently eating clicks, and re-enables the moment the
  // view state leaves that bound.
  test("the zoom-out/zoom-in buttons disable at their clamp bound and re-enable off it", async () => {
    const harness = createRuntime("css");
    const state = { zoom: 1 };
    harness.pendingFrameConfigs.push({
      viewMode: "css",
      observed: harness.defaultObserved,
      render: async () => ({
        observed: harness.defaultObserved,
        viewMode: "css",
        applyViewState: (next: any) => {
          state.zoom = next.zoom;
        },
        readViewState: () => ({ zoom: state.zoom, panX: 0, panY: 0 }),
        defaultGestureMode: "native",
        gestureMode: () => "native",
        setGestureMode: () => {},
        resetDiagramRegions: () => {},
      }),
    });
    await startGallery(harness.runtime);
    await Promise.resolve();

    const zoomOut = harness.elements.get("facet-zoom-out") as unknown as { disabled?: boolean };
    const zoomIn = harness.elements.get("facet-zoom-in") as unknown as { disabled?: boolean };
    expect(zoomOut.disabled).toBeFalsy();
    expect(zoomIn.disabled).toBeFalsy();

    // Drive to the min clamp (delta -0.1/click, clampZoom absorbs overshoot).
    for (let i = 0; i < 20; i += 1) harness.elements.get("facet-zoom-out")?.emit("click");
    expect(state.zoom).toBe(MIN_ZOOM);
    expect(zoomOut.disabled).toBe(true);
    expect(zoomIn.disabled).toBeFalsy();

    // A no-op click at the clamp must not throw and must stay clamped.
    harness.elements.get("facet-zoom-out")?.emit("click");
    expect(state.zoom).toBe(MIN_ZOOM);

    // Leaving the bound re-enables the button.
    harness.elements.get("facet-zoom-in")?.emit("click");
    expect(zoomOut.disabled).toBeFalsy();

    // Drive to the max clamp.
    for (let i = 0; i < 100; i += 1) harness.elements.get("facet-zoom-in")?.emit("click");
    expect(state.zoom).toBe(MAX_ZOOM);
    expect(zoomIn.disabled).toBe(true);
    expect(zoomOut.disabled).toBeFalsy();
  });

  // A no-op click handler (`result.setGestureMode(result.gestureMode())`)
  // leaves every other gallery test green because nothing else exercises
  // the toolbar toggle. This asserts the actual flip, not just that a
  // click was received.
  test("the pan/zoom toolbar toggle flips the frame's gesture mode both ways, and reset restores the default", async () => {
    const harness = createRuntime();
    // A mutable holder, not a bare `let` — TS narrows a closed-over
    // union-typed `let` to its last-seen literal across opaque calls
    // like `toggle.emit(...)`, which would make later `.toBe("panzoom")`
    // assertions a type error even though the runtime value does change.
    const gesture: { mode: "native" | "panzoom" } = { mode: "native" };
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: async () => ({
        observed: harness.defaultObserved,
        viewMode: "native",
        applyViewState: () => {},
        readViewState: () => EMPTY_VIEW_STATE,
        defaultGestureMode: "native",
        gestureMode: () => gesture.mode,
        setGestureMode: (mode: "native" | "panzoom") => {
          gesture.mode = mode;
        },
        resetDiagramRegions: () => {},
      }),
    });
    await startGallery(harness.runtime);
    await Promise.resolve();

    const toggle = harness.elements.get("facet-panzoom-toggle")!;
    // A markdown/html artifact's fresh render defaults to native — the
    // toggle starts unlatched.
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(gesture.mode).toBe("native");

    toggle.emit("click");
    expect(gesture.mode).toBe("panzoom");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    toggle.emit("click");
    expect(gesture.mode).toBe("native");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    // Reset exits pan/zoom mode back to the artifact's default and
    // un-latches the toggle.
    toggle.emit("click");
    expect(gesture.mode).toBe("panzoom");
    harness.elements.get("facet-zoom-reset")?.emit("click");
    expect(gesture.mode).toBe("native");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  test("two rapid revision commits serialize: newest revision wins, exactly one frame at settle", async () => {
    const harness = createRuntime("native", {
      status: "ok",
      tier: 0,
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
    await startGallery(harness.runtime);
    const canvas = harness.elements.get("facet-canvas")!;
    const favicon = harness.elements.get("facet-favicon") as FakeLinkElement;
    const initialFavicon = favicon.href;

    // Script the two swap frames BEFORE the commits: the first commit's
    // render resolves only when released; the newest commit's resolves.
    let releaseFirstRender: (() => void) | null = null;
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: () =>
        new Promise((resolve) => {
          releaseFirstRender = () =>
            resolve(makeFakeRenderResult("native", harness.defaultObserved));
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
    await waitFor(() => favicon.href.includes("#77809a"));
    // The first swap's frame is mounted off-screen; the newest commit
    // is queued behind it (latest-wins).
    await waitFor(() => canvas.children.filter(isIframe).length >= 2);
    expect(releaseFirstRender).not.toBeNull();
    expect(harness.elements.get("facet-revision")?.textContent).toBe("aaaaaaaaaaaa");
    releaseFirstRender!();
    await waitFor(
      () => harness.elements.get("facet-revision")?.textContent === newestSha.slice(0, 12),
    );
    expect(harness.elements.get("facet-artifact-title")?.textContent).toBe(
      `Title ${newestSha.slice(0, 8)}`,
    );
    expect((harness.runtime.document as unknown as { title: string }).title).toBe(
      `Title ${newestSha.slice(0, 8)} · facet`,
    );
    expect(favicon.href).not.toBe(initialFavicon);
    expect(favicon.href).toContain("#ff6e6e");
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

  test("queues a theme rerender behind a deferred revision swap and leaves one current frame", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    let releaseRevisionRender: (() => void) | null = null;
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: () =>
        new Promise((resolve) => {
          releaseRevisionRender = () =>
            resolve(makeFakeRenderResult("native", harness.defaultObserved));
        }),
    });

    const revisionSha = "b2".padEnd(64, "b");
    harness.emitCommitted({ revisionSha, revisionNumber: 2 });
    await waitFor(() => releaseRevisionRender !== null);
    harness.elements.get("facet-theme-toggle")?.click();
    releaseRevisionRender!();

    await waitFor(() => harness.frames.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const canvas = harness.elements.get("facet-canvas")!;
    expect(canvas.children.filter(isIframe)).toHaveLength(1);
    const current = canvas.children.filter(isIframe)[0] as FakeIframe;
    expect(current).toBe(harness.frames[2]!);
    expect(new URL(current.getAttribute("src")!).searchParams.get("theme")).toBe("dark");
    const payload = current.receivedPayloads[0] as { bytes: Uint8Array };
    expect(new TextDecoder().decode(payload.bytes)).toContain(revisionSha.slice(0, 8));
  });

  test("a later revision preserves a pending theme intent from an in-flight revision", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    let releaseFirstRevision!: () => void;
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: () =>
        new Promise((resolve) => {
          releaseFirstRevision = () =>
            resolve(makeFakeRenderResult("native", harness.defaultObserved));
        }),
    });
    const newestSha = "c3".padEnd(64, "c");
    harness.emitCommitted({ revisionSha: "b2".padEnd(64, "b"), revisionNumber: 2 });
    await waitFor(() => harness.frames.length === 2);

    harness.elements.get("facet-theme-toggle")?.click();
    harness.pendingFrameConfigs.push({ viewMode: "native", observed: harness.defaultObserved });
    harness.emitCommitted({ revisionSha: newestSha, revisionNumber: 3 });
    releaseFirstRevision();

    await waitFor(
      () => harness.frames.length >= 3 && harness.frames[2]!.receivedPayloads.length === 1,
    );

    const current = harness.frames[2]!;
    expect(new URL(current.getAttribute("src")!).searchParams.get("theme")).toBe("dark");
    expect(
      new TextDecoder().decode((current.receivedPayloads[0] as { bytes: Uint8Array }).bytes),
    ).toContain(newestSha.slice(0, 8));
    expect(
      (harness.runtime.document as unknown as { documentElement: FakeElement }).documentElement
        .dataset["theme"],
    ).toBe("dark");
  });

  test("a later theme intent preserves a pending revision behind an in-flight revision", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    let releaseFirstRevision!: () => void;
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: () =>
        new Promise((resolve) => {
          releaseFirstRevision = () =>
            resolve(makeFakeRenderResult("native", harness.defaultObserved));
        }),
    });
    const newestSha = "c3".padEnd(64, "c");
    harness.emitCommitted({ revisionSha: "b2".padEnd(64, "b"), revisionNumber: 2 });
    await waitFor(() => harness.frames.length === 2);

    harness.pendingFrameConfigs.push({ viewMode: "native", observed: harness.defaultObserved });
    harness.emitCommitted({ revisionSha: newestSha, revisionNumber: 3 });
    harness.elements.get("facet-theme-toggle")?.click();
    releaseFirstRevision();

    await waitFor(
      () => harness.frames.length >= 3 && harness.frames[2]!.receivedPayloads.length === 1,
    );

    const current = harness.frames[2]!;
    expect(new URL(current.getAttribute("src")!).searchParams.get("theme")).toBe("dark");
    expect(
      new TextDecoder().decode((current.receivedPayloads[0] as { bytes: Uint8Array }).bytes),
    ).toContain(newestSha.slice(0, 8));
    expect(
      (harness.runtime.document as unknown as { documentElement: FakeElement }).documentElement
        .dataset["theme"],
    ).toBe("dark");
  });

  test("a failed revision that absorbs a theme intent leaves the visible theme persisted", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    let releaseFirstRevision!: () => void;
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: () =>
        new Promise((resolve) => {
          releaseFirstRevision = () =>
            resolve(makeFakeRenderResult("native", harness.defaultObserved));
        }),
    });
    harness.emitCommitted({ revisionSha: "b2".padEnd(64, "b"), revisionNumber: 2 });
    await waitFor(() => harness.frames.length === 2);

    harness.elements.get("facet-theme-toggle")?.click();
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: async () =>
        makeFakeRenderResult("native", { ...harness.defaultObserved, errorCount: 1 }),
    });
    harness.emitCommitted({ revisionSha: "c3".padEnd(64, "c"), revisionNumber: 3 });
    releaseFirstRevision();

    await waitFor(() => harness.frames.length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(harness.elements.get("facet-canvas")?.children.filter(isIframe)).toEqual([
      harness.frames[1]!,
    ]);
    expect(JSON.parse(harness.sessionStorage.getItem("facet:gallery-session") ?? "{}").theme).toBe(
      "system",
    );
    expect(
      (harness.runtime.document as unknown as { documentElement: FakeElement }).documentElement
        .dataset["theme"],
    ).toBe("light");
  });

  test("a failed new frame sets the favicon to unverified grey", async () => {
    const harness = createRuntime("native", {
      status: "ok",
      tier: 0,
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
    await startGallery(harness.runtime);
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: { ...harness.defaultObserved, errorCount: 1 },
      render: async () =>
        makeFakeRenderResult("native", { ...harness.defaultObserved, errorCount: 1 }),
    });

    const favicon = harness.elements.get("facet-favicon") as FakeLinkElement;
    harness.emitCommitted({ revisionSha: "d2".padEnd(64, "d"), revisionNumber: 2 });
    await waitFor(() => favicon.hrefWrites === 4);
    expect(favicon.hrefHistory.map((href) => href.split(":").at(-1))).toEqual([
      "#77809a",
      "#86e1fc",
      "#77809a",
      "#77809a",
    ]);
    expect(favicon.hrefWrites).toBe(4);
    expect(favicon.href).toContain("#77809a");
  });

  test("two queued failed swaps preserve the last displayed export state", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    const source = harness.elements.get("facet-export-source") as unknown as { disabled?: boolean };
    expect(source.disabled).toBe(false);

    let releaseFirstRender: (() => void) | null = null;
    const failedObserved = { ...harness.defaultObserved, errorCount: 1 };
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: failedObserved,
      render: () =>
        new Promise((resolve) => {
          releaseFirstRender = () => resolve(makeFakeRenderResult("native", failedObserved));
        }),
    });
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: failedObserved,
      render: async () => makeFakeRenderResult("native", failedObserved),
    });

    harness.emitCommitted({ revisionSha: "b2".padEnd(64, "b"), revisionNumber: 2 });
    await waitFor(() => releaseFirstRender !== null);
    harness.emitCommitted({ revisionSha: "c2".padEnd(64, "c"), revisionNumber: 3 });
    releaseFirstRender!();

    await waitFor(() => harness.elements.get("facet-swapbar")?.dataset.failed === "");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(source.disabled).toBe(false);
  });

  test("terminal expiry blocks an in-flight swap completion from replacing the expired screen", async () => {
    const harness = createRuntime();
    await startGallery(harness.runtime);
    let releaseRender: (() => void) | null = null;
    harness.pendingFrameConfigs.push({
      viewMode: "native",
      observed: harness.defaultObserved,
      render: () =>
        new Promise((resolve) => {
          releaseRender = () => resolve(makeFakeRenderResult("native", harness.defaultObserved));
        }),
    });
    const revisionSha = "c2".padEnd(64, "c");
    harness.emitCommitted({ revisionSha, revisionNumber: 2 });
    await waitFor(
      () => harness.elements.get("facet-canvas")?.children.filter(isIframe).length === 2,
    );
    await waitFor(() => releaseRender !== null);
    const favicon = harness.elements.get("facet-favicon") as FakeLinkElement;
    const beforeExpiryWrites = favicon.hrefWrites;
    harness.emitStreamClose("lease_expired");
    await waitFor(
      () => harness.elements.get("facet-status-line")?.textContent === "session expired",
    );
    const terminalWrites = favicon.hrefWrites;
    expect(favicon.href).toContain("#77809a");
    expect(terminalWrites).toBe(beforeExpiryWrites + 1);
    releaseRender!();
    await waitFor(() => harness.frames[1]?.receivedPayloads.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(harness.elements.get("facet-status-line")?.textContent).toBe("session expired");
    expect(harness.elements.get("facet-revision")?.textContent).toBe("aaaaaaaaaaaa");
    expect(harness.elements.get("facet-artifact-title")?.textContent).toBe("Initial title");
    expect((harness.runtime.document as unknown as { title: string }).title).toBe(
      "Initial title · facet",
    );
    expect(favicon.href).toContain("#77809a");
    expect(favicon.hrefWrites).toBe(terminalWrites);
  });
});
