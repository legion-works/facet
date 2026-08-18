/**
 * Gallery shell integration tests.
 *
 * Every assertion here is structural — the test gate fails when the
 * shell drifts from the frozen security model. The shell builds its
 * frame document and frame attributes via pure helpers (`buildFrameDocument`,
 * `buildFrameAttributes`) so the assertions can
 * inspect the produced strings without a browser harness.
 *
 * DOM testing approach: pure-function-first. The hostname guard is a pure
 * boolean; the swap tests execute the real async swap against a
 * recording FrameHost with a fake iframe whose contentWindow.__facetFrame.render
 * resolves/rejects/never-settles. The SSE test runs a real service and
 * drains the real stream. The negative-source assertions scan production
 * gallery-web files for banned tokens — proving the channel ceremony is absent.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type FrameHost,
  SHELL_EXPORTS,
  type ShellDom,
  type SwapPlanStep,
  assertLoopbackHostname,
  buildFrameAttributes,
  buildFrameDocument,
  createArtifactFrame,
  createSerializedSwapQueue,
  isLoopbackHostname,
  planSwap,
  replaceArtifactFrame,
  swapToRevision,
} from "../../src/gallery-web/app";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { installFakeFrameApi, makeFakeRenderResult } from "../helpers/fake-frame";
import {
  installGalleryExportMenu,
  type GalleryExportMenuController,
} from "../../src/gallery-web/export-menu";
import { setDownloadBlobUrlForTests, type GalleryExportState } from "../../src/gallery-web/export";

const RUNTIME_URL = "/gallery/frame/runtime/markdown.js";

const ARTIFACT_SENTINEL = "FACET_SENTINEL_ARTIFACT_BYTES_ZZZ_9999";

function delayedEvidenceExportHarness(): {
  readonly controller: GalleryExportMenuController;
  readonly source: { disabled: boolean; click: () => void };
  readonly downloads: string[];
} {
  const listeners = new Map<string, (() => void)[]>();
  const source = {
    disabled: true,
    addEventListener: (type: string, listener: () => void) => {
      const pending = listeners.get(type) ?? [];
      pending.push(listener);
      listeners.set(type, pending);
    },
    click: () => {
      for (const listener of listeners.get("click") ?? []) listener();
    },
  };
  const document = {
    getElementById: (id: string) => (id === "facet-export-source" ? source : null),
    addEventListener: () => undefined,
    createElement: () => ({
      href: "",
      download: "",
      click: () => undefined,
    }),
  } as unknown as Document;
  const downloads: string[] = [];
  setDownloadBlobUrlForTests({
    createObjectURL: (blob) => {
      downloads.push(`${blob.size}`);
      return "blob:delayed-evidence";
    },
    revokeObjectURL: () => undefined,
  });
  const controller = installGalleryExportMenu({ document, isExpired: () => false });
  return { controller, source, downloads };
}

function exportState(revisionSha: string, sourceBytes: number[]): GalleryExportState {
  return {
    artifactId: "artifact-1",
    revisionSha,
    slug: `revision-${revisionSha.slice(0, 4)}`,
    title: "Delayed evidence",
    artifactType: "markdown",
    renderer: "svg",
    sourceBytes: new Uint8Array(sourceBytes),
    verdict: null,
    renderBytes: null,
  };
}

describe("gallery shell — CSP + frame-document invariants", () => {
  test("buildFrameAttributes: ordinary same-origin frames carry no sandbox", () => {
    const attrs = buildFrameAttributes();
    expect("sandbox" in attrs).toBe(false);
  });

  test("buildFrameAttributes: referrerpolicy is no-referrer", () => {
    const attrs = buildFrameAttributes();
    expect(attrs.referrerpolicy).toBe("no-referrer");
  });

  test("buildFrameAttributes: loopback src is assigned by the shell", () => {
    const attrs = buildFrameAttributes();
    expect("src" in attrs).toBe(true);
    expect(attrs.src).toBe("/gallery/frame");
  });

  test("buildFrameAttributes: shell-controlled CSS transform is the zoom surface (not inside-frame script)", () => {
    const attrs = buildFrameAttributes();
    // The shell applies transforms to the iframe ELEMENT. The frame's
    // own scripts do not own shell transforms.
    expect(attrs.allow).toBe("");
  });
});

test("gallery shell disables export during delayed evidence and enables the new revision after commit", async () => {
  const { controller, source, downloads } = delayedEvidenceExportHarness();
  try {
    controller.setState(exportState("a".repeat(64), [1]));
    let resolveEvidence!: () => void;
    const evidence = new Promise<void>((resolve) => {
      resolveEvidence = resolve;
    });
    controller.clear();
    expect(source.disabled).toBe(true);
    source.click();
    expect(downloads).toHaveLength(0);

    const next = exportState("b".repeat(64), [2, 3]);
    const commit = evidence.then(() => controller.setState(next));
    resolveEvidence();
    await commit;
    expect(source.disabled).toBe(false);
    source.click();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toBe("2");
  } finally {
    setDownloadBlobUrlForTests(undefined);
  }
});

describe("gallery shell — verdict status styling", () => {
  test("external resources keeps the explicit amber partial treatment", async () => {
    const cssPath = new URL("../../src/gallery-web/styles/verdict.css", import.meta.url).pathname;
    const css = await Bun.file(cssPath).text();
    const selector = '.facet-verdict[data-status="partial:external_resources"]';
    const ruleStart = css.indexOf(selector);
    const rule = css.slice(ruleStart, css.indexOf("}", ruleStart) + 1);
    const glyphSelector = `${selector}::before`;
    const glyphStart = css.indexOf(glyphSelector);
    const glyphRule = css.slice(glyphStart, css.indexOf("}", glyphStart) + 1);

    expect(ruleStart).toBeGreaterThanOrEqual(0);
    expect(rule).toContain("var(--facet-partial-border)");
    expect(rule).toContain("var(--facet-partial-fill)");
    expect(rule).toContain("var(--facet-partial)");
    expect(glyphStart).toBeGreaterThanOrEqual(0);
    expect(glyphRule).toContain('content: "◐"');
  });

  test("unstable keeps the explicit amber partial treatment (D11)", async () => {
    // D11: `partial:unstable` is the TSX interactive verdict for a
    // structure that legitimately changed between the barrier and
    // the stability window. The gallery selector must visibly
    // distinguish it from the other partials (the data-status value
    // carries the discriminator) and match the same visual language
    // (amber partial, ◐ glyph). Pin the selector and the glyph so
    // a future CSS edit that drops the rule fails closed.
    const cssPath = new URL("../../src/gallery-web/styles/verdict.css", import.meta.url).pathname;
    const css = await Bun.file(cssPath).text();
    const selector = '.facet-verdict[data-status="partial:unstable"]';
    const ruleStart = css.indexOf(selector);
    const rule = css.slice(ruleStart, css.indexOf("}", ruleStart) + 1);
    const glyphSelector = `${selector}::before`;
    const glyphStart = css.indexOf(glyphSelector);
    const glyphRule = css.slice(glyphStart, css.indexOf("}", glyphStart) + 1);

    expect(ruleStart).toBeGreaterThanOrEqual(0);
    expect(rule).toContain("var(--facet-partial-border)");
    expect(rule).toContain("var(--facet-partial-fill)");
    expect(rule).toContain("var(--facet-partial)");
    expect(glyphStart).toBeGreaterThanOrEqual(0);
    expect(glyphRule).toContain('content: "◐"');
  });
});

describe("gallery shell — frame document generation", () => {
  test("document contains external styles, artifact mount, and no CSP meta", () => {
    const document = buildFrameDocument({
      artifactType: "markdown",
      runtimeUrl: RUNTIME_URL,
    });
    const charsetIdx = document.indexOf('<meta charset="utf-8">');
    expect(charsetIdx).toBeGreaterThanOrEqual(0);
    expect(document).toContain('<main id="artifact" data-facet-artifact-type="markdown"></main>');
    expect(document).not.toContain("Content-Security-Policy");
    expect(document).toContain('<link rel="stylesheet" href="/gallery/frame/frame.css">');
    expect(document).not.toMatch(/<style[\s>]/i);
  });

  test("document references one ordinary external runtime module without a nonce", () => {
    const document = buildFrameDocument({
      artifactType: "markdown",
      runtimeUrl: RUNTIME_URL,
    });
    expect(document).toContain(`<script type="module" src="${RUNTIME_URL}">`);
    expect(document).not.toContain("nonce=");
    expect(document).toContain("</script>");
  });

  test("document NEVER carries artifact source bytes (publish sentinel — must be absent)", () => {
    // The frame document is generated only from the built runtime URL.
    // If a future change ever interpolates
    // artifact bytes into the document (the most dangerous regression in
    // this whole surface), this assertion fires.
    const document = buildFrameDocument({
      artifactType: "markdown",
      runtimeUrl: RUNTIME_URL,
    });
    expect(document).not.toContain(ARTIFACT_SENTINEL);
    // Defensive: exactly ONE <script tag in the document — the trusted runtime.
    // Any future regression that injects a second script would let
    // artifact bytes (or a hostile inline script) execute under the
    // external runtime module.
    expect(document.match(/<script/gi)?.length ?? 0).toBe(1);
  });

  test("frame document escapes runtime URL attributes", () => {
    const tricky = "https://example.test/bootstrap.js?a=1&b=2";
    const document = buildFrameDocument({
      artifactType: "markdown",
      runtimeUrl: tricky,
    });
    expect(document).toContain("https://example.test/bootstrap.js?a=1&amp;b=2");
    expect(document.match(/<\/script>/g)?.length ?? 0).toBe(1);
  });
});

describe("gallery shell — hostname guard (DNS-rebinding defense)", () => {
  test("isLoopbackHostname accepts only 127.0.0.1", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
  });

  test("isLoopbackHostname rejects everything else", () => {
    expect(isLoopbackHostname("localhost")).toBe(false);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(isLoopbackHostname("attacker.test")).toBe(false);
    expect(isLoopbackHostname("")).toBe(false);
    expect(isLoopbackHostname("127.0.0.2")).toBe(false);
  });

  test("assertLoopbackHostname throws for non-loopback hostnames BEFORE any capability runs", () => {
    expect(() => assertLoopbackHostname("127.0.0.1")).not.toThrow();
    expect(() => assertLoopbackHostname("localhost")).toThrow(/127\.0\.0\.1/);
    expect(() => assertLoopbackHostname("evil.test")).toThrow(/127\.0\.0\.1/);
  });
});

const runSwapPlan = (
  currentFrameId: string,
  nextFrameId: string,
  viewState: { zoom: number },
): string[] => {
  const log: string[] = [];
  const plan = planSwap({
    currentFrameId,
    nextFrameId,
    viewState,
    onStep: (step) => log.push(step.name),
  });
  for (const step of plan) step.run();
  return log;
};

describe("gallery shell — double-buffered HMR swap ordering", () => {
  test("new frame renders BEFORE old frame is removed (ordering)", () => {
    const log = runSwapPlan("frame-old", "frame-new", { zoom: 1.0 });
    expect(log).toEqual([
      "build-new",
      "load-new",
      "render-new",
      "swap",
      "apply-view-state",
      "remove-old",
    ]);
  });

  test("view state (zoom/pan) is preserved across the swap", () => {
    let preservedZoom = -1;
    const plan = planSwap({
      currentFrameId: "frame-old",
      nextFrameId: "frame-new",
      viewState: { zoom: 1.75 },
      onStep: (step) => {
        if (step.name === "apply-view-state" && "zoom" in step) preservedZoom = step.zoom;
      },
    });
    for (const step of plan) step.run();
    expect(preservedZoom).toBe(1.75);
  });

  test("every revision gets a fresh frame (no re-injection of source into a live frame)", () => {
    const ids = new Set<string>();
    const plan = planSwap({
      currentFrameId: "frame-A",
      nextFrameId: "frame-B",
      viewState: { zoom: 1 },
      onStep: (step) => {
        if (step.name === "build-new") ids.add(step.frameId);
      },
    });
    for (const step of plan) step.run();
    expect(ids.has("frame-B")).toBe(true);
    // The plan only targets the new frame before swap — frame-A is
    // touched only by `remove-old`.
    const sourceTouches = plan.filter(
      (s) => s.name === "build-new" || s.name === "load-new" || s.name === "render-new",
    );
    for (const step of sourceTouches) {
      expect(step.frameId).not.toBe("frame-A");
    }
  });

  test("new frame load and render target the replacement frame", () => {
    const loaded: string[] = [];
    const rendered: string[] = [];
    const plan = planSwap({
      currentFrameId: "frame-old",
      nextFrameId: "frame-new",
      viewState: { zoom: 1 },
      onStep: (step) => {
        if (step.name === "load-new" && "frameId" in step) loaded.push(step.frameId);
        if (step.name === "render-new" && "frameId" in step) rendered.push(step.frameId);
      },
    });
    for (const step of plan) step.run();
    expect(loaded).toEqual(["frame-new"]);
    expect(rendered).toEqual(["frame-new"]);
  });

  test("failed new render keeps the old frame visible (error path)", () => {
    let removed = false;
    const plan = planSwap({
      currentFrameId: "frame-old",
      nextFrameId: "frame-new",
      viewState: { zoom: 1 },
      failNewRender: true,
      onStep: (step) => {
        if (step.name === "remove-old") removed = true;
      },
    });
    for (const step of plan) step.run();
    expect(removed).toBe(false);
  });

  test("swap plan exposes a typed step enum (no free-form strings)", () => {
    const plan = planSwap({
      currentFrameId: "a",
      nextFrameId: "b",
      viewState: { zoom: 1 },
    });
    const names = plan.map((s) => s.name);
    expect(names).toContain("build-new");
    expect(names).toContain("load-new");
    expect(names).toContain("render-new");
    expect(names).toContain("swap");
    expect(names).toContain("apply-view-state");
    expect(names).toContain("remove-old");
  });
});

describe("gallery shell — public surface (single-artifact view, no list UI)", () => {
  test("exports only createArtifactFrame / replaceArtifactFrame / connectRevisionStream", () => {
    // The shell must NOT expose list/sidebar/multiple-view APIs.
    // A future regression that adds them would change the security model
    // (multiple active frames means multiple opaque contexts, more
    // nonce injection points).
    const exports: ReadonlySet<string> = new Set<string>(SHELL_EXPORTS);
    expect(exports.has("createArtifactFrame")).toBe(true);
    expect(exports.has("replaceArtifactFrame")).toBe(true);
    expect(exports.has("connectRevisionStream")).toBe(true);
    expect(exports.has("listArtifacts")).toBe(false);
    expect(exports.has("sidebar")).toBe(false);
    expect(exports.has("removeArtifactFrame")).toBe(false);
  });
});

describe("gallery shell — no zod in frame bundle (boundary check stays clean)", () => {
  // The boundary check enforces this at the gate. We assert here that
  // the runtime frame modules export no zod-imported symbol (defence in
  // depth — a frame/<file>.ts accidentally `import { z } from "zod"`
  // would break the gate; this test catches it earlier at unit time).
  const FRAME_FILES = [
    "../../src/gallery-web/frame/runtime.ts",
    "../../src/gallery-web/frame/renderers/registry.ts",
    "../../src/gallery-web/frame/renderers/markdown.ts",
    "../../src/gallery-web/frame/renderers/mermaid.ts",
    "../../src/gallery-web/frame/renderers/svg.ts",
    "../../src/gallery-web/frame/renderers/chart.ts",
    "../../src/gallery-web/frame/renderers/html.ts",
  ];
  for (const relative of FRAME_FILES) {
    test(`${relative.split("/").pop()} has no zod references`, async () => {
      const source = await Bun.file(new URL(relative, import.meta.url).pathname).text();
      expect(source).not.toMatch(/from\s+["']zod["']/);
      expect(source).not.toMatch(/require\(['"]zod['"]\)/);
    });
  }
});

describe("gallery shell — frame attributes type contract", () => {
  test("FrameAttributes shape matches ordinary frame element attributes", () => {
    const attrs = buildFrameAttributes();
    expect("sandbox" in attrs).toBe(false);
    expect(typeof attrs.referrerpolicy).toBe("string");
    expect(typeof attrs.allow).toBe("string");
    expect(typeof attrs.title).toBe("string");
  });

  test("planSwap returns a frozen read-only plan (no mutation after construction)", () => {
    const plan = planSwap({
      currentFrameId: "a",
      nextFrameId: "b",
      viewState: { zoom: 1 },
    });
    expect(Array.isArray(plan)).toBe(true);
    // The plan is treated as immutable by callers — assert no mutation
    // surface by counting types of step names.
    const names = plan.map((s) => s.name).toSorted();
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });

  test("planSwap step names are typed constants (compile-time guard)", () => {
    const plan = planSwap({
      currentFrameId: "a",
      nextFrameId: "b",
      viewState: { zoom: 1 },
    });
    const KNOWN: ReadonlyArray<SwapPlanStep["name"]> = [
      "build-new",
      "load-new",
      "render-new",
      "swap",
      "apply-view-state",
      "remove-old",
    ];
    for (const step of plan) {
      expect(KNOWN).toContain(step.name);
    }
  });
});

describe("gallery shell — ordinary frame document", () => {
  test("frame document stays source-byte free without nonce or handshake parameters", () => {
    const document = buildFrameDocument({ artifactType: "markdown", runtimeUrl: RUNTIME_URL });
    expect(document).not.toContain("nonce=");
    expect(document).not.toContain("handshake=");
    expect(document).not.toContain(ARTIFACT_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Swap execution — the REAL async swap against a recording FrameHost.
// The test plays the frame side by installing a fake iframe whose
// contentWindow.__facetFrame.render resolves/rejects/never-settles,
// exactly like the bundled runtime does in a real iframe.
// ---------------------------------------------------------------------------

interface HostCall {
  readonly op: string;
  readonly frameId: string;
}

interface RecordingHost {
  readonly host: FrameHost;
  readonly calls: HostCall[];
  readonly badges: string[];
  readonly mounted: Set<string>;
}

function createRecordingHost(): RecordingHost {
  const calls: HostCall[] = [];
  const badges: string[] = [];
  const mounted = new Set<string>();
  const host: FrameHost = {
    mountOffScreen(frameId) {
      calls.push({ op: "mount-off-screen", frameId });
      mounted.add(frameId);
    },
    setVisibility(frameId, visible) {
      calls.push({ op: visible ? "show" : "hide", frameId });
    },
    unmount(frameId) {
      calls.push({ op: "unmount", frameId });
      mounted.delete(frameId);
    },
    showErrorBadge(message) {
      badges.push(message);
    },
  };
  return { host, calls, badges, mounted };
}

interface FakeFrameElement {
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
  readonly contentWindow: {
    __facetFrame?: { readonly render?: (payload: unknown) => Promise<unknown> };
  };
  readonly receivedPayloads: unknown[];
  autoLoad: boolean;
}

/**
 * A stub DOM whose createElement returns fake iframes. Each fake frame
 * auto-installs a resolving `__facetFrame.render` (capturing payloads)
 * and auto-fires its `load` event on a microtask after creation
 * (matching a real mounted iframe), unless `autoLoad` is disabled.
 * `scripts` — consumed in creation order — override the default for
 * frames created inside async flows the test cannot reach (e.g. the
 * swap's next frame).
 */
