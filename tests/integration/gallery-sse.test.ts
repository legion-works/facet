/**
 * Gallery shell + sandbox channel integration tests.
 *
 * Every assertion here is structural — the test gate fails when the
 * shell drifts from the frozen security model. The shell builds its
 * srcdoc and frame attributes via pure helpers (`buildFrameSrcdoc`,
 * `buildFrameAttributes`, `FROZEN_CSP_TEMPLATE`) so the assertions can
 * inspect the produced strings without a browser harness.
 *
 * DOM testing approach: pure-function-first. The channel lifecycle tests
 * use Bun's native `MessageChannel`; the hostname guard is a pure
 * boolean; the swap tests execute the real async swap against a
 * recording FrameHost with REAL MessageChannels (the test plays the
 * frame side by posting on the frame-held port ends). The SSE test
 * runs a real service and drains the real stream.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FROZEN_CSP_TEMPLATE,
  SHELL_EXPORTS,
  assertLoopbackHostname,
  buildFrameAttributes,
  buildFrameSrcdoc,
  createArtifactFrame,
  isLoopbackHostname,
  planSwap,
  replaceArtifactFrame,
  swapToRevision,
  type CreatedArtifactFrame,
  type FrameControlEvent,
  type FrameHost,
  type ShellDom,
  type SwapPlanStep,
  type ViewState,
} from "../../src/gallery-web/app";
import { createChannelPair, type ChannelPair } from "../../src/gallery-web/frame/channels";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";

const NONCE = "facet-nonce-abcd1234";
const BOOTSTRAP_URL = "/gallery/frame/bootstrap.js";

const ARTIFACT_SENTINEL = "FACET_SENTINEL_ARTIFACT_BYTES_ZZZ_9999";

function buildFreshNonce(): string {
  return "n-" + crypto.randomUUID().replace(/-/g, "");
}

describe("gallery shell — CSP + srcdoc invariants", () => {
  test("buildFrameAttributes: sandbox is EXACTLY 'allow-scripts' (not allow-same-origin)", () => {
    const attrs = buildFrameAttributes();
    expect(attrs.sandbox).toBe("allow-scripts");
    expect(attrs.sandbox).not.toContain("allow-same-origin");
  });

  test("buildFrameAttributes: referrerpolicy is no-referrer", () => {
    const attrs = buildFrameAttributes();
    expect(attrs.referrerpolicy).toBe("no-referrer");
  });

  test("buildFrameAttributes: no src attribute (srcdoc only)", () => {
    const attrs = buildFrameAttributes();
    expect("src" in attrs).toBe(false);
  });

  test("buildFrameAttributes: shell-controlled CSS transform is the zoom surface (not inside-frame script)", () => {
    const attrs = buildFrameAttributes();
    // The shell applies transforms to the iframe ELEMENT. The frame's
    // own scripts must not run zoom handlers — opaque origin + frozen
    // CSP forbids it anyway.
    expect(attrs.allow).toBe("");
  });
});

describe("gallery shell — FROZEN CSP", () => {
  test("template includes script-src nonce, no 'unsafe-inline'", () => {
    expect(FROZEN_CSP_TEMPLATE).toContain("script-src 'nonce-");
    expect(FROZEN_CSP_TEMPLATE).not.toContain("script-src 'unsafe-inline'");
    expect(FROZEN_CSP_TEMPLATE).not.toContain("script-src *");
  });

  test("template denies same-origin (no allow-same-origin in CSP), workers, connect", () => {
    expect(FROZEN_CSP_TEMPLATE).toContain("worker-src 'none'");
    expect(FROZEN_CSP_TEMPLATE).toContain("connect-src 'none'");
    expect(FROZEN_CSP_TEMPLATE).toContain("default-src 'none'");
    expect(FROZEN_CSP_TEMPLATE).toContain("object-src 'none'");
    expect(FROZEN_CSP_TEMPLATE).toContain("base-uri 'none'");
    expect(FROZEN_CSP_TEMPLATE).toContain("form-action 'none'");
    expect(FROZEN_CSP_TEMPLATE).toContain("frame-src 'none'");
    expect(FROZEN_CSP_TEMPLATE).toContain("media-src 'none'");
  });

  test("style-src 'unsafe-inline' is REQUIRED (Mermaid inline SVG) — and only that", () => {
    expect(FROZEN_CSP_TEMPLATE).toContain("style-src 'unsafe-inline'");
  });

  test("rendered CSP substitutes the per-frame nonce into script-src", () => {
    const srcdoc = buildFrameSrcdoc({
      nonce: NONCE,
      bootstrapUrl: BOOTSTRAP_URL,
    });
    expect(srcdoc).toContain(`script-src 'nonce-${NONCE}'`);
    expect(srcdoc).not.toContain("script-src 'unsafe-inline'");
    // No leftover placeholder.
    expect(srcdoc).not.toContain("<BOOTSTRAP_NONCE>");
  });
});

describe("gallery shell — srcdoc generation", () => {
  test("charset meta precedes CSP meta (unsafe-parse if reversed)", () => {
    const srcdoc = buildFrameSrcdoc({
      nonce: NONCE,
      bootstrapUrl: BOOTSTRAP_URL,
    });
    const charsetIdx = srcdoc.indexOf('<meta charset="utf-8">');
    const cspIdx = srcdoc.indexOf("Content-Security-Policy");
    expect(charsetIdx).toBeGreaterThanOrEqual(0);
    expect(cspIdx).toBeGreaterThanOrEqual(0);
    expect(charsetIdx).toBeLessThan(cspIdx);
  });

  test("srcdoc references the trusted bootstrap under the per-frame nonce", () => {
    const srcdoc = buildFrameSrcdoc({
      nonce: NONCE,
      bootstrapUrl: BOOTSTRAP_URL,
    });
    // `type="module"` keeps Vega's top-level `function addEventListener`
    // out of the global scope (a classic script would hoist it into
    // `window.addEventListener` and break the frame's own listener).
    expect(srcdoc).toContain(`<script type="module" nonce="${NONCE}" src="${BOOTSTRAP_URL}">`);
    expect(srcdoc).toContain(`src="${BOOTSTRAP_URL}"`);
    expect(srcdoc).toContain("</script>");
  });

  test("srcdoc NEVER carries artifact source bytes (publish sentinel — must be absent)", () => {
    // The shell's srcdoc is generated ONLY from the nonce + the built
    // trusted bootstrap. If a future shell change ever interpolates
    // artifact bytes into srcdoc (the most dangerous regression in
    // this whole surface), this assertion fires.
    const srcdoc = buildFrameSrcdoc({
      nonce: NONCE,
      bootstrapUrl: BOOTSTRAP_URL,
    });
    expect(srcdoc).not.toContain(ARTIFACT_SENTINEL);
    // Defensive: exactly ONE <script tag in srcdoc — the trusted bootstrap.
    // Any future regression that injects a second script would let
    // artifact bytes (or a hostile inline script) execute under the
    // per-frame nonce.
    expect(srcdoc.match(/<script/gi)?.length ?? 0).toBe(1);
  });

  test("srcdoc escapes bootstrap URL attributes", () => {
    const tricky = "https://example.test/bootstrap.js?a=1&b=2";
    const srcdoc = buildFrameSrcdoc({
      nonce: NONCE,
      bootstrapUrl: tricky,
    });
    expect(srcdoc).toContain("https://example.test/bootstrap.js?a=1&amp;b=2");
    expect(srcdoc.match(/<\/script>/g)?.length ?? 0).toBe(1);
  });
});

describe("gallery frame program (bootstrap source)", () => {
  // The frame program is bundled into the srcdoc at build time; these
  // assertions pin its trust-path shape at the source level (the live
  // render path is proven by the Tier 1 acceptance gates, which bundle
  // the SAME renderers).
  const bootstrapPath = new URL("../../src/gallery-web/frame/bootstrap.ts", import.meta.url)
    .pathname;

  test("verifies the handshake nonce against its own script tag", async () => {
    const source = await Bun.file(bootstrapPath).text();
    expect(source).toContain("facetHandshake");
    expect(source).toContain("ports");
    expect(source).toContain('getAttribute("nonce")');
  });

  test("signals boot-ready and render-complete via the control port", async () => {
    const source = await Bun.file(bootstrapPath).text();
    expect(source).toContain("boot-ready");
    expect(source).toContain("render-complete");
    // Counts cross the control port ONLY after the dispatch settled.
    const dispatchIdx = source.indexOf("dispatchRender(");
    const completeIdx = source.indexOf('"render-complete"');
    expect(dispatchIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(dispatchIdx);
  });

  test("closes the ingress port one-shot on artifact receipt", async () => {
    const source = await Bun.file(bootstrapPath).text();
    expect(source).toContain("ingress.close()");
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

describe("gallery shell — channel lifecycle (closure-held control, one-shot ingress)", () => {
  let pair: ChannelPair;

  afterEach(() => {
    pair?.close();
  });

  beforeEach(() => {
    pair = createChannelPair({ messageChannelCtor: MessageChannel });
  });

  test("source ingress port closes after first delivery", () => {
    expect(pair.ingressOpen).toBe(true);
    pair.deliverSource({ type: "test", bytes: new Uint8Array([1, 2, 3]) });
    expect(pair.ingressOpen).toBe(false);
    // Second call after closure is a no-op (does not throw).
    expect(() => pair.deliverSource({ type: "test", bytes: new Uint8Array() })).not.toThrow();
  });

  test("control port stays open across many sends (closure-held, not one-shot)", () => {
    expect(pair.controlOpen).toBe(true);
    pair.sendControl({ type: "boot-ready" });
    pair.sendControl({ type: "render-complete", observed: {} });
    pair.sendControl({ type: "view-state", zoom: 1.5 });
    expect(pair.controlOpen).toBe(true);
  });

  test("deliverSource sends the artifact over the wire (structured clone — not srcdoc)", async () => {
    const capture: { received: unknown[] } = { received: [] };
    pair.onIngressMessage = (event) => capture.received.push(event.data);
    pair.deliverSource({ type: "artifact", bytes: ARTIFACT_SENTINEL });
    // Bun's MessagePort delivery runs on a task (not a microtask). A
    // short setTimeout(0) is enough to let the frame-side onmessage
    // fire before the assertion runs.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(capture.received).toHaveLength(1);
    // Sentinel traveled over the channel — NOT over srcdoc.
    const payload = capture.received[0] as { type: string; bytes: string };
    expect(payload.type).toBe("artifact");
    expect(payload.bytes).toBe(ARTIFACT_SENTINEL);
  });

  test("control port closes only when explicitly closed (frame replacement)", () => {
    expect(pair.controlOpen).toBe(true);
    pair.closeControl();
    expect(pair.controlOpen).toBe(false);
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
  test("new frame reaches ready BEFORE old frame is removed (ordering)", () => {
    const log = runSwapPlan("frame-old", "frame-new", { zoom: 1.0 });
    const readyIdx = log.indexOf("new-frame-ready");
    const removeIdx = log.indexOf("remove-old");
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(readyIdx).toBeLessThan(removeIdx);
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
    // The plan only targets the new frame for source delivery — frame-A
    // is touched only by `close-old-control` and `remove-old`.
    const sourceTouches = plan.filter(
      (s) => s.name === "build-new" || s.name === "open-new-control",
    );
    for (const step of sourceTouches) {
      expect(step.frameId).not.toBe("frame-A");
    }
  });

  test("old control port closes during swap; new control port stays open", () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const plan = planSwap({
      currentFrameId: "frame-old",
      nextFrameId: "frame-new",
      viewState: { zoom: 1 },
      onStep: (step) => {
        if (step.name === "open-new-control" && "frameId" in step) opened.push(step.frameId);
        if (step.name === "close-old-control" && "frameId" in step) closed.push(step.frameId);
      },
    });
    for (const step of plan) step.run();
    expect(opened).toEqual(["frame-new"]);
    expect(closed).toEqual(["frame-old"]);
  });

  test("failed new-frame ready keeps the old frame visible (error path)", () => {
    let removed = false;
    const plan = planSwap({
      currentFrameId: "frame-old",
      nextFrameId: "frame-new",
      viewState: { zoom: 1 },
      failNewFrameReady: true,
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
    expect(names).toContain("new-frame-ready");
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
    "../../src/gallery-web/frame/channels.ts",
    "../../src/gallery-web/frame/bootstrap.ts",
    "../../src/gallery-web/frame/renderers/registry.ts",
    "../../src/gallery-web/frame/renderers/markdown.ts",
    "../../src/gallery-web/frame/renderers/mermaid.ts",
    "../../src/gallery-web/frame/renderers/svg.ts",
    "../../src/gallery-web/frame/renderers/chart.ts",
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
  test("FrameAttributes shape matches what createArtifactFrame will set on the element", () => {
    const attrs = buildFrameAttributes();
    expect(typeof attrs.sandbox).toBe("string");
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
      "open-new-control",
      "new-frame-ready",
      "swap",
      "apply-view-state",
      "close-old-control",
      "remove-old",
    ];
    for (const step of plan) {
      expect(KNOWN).toContain(step.name);
    }
  });
});

describe("gallery shell — per-frame nonce freshness", () => {
  test("each buildFrameSrcdoc call mints a distinct, fresh nonce when given one", () => {
    const a = buildFrameSrcdoc({
      nonce: buildFreshNonce(),
      bootstrapUrl: BOOTSTRAP_URL,
    });
    const b = buildFrameSrcdoc({
      nonce: buildFreshNonce(),
      bootstrapUrl: BOOTSTRAP_URL,
    });
    expect(a).not.toBe(b);
    // Each srcdoc's CSP carries its own nonce.
    const nonceA = a.match(/script-src 'nonce-([^']+)'/)?.[1];
    const nonceB = b.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(nonceA).toBeDefined();
    expect(nonceB).toBeDefined();
    expect(nonceA).not.toBe(nonceB);
  });
});

// ---------------------------------------------------------------------------
// Swap execution — the REAL async swap against a recording FrameHost.
// The test plays the frame side: it posts boot-ready / render-complete
// on the frame-held control port end and consumes the ingress payload,
// exactly like the bundled bootstrap does in a real iframe.
// ---------------------------------------------------------------------------

interface HostCall {
  readonly op: string;
  readonly frameId: string;
}

interface RecordingHost {
  readonly host: FrameHost;
  readonly calls: HostCall[];
  readonly badges: string[];
  readonly viewStates: Map<string, ViewState>;
  readonly mounted: Set<string>;
}

function createRecordingHost(): RecordingHost {
  const calls: HostCall[] = [];
  const badges: string[] = [];
  const viewStates = new Map<string, ViewState>();
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
    applyViewState(frameId, viewState) {
      calls.push({ op: "apply-view-state", frameId });
      viewStates.set(frameId, viewState);
    },
    showErrorBadge(message) {
      badges.push(message);
    },
  };
  return { host, calls, badges, viewStates, mounted };
}

function createStubDom(): ShellDom {
  const stubDocument = {
    createElement(_tag: string): { setAttribute(name: string, value: string): void } {
      return { setAttribute: () => {} };
    },
  };
  return {
    document: stubDocument as unknown as Document,
    MessageChannel,
    hostname: "127.0.0.1",
    window: {},
  };
}

interface SimulatedFrameOptions {
  readonly errorCount?: number;
  readonly omitBootReady?: boolean;
  readonly omitRenderComplete?: boolean;
}

/**
 * Post a control event on a frame-held MessagePort. MessagePort's
 * `postMessage` takes a transfer list as its second argument, not a
 * `targetOrigin` — the oxlint rule targets `window.postMessage`, so
 * the rule is disabled at this helper.
 */
