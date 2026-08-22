/**
 * Verifier harness — runs INSIDE the opaque-origin iframe.
 *
 * Bundled by `harness.ts` and embedded into the iframe srcdoc under a
 * per-build nonce. The CSP rejects any script that does not carry that
 * nonce, so this bundle is the only executable code reachable inside
 * the frame.
 *
 * Renderer pipeline:
 *   1. Wire the `window.message` handshake (verifier transfers the
 *      port2 ends via postMessage).
 *   2. Emit `boot-ready` on the control port.
 *   3. Receive the artifact on the ingress port (one-shot).
 *   4. Dispatch through the renderer registry supplied by the paired
 *      type-specific entry. Its renderer modules are build-checked
 *      against the gallery entry, so the gate verifies the actual
 *      user-visible render, not a stand-in.
 *      `test-adversary` payloads run the matching scenario instead
 *      (the monkeypatch / forge paths live here).
 *   5. Emit `render-complete` with the page-shim counts describing
 *      what the page world sees (renderer-owned roots, errors, …).
 *
 * The page shim counts through the page world's `querySelectorAll` ON
 * PURPOSE: a hostile page can monkey-patch it and lie — the verdict
 * layer detects that lie against the protocol authority.
 */

import {
  appendRenderError,
  countPageShim,
  dispatchRender,
  type RendererRegistry,
} from "../../gallery-web/frame/renderers/registry";
import type { Renderer } from "../../shared/contracts/renderers";
import { isTsxExecutionMode, type TsxExecutionMode } from "../../shared/tsx/execution";
import { validateRenderer } from "../../gallery-web/frame/renderer-validation";

type ArtifactMode = "raw" | "render";

type ControlEvent =
  | { type: "boot-ready" }
  | { type: "render-complete"; observed: ReturnType<typeof countPageShim>; mode: ArtifactMode };

declare global {
  interface Window {
    __facetHarnessLoaded?: boolean;
  }
}

const containerElement = document.getElementById("artifact");
if (containerElement === null) {
  throw new Error("harness: #artifact container missing");
}
const container: HTMLElement = containerElement;
const nonce = container.getAttribute("data-facet-nonce") ?? "";

let controlPost: ((event: ControlEvent) => void) | null = null;
let handshakeComplete = false;

function adversarialMonkeypatch(): void {
  // Replace querySelectorAll so the page-shim's count diverges from
  // the protocol truth. The verifier MUST detect this divergence.
  Object.defineProperty(document, "querySelectorAll", {
    value: function (selectors: string) {
      if (selectors === "svg") {
        return { length: 2 } as unknown as NodeListOf<Element>;
      }
      if (selectors === "[data-facet-error]") {
        return { length: 0 } as unknown as NodeListOf<Element>;
      }
      return { length: 0 } as unknown as NodeListOf<Element>;
    },
    configurable: true,
  });
}

function adversarialHtmlCountMonkeypatch(): void {
  const original = document.querySelectorAll.bind(document);
  Object.defineProperty(document, "querySelectorAll", {
    value: function (selectors: string) {
      if (selectors === '[data-facet-renderer-root="true"]') {
        return { length: 0 } as unknown as NodeListOf<Element>;
      }
      return original(selectors);
    },
    configurable: true,
  });
}

function appendAdversarialCanvas(): void {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  container.appendChild(canvas);
}

function adversarialCanvasCountMonkeypatch(): void {
  const originalQuerySelectorAll = document.querySelectorAll.bind(document);
  Object.defineProperty(document, "querySelectorAll", {
    value: function (selectors: string) {
      if (selectors === "*") return { length: 0 } as unknown as NodeListOf<Element>;
      return originalQuerySelectorAll(selectors);
    },
    configurable: true,
  });
}