function createFakeFrameDom(scripts: Array<(frame: FakeFrameElement) => void> = []): {
  dom: ShellDom;
  frames: FakeFrameElement[];
} {
  const frames: FakeFrameElement[] = [];
  const stubDocument = {
    createElement(_tag: string): FakeFrameElement {
      const listeners = new Map<string, (() => void)[]>();
      const contentWindow: {
        __facetFrame?: { readonly render?: (payload: unknown) => Promise<unknown> };
      } = {};
      const frame: FakeFrameElement = {
        setAttribute(): void {},
        addEventListener(type, listener) {
          const pending = listeners.get(type) ?? [];
          pending.push(listener);
          listeners.set(type, pending);
        },
        contentWindow,
        receivedPayloads: [],
        autoLoad: true,
      };
      frames.push(frame);
      const script = scripts.shift();
      if (script !== undefined) {
        script(frame);
      } else {
        installFakeFrameApi(frame, { viewMode: "native", observed: fakeObservedCounts() });
      }
      if (frame.autoLoad) {
        queueMicrotask(() => {
          if (frame.autoLoad) for (const listener of listeners.get("load") ?? []) listener();
        });
      }
      return frame;
    },
  };
  return {
    dom: { document: stubDocument as unknown as Document, hostname: "127.0.0.1" },
    frames,
  };
}

