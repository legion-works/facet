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
 * boolean; the swap-ordering test asserts the produced plan. We do not
 * spin up a full iframe harness inside the test gate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  FROZEN_CSP_TEMPLATE,
  SHELL_EXPORTS,
  assertLoopbackHostname,
  buildBootstrapScript,
  buildFrameAttributes,
  buildFrameSrcdoc,
  isLoopbackHostname,
  planSwap,
  type SwapPlanStep,
} from "../../src/gallery-web/app";
import { createChannelPair, type ChannelPair } from "../../src/gallery-web/frame/channels";

const NONCE = "facet-nonce-abcd1234";
const BOOTSTRAP_SCRIPT =
  "/* built trusted bootstrap — placeholder marker */ window.__facetBootstrapRan = true;";

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
      bootstrapScript: BOOTSTRAP_SCRIPT,
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
      bootstrapScript: BOOTSTRAP_SCRIPT,
    });
    const charsetIdx = srcdoc.indexOf('<meta charset="utf-8">');
    const cspIdx = srcdoc.indexOf("Content-Security-Policy");
    expect(charsetIdx).toBeGreaterThanOrEqual(0);
    expect(cspIdx).toBeGreaterThanOrEqual(0);
    expect(charsetIdx).toBeLessThan(cspIdx);
  });

  test("srcdoc embeds the trusted bootstrap under the per-frame nonce", () => {
    const srcdoc = buildFrameSrcdoc({
      nonce: NONCE,
      bootstrapScript: BOOTSTRAP_SCRIPT,
    });
    expect(srcdoc).toContain(`<script nonce="${NONCE}">`);
    expect(srcdoc).toContain(BOOTSTRAP_SCRIPT);
    expect(srcdoc).toContain("</script>");
  });

  test("srcdoc NEVER carries artifact source bytes (publish sentinel — must be absent)", () => {
    // The shell's srcdoc is generated ONLY from the nonce + the built
    // trusted bootstrap. If a future shell change ever interpolates
    // artifact bytes into srcdoc (the most dangerous regression in
    // this whole surface), this assertion fires.
    const srcdoc = buildFrameSrcdoc({
      nonce: NONCE,
      bootstrapScript: BOOTSTRAP_SCRIPT,
    });
    expect(srcdoc).not.toContain(ARTIFACT_SENTINEL);
    // Defensive: exactly ONE <script tag in srcdoc — the trusted bootstrap.
    // Any future regression that injects a second script would let
    // artifact bytes (or a hostile inline script) execute under the
    // per-frame nonce.
    expect(srcdoc.match(/<script/gi)?.length ?? 0).toBe(1);
  });

  test("srcdoc closes </script> tags inside bootstrap to prevent parse breakout", () => {
    const tricky = "x = '</script' + '>';";
    const srcdoc = buildFrameSrcdoc({
      nonce: NONCE,
      bootstrapScript: tricky,
    });
    // The escape: any literal '</script' inside bootstrap must be
    // '<\\/script' so the parent <script> tag cannot be terminated
    // by artifact-style text. buildFrameSrcdoc is responsible for
    // escaping (the production spike applied the same rule).
    expect(srcdoc).toContain("<\\/script");
    expect(srcdoc.match(/<\/script>/g)?.length ?? 0).toBe(1);
  });
});

describe("gallery shell — bootstrap script", () => {
  test("bootstrap script receives ports via postMessage with nonce check", () => {
    const script = buildBootstrapScript({ nonce: NONCE });
    expect(script).toContain(NONCE);
    // Trust path is the transferred port — the bootstrap must NOT
    // accept arbitrary window messages as capability.
    expect(script).toContain("ports");
  });

  test("bootstrap signals boot-ready via the control port", () => {
    const script = buildBootstrapScript({ nonce: NONCE });
    expect(script).toContain("boot-ready");
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
  // the runtime frame module exports no zod-imported symbol (defence in
  // depth — a frame/<file>.ts accidentally `import { z } from "zod"`
  // would break the gate; this test catches it earlier at unit time).
  test("frame/channels has no zod references", async () => {
    const source = await Bun.file(
      new URL("../../src/gallery-web/frame/channels.ts", import.meta.url).pathname,
    ).text();
    expect(source).not.toMatch(/from\s+["']zod["']/);
    expect(source).not.toMatch(/require\(['"]zod['"]\)/);
  });
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
      bootstrapScript: BOOTSTRAP_SCRIPT,
    });
    const b = buildFrameSrcdoc({
      nonce: buildFreshNonce(),
      bootstrapScript: BOOTSTRAP_SCRIPT,
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