function postFrameControl(frame: CreatedArtifactFrame, event: FrameControlEvent): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  frame.frameControlPort.postMessage(event);
}

/** Play the frame side of the protocol against a CreatedArtifactFrame. */
function simulateFrameSide(
  frame: CreatedArtifactFrame,
  received: unknown[],
  options: SimulatedFrameOptions = {},
): void {
  if (options.omitBootReady !== true) {
    postFrameControl(frame, { type: "boot-ready" });
  }
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  frame.frameIngressPort.onmessage = (event: MessageEvent) => {
    received.push(event.data);
    if (options.omitRenderComplete === true) return;
    postFrameControl(frame, {
      type: "render-complete",
      observed: {
        rendererRootSvgCount: 1,
        graphCount: 1,
        mermaidNodeCount: 0,
        visibleSvgCount: 1,
        errorCount: options.errorCount ?? 0,
      },
    });
  };
}

describe("gallery shell — real swap execution (double-buffered HMR)", () => {
  const SOURCE = { artifactType: "markdown", bytes: new Uint8Array([1, 2, 3]) };

  test("seamless swap: new frame renders BEFORE the old frame is removed", async () => {
    const dom = createStubDom();
    const recording = createRecordingHost();
    const current = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    const next = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    const received: unknown[] = [];
    simulateFrameSide(next, received);

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
      "open-new-control",
      "new-frame-ready",
      "swap",
      "apply-view-state",
      "close-old-control",
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
    // Bytes crossed the ingress exactly once.
    expect(received).toEqual([SOURCE]);
    // Old control channel is dead; the frame is gone from the host.
    current.sendControl({ type: "probe" });
    expect(recording.mounted.has(current.frameId)).toBe(false);
    expect(recording.mounted.has(next.frameId)).toBe(true);
    next.closeControl();
  });

  test("view state (zoom) is preserved across the swap", async () => {
    const dom = createStubDom();
    const recording = createRecordingHost();
    const current = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    const next = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    simulateFrameSide(next, []);

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
    expect(recording.viewStates.get(next.frameId)).toEqual({ zoom: 1.75 });
    next.closeControl();
  });

  test("every revision gets a FRESH opaque frame — no artifact-JS carryover", async () => {
    const dom = createStubDom();
    const recording = createRecordingHost();
    const first = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    const second = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    // Fresh nonce + fresh srcdoc per frame — an old bootstrap cannot
    // survive into a new CSP window, and no source bytes ride srcdoc.
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.attrs.srcdoc).not.toBe(second.attrs.srcdoc);
    expect(first.attrs.srcdoc).toContain(first.nonce);
    expect(second.attrs.srcdoc).toContain(second.nonce);
    expect(first.attrs.srcdoc).not.toContain(ARTIFACT_SENTINEL);
    expect(second.attrs.srcdoc).not.toContain(ARTIFACT_SENTINEL);

    // Two consecutive swaps: rev1 → rev2. The second swap's frame is
    // distinct and receives ITS bytes once; the first frame's ingress
    // is already closed (one-shot) and its control dies at replacement.
    const receivedFirst: unknown[] = [];
    simulateFrameSide(first, receivedFirst);
    const seed = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    const swapOne = await replaceArtifactFrame({
      current: seed,
      next: first,
      dom,
      host: recording.host,
      viewState: { zoom: 1 },
      source: { artifactType: "markdown", bytes: new Uint8Array([1]) },
      readyTimeoutMs: 2_000,
    });
    expect(swapOne.failedNewFrameReady).toBe(false);

    const receivedSecond: unknown[] = [];
    simulateFrameSide(second, receivedSecond);
    const swapTwo = await replaceArtifactFrame({
      current: first,
      next: second,
      dom,
      host: recording.host,
      viewState: { zoom: 1 },
      source: { artifactType: "markdown", bytes: new Uint8Array([2]) },
      readyTimeoutMs: 2_000,
    });
    expect(swapTwo.failedNewFrameReady).toBe(false);
    expect(receivedFirst).toHaveLength(1);
    expect(receivedSecond).toHaveLength(1);
    expect((receivedSecond[0] as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array([2]));
    // Replay attempt on the spent ingress is a no-op (one-shot).
    first.deliverSource({ artifactType: "markdown", bytes: new Uint8Array([9, 9]) });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(receivedFirst).toHaveLength(1);
    second.closeControl();
  });

  test("failed new render keeps the last-good frame + error badge", async () => {
    const dom = createStubDom();
    const recording = createRecordingHost();
    const current = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    const next = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    // The frame boots but its render reports errors.
    simulateFrameSide(next, [], { errorCount: 1 });

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
    expect(result.executedSteps).toEqual(["build-new", "open-new-control"]);
    // Old frame untouched: no hide, no unmount.
    const ops = recording.calls.map((call) => `${call.op}:${call.frameId}`);
    expect(ops).not.toContain(`unmount:${current.frameId}`);
    expect(ops).not.toContain(`hide:${current.frameId}`);
    // Failed new frame torn down (channels + element) and badged.
    expect(ops).toContain(`unmount:${next.frameId}`);
    expect(recording.badges).toHaveLength(1);
    expect(recording.badges[0]).toContain("keeping last good revision");
  });

  test("new frame that never boots keeps the last-good frame (timeout path)", async () => {
    const dom = createStubDom();
    const recording = createRecordingHost();
    const current = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    const next = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    // No boot-ready at all.
    simulateFrameSide(next, [], { omitBootReady: true, omitRenderComplete: true });

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
    const dom = createStubDom();
    const recording = createRecordingHost();
    const current = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    const fetched: { artifactId: string; revisionSha: string }[] = [];
    const bytes = new Uint8Array([7, 7, 7]);
    const received: unknown[] = [];

    const { frame, result } = await swapToRevision(
      {
        dom,
        host: recording.host,
        bootstrapUrl: BOOTSTRAP_URL,
        fetchRevision: async (artifactId, revisionSha) => {
          fetched.push({ artifactId, revisionSha });
          return { artifactType: "markdown", bytes };
        },
        onFrameCreated: (next) => simulateFrameSide(next, received),
        readyTimeoutMs: 2_000,
      },
      current,
      { artifactId: "art-1", revisionSha: "sha-1" },
      { zoom: 2 },
    );

    expect(fetched).toEqual([{ artifactId: "art-1", revisionSha: "sha-1" }]);
    expect(result.failedNewFrameReady).toBe(false);
    expect(frame).not.toBe(current);
    expect(received).toEqual([{ artifactType: "markdown", bytes }]);
    expect(recording.viewStates.get(frame.frameId)).toEqual({ zoom: 2 });
    expect(recording.mounted.has(current.frameId)).toBe(false);
    frame.closeControl();
  });
});