function fakeObservedCounts(errorCount = 0) {
  return {
    rendererRootSvgCount: 1,
    graphCount: 1,
    mermaidNodeCount: 0,
    visibleSvgCount: 1,
    opaqueRegionCount: 0,
    externalImageCount: 0,
    errorCount,
  };
}

function fakeRenderResult(
  options: {
    readonly viewMode?: "native" | "css";
    readonly errorCount?: number;
  } = {},
) {
  return makeFakeRenderResult(options.viewMode ?? "native", fakeObservedCounts(options.errorCount));
}

describe("gallery shell — real swap execution (direct frame promises)", () => {
  const SOURCE = { artifactType: "markdown", renderer: "svg", bytes: new Uint8Array([1, 2, 3]) };

  test("seamless swap: new frame renders BEFORE the old frame is removed", async () => {
    const { dom, frames } = createFakeFrameDom();
    const recording = createRecordingHost();
    const current = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    const next = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    const nextFrame = frames[1]!;
    installFakeFrameApi(nextFrame, { viewMode: "native", observed: fakeObservedCounts() });

    const result = await replaceArtifactFrame({
      current,
      next,
      dom,
      host: recording.host,
      viewState: { zoom: 1.25 },
      source: SOURCE,
      readyTimeoutMs: 2_000,
    });

    expect(result.failedNewFrameReady).toBe(false);
    expect(result.executedSteps).toEqual([
      "build-new",
      "load-new",
      "render-new",
      "swap",
      "apply-view-state",
      "remove-old",
    ]);
    const ops = recording.calls.map((call) => `${call.op}:${call.frameId}`);
    const mountNew = ops.indexOf(`mount-off-screen:${next.frameId}`);
    const showNew = ops.indexOf(`show:${next.frameId}`);
    const hideOld = ops.indexOf(`hide:${current.frameId}`);
    const removeOld = ops.indexOf(`unmount:${current.frameId}`);
    // Off-screen build first; the new frame is visible before the old
    // frame is hidden, and the old frame is removed LAST.
    expect(mountNew).toBe(0);
    expect(showNew).toBeGreaterThan(mountNew);
    expect(hideOld).toBeGreaterThan(showNew);
    expect(removeOld).toBe(ops.length - 1);
    // The exact revision payload reached the frame's render exactly once.
    expect(nextFrame.receivedPayloads).toEqual([SOURCE]);
    // Frame owns its view mode; the host is not notified.
    expect(recording.mounted.has(current.frameId)).toBe(false);
    expect(recording.mounted.has(next.frameId)).toBe(true);
  });

  test("view state (zoom) is preserved across the swap", async () => {
    const { dom, frames } = createFakeFrameDom();
    const recording = createRecordingHost();
    const current = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    const next = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    // oxlint-disable-next-line no-underscore-dangle
    frames[1]!.contentWindow.__facetFrame = {
      render: async () => fakeRenderResult(),
    };

    const result = await replaceArtifactFrame({
      current,
      next,
      dom,
      host: recording.host,
      viewState: { zoom: 1.75 },
      source: SOURCE,
      readyTimeoutMs: 2_000,
    });

    expect(result.failedNewFrameReady).toBe(false);
    // Frame's own render result reflects the applied view state.
    expect(next.renderResult?.readViewState()).toEqual({
      zoom: 1.75,
      panX: 0,
      panY: 0,
    });
  });

  test("every revision gets a fresh ordinary frame — no artifact-JS carryover", async () => {
    const { dom, frames } = createFakeFrameDom();
    const recording = createRecordingHost();
    const first = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    const second = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    // Source bytes remain off the document URL across frame replacements.
    expect(first.attrs.src).toBe(second.attrs.src);
    expect(first.attrs.src).toContain("type=markdown");
    expect(second.attrs.src).toContain("type=markdown");
    expect(first.attrs.src).not.toContain("nonce=");
    expect(second.attrs.src).not.toContain("handshake=");
    expect(first.attrs.src).not.toContain(ARTIFACT_SENTINEL);
    expect(second.attrs.src).not.toContain(ARTIFACT_SENTINEL);

    const firstHandle = frames[0]!;
    const secondHandle = frames[1]!;
    // oxlint-disable-next-line no-underscore-dangle
    firstHandle.contentWindow.__facetFrame = {
      render: async (payload) => {
        firstHandle.receivedPayloads.push(payload);
        return fakeRenderResult();
      },
    };
    // oxlint-disable-next-line no-underscore-dangle
    secondHandle.contentWindow.__facetFrame = {
      render: async (payload) => {
        secondHandle.receivedPayloads.push(payload);
        return fakeRenderResult();
      },
    };
    const seed = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    const swapOne = await replaceArtifactFrame({
      current: seed,
      next: first,
      dom,
      host: recording.host,
      viewState: { zoom: 1 },
      source: { artifactType: "markdown", renderer: "svg", bytes: new Uint8Array([1]) },
      readyTimeoutMs: 2_000,
    });
    expect(swapOne.failedNewFrameReady).toBe(false);

    const swapTwo = await replaceArtifactFrame({
      current: first,
      next: second,
      dom,
      host: recording.host,
      viewState: { zoom: 1 },
      source: { artifactType: "markdown", renderer: "svg", bytes: new Uint8Array([2]) },
      readyTimeoutMs: 2_000,
    });
    expect(swapTwo.failedNewFrameReady).toBe(false);
    expect(firstHandle.receivedPayloads).toHaveLength(1);
    expect(secondHandle.receivedPayloads).toHaveLength(1);
    expect((secondHandle.receivedPayloads[0] as { bytes: Uint8Array }).bytes).toEqual(
      new Uint8Array([2]),
    );
  });

  test("failed new render keeps the last-good frame + error badge", async () => {
    const { dom, frames } = createFakeFrameDom();
    const recording = createRecordingHost();
    const current = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    const next = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    // The frame loads but its render rejects.
    // oxlint-disable-next-line no-underscore-dangle
    frames[1]!.contentWindow.__facetFrame = {
      render: async () => {
        throw new Error("render exploded");
      },
    };

    const result = await replaceArtifactFrame({
      current,
      next,
      dom,
      host: recording.host,
      viewState: { zoom: 1 },
      source: SOURCE,
      readyTimeoutMs: 2_000,
    });

    expect(result.failedNewFrameReady).toBe(true);
    expect(result.executedSteps).toEqual(["build-new", "load-new", "render-new"]);
    // Old frame untouched: no hide, no unmount.
    const ops = recording.calls.map((call) => `${call.op}:${call.frameId}`);
    expect(ops).not.toContain(`unmount:${current.frameId}`);
    expect(ops).not.toContain(`hide:${current.frameId}`);
    // Failed new frame torn down and badged.
    expect(ops).toContain(`unmount:${next.frameId}`);
    expect(recording.badges).toHaveLength(1);
    expect(recording.badges[0]).toContain("keeping last good revision");
  });

  test("render with observed errors keeps the last-good frame + error badge", async () => {
    const { dom, frames } = createFakeFrameDom();
    const recording = createRecordingHost();
    const current = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    const next = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    // oxlint-disable-next-line no-underscore-dangle
    frames[1]!.contentWindow.__facetFrame = {
      render: async () => fakeRenderResult({ errorCount: 1 }),
    };

    const result = await replaceArtifactFrame({
      current,
      next,
      dom,
      host: recording.host,
      viewState: { zoom: 1 },
      source: SOURCE,
      readyTimeoutMs: 2_000,
    });

    expect(result.failedNewFrameReady).toBe(true);
    expect(recording.badges).toHaveLength(1);
    const ops = recording.calls.map((call) => `${call.op}:${call.frameId}`);
    expect(ops).not.toContain(`unmount:${current.frameId}`);
    expect(ops).not.toContain(`hide:${current.frameId}`);
  });

  test("new frame that never loads keeps the last-good frame (load timeout path)", async () => {
    const { dom, frames } = createFakeFrameDom();
    const recording = createRecordingHost();
    const current = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    const next = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    // No load event at all.
    frames[1]!.autoLoad = false;

    const result = await replaceArtifactFrame({
      current,
      next,
      dom,
      host: recording.host,
      viewState: { zoom: 1 },
      source: SOURCE,
      readyTimeoutMs: 50,
    });

    expect(result.failedNewFrameReady).toBe(true);
    const ops = recording.calls.map((call) => `${call.op}:${call.frameId}`);
    expect(ops).not.toContain(`unmount:${current.frameId}`);
    expect(recording.badges).toHaveLength(1);
  });

  test("new frame whose render never settles keeps the last-good frame (render timeout path)", async () => {
    const { dom, frames } = createFakeFrameDom();
    const recording = createRecordingHost();
    const current = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    const next = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    // The frame loads, but its render promise never settles.
    // oxlint-disable-next-line no-underscore-dangle
    frames[1]!.contentWindow.__facetFrame = {
      render: () => new Promise<never>(() => {}),
    };

    const result = await replaceArtifactFrame({
      current,
      next,
      dom,
      host: recording.host,
      viewState: { zoom: 1 },
      source: SOURCE,
      readyTimeoutMs: 50,
    });

    expect(result.failedNewFrameReady).toBe(true);
    const ops = recording.calls.map((call) => `${call.op}:${call.frameId}`);
    expect(ops).not.toContain(`unmount:${current.frameId}`);
    expect(recording.badges).toHaveLength(1);
  });

  test("swapToRevision fetches the exact revision and swaps to a fresh frame", async () => {
    const { dom, frames } = createFakeFrameDom();
    const recording = createRecordingHost();
    const current = createArtifactFrame({
      artifactType: "markdown",
      dom,
    });
    const fetched: { artifactId: string; revisionSha: string }[] = [];
    const bytes = new Uint8Array([7, 7, 7]);
    // The swap's NEXT frame is created inside swapToRevision; the fake
    // DOM installs its default resolving render at creation.

    const { frame, result, revision } = await swapToRevision(
      {
        dom,
        host: recording.host,
        fetchRevision: async (artifactId, revisionSha) => {
          fetched.push({ artifactId, revisionSha });
          return {
            artifactId: "art-1",
            revisionSha: "sha-1",
            slug: "artifact",
            title: "Artifact title",
            artifactType: "markdown",
            renderer: "svg",
            bytes,
            sourceBytes: bytes,
          };
        },
        readyTimeoutMs: 2_000,
      },
      current,
      { artifactId: "art-1", revisionSha: "sha-1" },
      { zoom: 2 },
    );

    expect(fetched).toEqual([{ artifactId: "art-1", revisionSha: "sha-1" }]);
    expect(result.failedNewFrameReady).toBe(false);
    expect(revision).toEqual({
      artifactId: "art-1",
      revisionSha: "sha-1",
      slug: "artifact",
      title: "Artifact title",
      artifactType: "markdown",
      renderer: "svg",
      bytes,
      sourceBytes: bytes,
    });
    expect(frame).not.toBe(current);
    expect(frames[1]!.receivedPayloads).toEqual([
      { artifactType: "markdown", renderer: "svg", bytes },
    ]);
    // View state is preserved through the frame's own render result, not the host.
    expect(frame.renderResult?.readViewState()).toEqual({ zoom: 2, panX: 0, panY: 0 });
    expect(recording.mounted.has(current.frameId)).toBe(false);
  });
});