async function renderAdversarialJson(payload: unknown): Promise<void> {
  if (typeof payload !== "object" || payload === null) {
    appendRenderError(container, "adversarial: payload is not an object");
    return;
  }
  const record = payload as Record<string, unknown>;
  if (record["type"] !== "test-adversary") {
    appendRenderError(container, "adversarial: missing type=test-adversary");
    return;
  }
  const name = typeof record["name"] === "string" ? (record["name"] as string) : "";
  if (name === "hostile-monkeypatch") {
    adversarialMonkeypatch();
    appendRenderError(container, "forced facet-error for monkeypatch scenario");
    return;
  }
  if (name === "hostile-canvas-smuggle") {
    appendAdversarialCanvas();
    return;
  }
  if (name === "hostile-canvas-monkeypatch") {
    appendAdversarialCanvas();
    adversarialCanvasCountMonkeypatch();
    return;
  }
  if (name === "html-forged-marker") {
    const source = typeof record["source"] === "string" ? record["source"] : "";
    container.innerHTML = source;
    adversarialHtmlCountMonkeypatch();
    return;
  }
  if (name === "html-shim-divergence") {
    container.innerHTML = '<div data-facet-renderer-root="true"><h1>Observed report</h1></div>';
    adversarialHtmlCountMonkeypatch();
    return;
  }
  const source = typeof record["source"] === "string" ? (record["source"] as string) : null;
  if (source !== null) {
    container.innerHTML = source;
    return;
  }
  appendRenderError(container, `adversarial: unknown name=${name}`);
}

async function renderArtifact(
  registry: RendererRegistry,
  artifactBytes: Uint8Array,
  mode: ArtifactMode,
  artifactType: string,
  renderer: Renderer,
  execution: TsxExecutionMode | undefined,
): Promise<void> {
  if (mode === "raw") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(artifactBytes);
    container.innerHTML = text;
    return;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(artifactBytes);
  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "test-adversary"
    ) {
      await renderAdversarialJson(parsed);
      return;
    }
  } catch {
    // not JSON — fall through to the typed renderer dispatch
  }
  await dispatchRender(
    registry,
    { container, nonce, theme: "dark" },
    {
      artifactType,
      renderer,
      bytes: artifactBytes,
      theme: "dark",
      ...(execution === undefined ? {} : { execution }),
    },
  );
}

export function startTier1Harness(registry: RendererRegistry): void {
  (window as unknown as { facetHarnessLoaded?: boolean }).facetHarnessLoaded = true;
  window.addEventListener(
    "message",
    (event) => {
      if (handshakeComplete || event.source !== window.parent) return;
      const data = (event as MessageEvent).data as {
        facetHandshake?: string;
        nonce?: string;
      } | null;
      if (data === null || data.facetHandshake !== "ports" || data.nonce !== nonce) return;
      const ports = (event as MessageEvent).ports;
      if (!Array.isArray(ports) || ports.length !== 2) return;
      const ingress = ports[0];
      const control = ports[1];
      if (ingress === undefined || control === undefined) return;
      handshakeComplete = true;
      controlPost = control.postMessage.bind(control) as (event: ControlEvent) => void;
      // MessagePort.onmessage is required over addEventListener("message"):
      // per spec a MessagePort queues messages until start() is called, and
      // only the onmessage setter starts the port implicitly — with
      // addEventListener alone the handshake never fires (verified on the
      // pinned shell build; addEventListener+start() would also work).
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      ingress.onmessage = async (sourceEvent: MessageEvent) => {
        const payload = sourceEvent.data as
          | {
              bytes: string;
              mode: ArtifactMode;
              artifactType?: string;
              renderer?: string;
              execution?: TsxExecutionMode;
            }
          | undefined;
        if (payload === undefined) return;
        ingress.close();
        const bytes = Uint8Array.from(atob(payload.bytes), (char) => char.charCodeAt(0));
        try {
          const renderer = validateRenderer(payload.renderer);
          if (payload.execution !== undefined && !isTsxExecutionMode(payload.execution)) {
            throw new Error("artifact payload has invalid execution");
          }
          await renderArtifact(
            registry,
            bytes,
            payload.mode,
            payload.artifactType ?? "markdown",
            renderer,
            payload.execution,
          );
        } catch (error) {
          appendRenderError(container, error instanceof Error ? error.message : String(error));
        }
        // Counts cross the control port ONLY after the render settled.
        const report = countPageShim();
        try {
          controlPost?.({ type: "render-complete", observed: report, mode: payload.mode });
        } catch {
          // control channel already torn down — drop silently.
        }
      };
      try {
        controlPost({ type: "boot-ready" });
      } catch {
        // ditto
      }
    },
    { once: false },
  );
}