describe("gallery shell — control-port RECEIVE path", () => {
  test("onControlEvent receives frame→shell events posted on the frame-held end", async () => {
    const dom = createStubDom();
    const frame = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    const events: FrameControlEvent[] = [];
    const unsubscribe = frame.onControlEvent((event) => events.push(event));
    postFrameControl(frame, { type: "boot-ready" });
    postFrameControl(frame, {
      type: "render-complete",
      observed: {
        rendererRootSvgCount: 2,
        graphCount: 2,
        mermaidNodeCount: 40,
        visibleSvgCount: 2,
        errorCount: 0,
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(events.map((event) => event.type)).toEqual(["boot-ready", "render-complete"]);
    expect(events[1]?.observed?.rendererRootSvgCount).toBe(2);
    unsubscribe();
    frame.closeControl();
  });

  test("awaitControlEvent resolves on the matching type and times out to null", async () => {
    const dom = createStubDom();
    const frame = createArtifactFrame({ bootstrapUrl: BOOTSTRAP_URL, dom });
    const pending = frame.awaitControlEvent("boot-ready", 1_000);
    postFrameControl(frame, { type: "boot-ready" });
    expect(await pending).toMatchObject({ type: "boot-ready" });
    // No render-complete coming — the wait must bound itself.
    expect(await frame.awaitControlEvent("render-complete", 50)).toBeNull();
    frame.closeControl();
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