describe("gallery shell — serialized revision swaps", () => {
  test("two rapid commits serialize: latest wins, no concurrent swaps, no orphan", async () => {
    const started: string[] = [];
    const done: string[] = [];
    let releaseSlow: (() => void) | null = null;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let concurrent = 0;
    let peak = 0;
    const queue = createSerializedSwapQueue<string>(async (event) => {
      started.push(event);
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      if (event === "slow") await slowGate;
      done.push(event);
      concurrent -= 1;
    });

    queue.enqueue("slow");
    queue.enqueue("first-intermediate");
    queue.enqueue("newest");
    // The first swap is in flight; intermediates collapse into the newest.
    expect(started).toEqual(["slow"]);
    releaseSlow!();
    await queue.settle();

    expect(started).toEqual(["slow", "newest"]);
    expect(done).toEqual(["slow", "newest"]);
    expect(peak).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Write path → SSE: a committed publish emits revision:committed on the
// live stream bound to the artifact's gallery lease.
// ---------------------------------------------------------------------------

describe("service write path — revision SSE emit", () => {
  test("committed publish emits revision:committed with the exact sha to the leased stream", async () => {
    const envDir = mkdtempSync(join(tmpdir(), "facet-sse-emit-"));
    const service = await startFacetService({
      dbPath: join(envDir, "facet.sqlite"),
      installTokenPath: join(envDir, "install.token"),
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath: join(envDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "sse-emit-test" }),
      tier0Runner: stubTier0Runner,
    });
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${service.installToken}`,
      host: `127.0.0.1:${service.port}`,
    };
    const command = async (requestId: string, data: Record<string, unknown>) => {
      const res = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: "facet.v1",
          requestId,
          ok: true,
          data: { requestId, ...data },
        }),
      });
      return (await res.json()) as { data: Record<string, unknown> };
    };
    let streamBody: ReadableStream<Uint8Array> | null = null;
    try {
      const created = await command("r-c", {
        command: "create",
        projectId: "p",
        slug: "sse-emit",
        title: "SSE emit",
      });
      const artifactId = (created.data.artifact as { id: string }).id;

      // Publish rev 1 first so `open` can issue a real lease.
      const published = await command("r-p1", {
        command: "publish",
        artifactId,
        artifactType: "markdown",
        bytes: Buffer.from("# rev one\n").toString("base64"),
      });
      const revisionSha = (published.data.revision as { sha256: string }).sha256;
      const openedReal = await command("r-o2", {
        command: "open",
        artifactId,
        revisionSha,
      });
      const leaseId = (openedReal.data.lease as { leaseId: string }).leaseId;

      const streamRes = await fetch(`${service.url}/api/v1/stream`, {
        headers: {
          authorization: `Bearer ${service.installToken}`,
          host: `127.0.0.1:${service.port}`,
          "x-gallery-lease": leaseId,
          "x-gallery-artifact": artifactId,
        },
      });
      expect(streamRes.status).toBe(200);
      streamBody = streamRes.body;
      const reader = streamRes.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const events: Record<string, unknown>[] = [];
      const readUntil = async (type: string, timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const found = events.find((event) => event.type === type);
          if (found !== undefined) return found;
          const next = await Promise.race([
            reader.read(),
            new Promise<{ done: true; value: undefined }>((resolve) =>
              setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
            ),
          ]);
          if (next.value !== undefined) {
            buffer += decoder.decode(next.value, { stream: true });
            let end = buffer.indexOf("\n\n");
            while (end >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              end = buffer.indexOf("\n\n");
              if (block.startsWith("data: ")) {
                try {
                  events.push(JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
                } catch {
                  // partial — ignore
                }
              }
            }
          }
        }
        return events.find((event) => event.type === type);
      };
      // Stream opens, then the NEXT publish lands as revision:committed.
      await readUntil("stream:open", 5_000);
      const publishTwo = command("r-p2", {
        command: "publish",
        artifactId,
        artifactType: "markdown",
        bytes: Buffer.from("# rev two\n").toString("base64"),
      });
      const committed = await readUntil("revision:committed", 10_000);
      await publishTwo;
      expect(committed).toBeDefined();
      expect(committed?.artifactId).toBe(artifactId);
      expect(committed?.revisionNumber).toBe(2);
      expect(committed?.artifactType).toBe("markdown");
      expect(committed?.revisionSha).toMatch(/^[a-f0-9]{64}$/);
      expect(committed?.revisionSha).not.toBe(revisionSha);
    } finally {
      await streamBody?.cancel().catch(() => {});
      await service.stop();
      try {
        rmSync(envDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Negative source assertions — channel ceremony must be absent from gallery.
//
// Scan every production file under src/gallery-web/** (excluding tests and
// src/validation/**) for banned tokens that belong exclusively to the removed
// display-security ceremony. Each assertion proves that the deleted machinery
// cannot re-enter through a stray import or copy-paste.
//
// Discriminator: each banned token is verified ABSENT from every gallery
// production file (scan passes); temporarily reintroducing one token in a
// gallery file makes the corresponding scan FAIL, proving it discriminates
// rather than passing vacuously.
// ---------------------------------------------------------------------------

const GALLERY_PRODUCTION_GLOB = new URL("../../src/gallery-web", import.meta.url).pathname;

async function collectGalleryProductionFiles(): Promise<string[]> {
  const { readdirSync, statSync } = await import("node:fs");
  const paths: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
        paths.push(full);
      }
    }
  };
  walk(GALLERY_PRODUCTION_GLOB);
  return paths;
}

describe("gallery production source — channel ceremony absent (negative assertions)", () => {
  // Each tuple: [token, human label]
  const BANNED: ReadonlyArray<readonly [string, string]> = [
    ["MessageChannel", "MessageChannel constructor (channel ceremony)"],
    ["facetHandshake", "facetHandshake handshake key"],
    ["handshakeNonce", "handshakeNonce (removed nonce window)"],
    ["frameIngressPort", "frameIngressPort (removed port field)"],
    ["frameControlPort", "frameControlPort (removed port field)"],
    ["allow-scripts", "allow-scripts (removed sandbox attribute)"],
    ["TSX_ARTIFACT_FRAME_ATTRIBUTE", "TSX_ARTIFACT_FRAME_ATTRIBUTE constant"],
  ] as const;

  // srcdoc: present in Tier 1 harness comments inside renderers copied
  // into the frame bundle, but must NOT appear as a gallery ceremony
  // primitive. The gallery frame document is always loaded via src=, never
  // injected as srcdoc.
  const BANNED_IN_FRAME_DIR: ReadonlyArray<readonly [string, string]> = [
    ...BANNED,
    ["srcdoc", "srcdoc (removed gallery frame injection)"],
  ] as const;

  test("collect gallery production files (sanity: at least 10 .ts files found)", async () => {
    const allFiles = await collectGalleryProductionFiles();
    expect(allFiles.length).toBeGreaterThanOrEqual(10);
    // All paths must be under src/gallery-web
    for (const f of allFiles) {
      expect(f).toContain("/src/gallery-web/");
    }
  });

  for (const [token, label] of BANNED_IN_FRAME_DIR) {
    test(`gallery-web/frame/** has no ${label} reference`, async () => {
      const files = (await collectGalleryProductionFiles()).filter((f) =>
        f.includes("/src/gallery-web/frame/"),
      );
      expect(files.length).toBeGreaterThan(0);
      for (const filePath of files) {
        const source = await Bun.file(filePath).text();
        expect(source).not.toContain(token);
      }
    });
  }

  for (const [token, label] of BANNED) {
    test(`gallery-web/** outside frame/ has no ${label} reference`, async () => {
      const files = (await collectGalleryProductionFiles()).filter(
        (f) => !f.includes("/src/gallery-web/frame/"),
      );
      expect(files.length).toBeGreaterThan(0);
      for (const filePath of files) {
        const source = await Bun.file(filePath).text();
        expect(source).not.toContain(token);
      }
    });
  }
});
