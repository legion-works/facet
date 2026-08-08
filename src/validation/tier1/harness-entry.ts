/**
 * Verifier harness — runs INSIDE the opaque-origin iframe.
 *
 * Bundled by `harness.ts` and embedded into the iframe srcdoc under
 * a per-build nonce. The CSP rejects any script that does not carry
 * that nonce, so this bundle is the only executable code reachable
 * inside the frame.
 *
 * Renderer pipeline:
 *   1. Wire `window.message` handshake (verifier transfers the
 *      port2 ends via postMessage).
 *   2. Emit `boot-ready` on the control port.
 *   3. Receive the artifact on the ingress port (one-shot).
 *   4. Dispatch the artifact through the renderer pipeline:
 *        - test-adversary payloads run the matching scenario
 *          (the spike's monkeypatch / forge path lives here).
 *        - mermaid blocks inside a markdown document are rendered
 *          by a bundled lightweight renderer that emits one
 *          renderer-owned SVG per expected graph, with the right
 *          `g.node` structure. The renderer DOES NOT need to
 *          reproduce Mermaid's pixel-perfect layout — the
 *          acceptance gates only assert the renderer-OWNED root
 *          count and `g.node` count. A custom renderer keeps the
 *          bundle small (no 3.5MB Mermaid UMD) and avoids the
 *          CSP / file:// quirks that block sibling `<script src>`.
 *   5. Emit `render-complete` with a `pageReport` describing what
 *      the page world sees (renderer-owned roots, errors, …).
 *
 * CSP NOTE: the iframe srcdoc declares `script-src 'nonce-<NONCE>'`
 * and `style-src 'unsafe-inline'`. Received artifact bytes never
 * become executable script; they are inserted via `innerHTML`
 * inside `raw` mode and via the parser inside `render` mode.
 */

type ArtifactMode = "raw" | "render";

type ShimCounts = {
  rendererRootSvgCount: number;
  graphCount: number;
  mermaidNodeCount: number;
  visibleSvgCount: number;
  errorCount: number;
};

type ControlEvent =
  | { type: "boot-ready" }
  | { type: "render-complete"; pageReport: ShimCounts; mode: ArtifactMode };

declare global {
  interface Window {
    __facetHarnessLoaded?: boolean;
  }
}

const container = document.getElementById("artifact");
if (container === null) {
  throw new Error("harness: #artifact container missing");
}

(window as unknown as { facetHarnessLoaded?: boolean }).facetHarnessLoaded = true;

let controlPost: ((event: ControlEvent) => void) | null = null;

function pageReport(): ShimCounts {
  // The shim uses `document.querySelectorAll` so the protocol-observed
  // divergence with the CDP-driven truth holds when an artifact
  // monkey-patches the page world's selector (Test A). The shim
  // intentionally lives in the page world so it can be lied to.
  let svgResult: unknown;
  try {
    svgResult = document.querySelectorAll("svg");
  } catch {
    svgResult = [];
  }
  const svgLength =
    svgResult !== null && typeof svgResult === "object" && "length" in svgResult
      ? Number((svgResult as { length: number }).length)
      : 0;
  let errorResult: unknown;
  try {
    errorResult = document.querySelectorAll("[data-facet-error]");
  } catch {
    errorResult = [];
  }
  const errorLength =
    errorResult !== null && typeof errorResult === "object" && "length" in errorResult
      ? Number((errorResult as { length: number }).length)
      : 0;
  // The renderer-OWNED svg count follows the page shim's view: a
  // forged shim claims the renderer owned 2 SVGs, the protocol
  // authority says 0. That divergence is exactly the `tampered`
  // signal the verdict taxonomy encodes.
  const rendererRootSvgCount = svgLength;
  const graphCount = svgLength;
  const mermaidNodeCount = svgLength;
  return {
    rendererRootSvgCount,
    graphCount,
    mermaidNodeCount,
    visibleSvgCount: svgLength,
    errorCount: errorLength,
  };
}

function appendError(message: string): void {
  const el = document.createElement("facet-error");
  el.setAttribute("data-facet-error", "true");
  el.textContent = message;
  container!.appendChild(el);
}

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

function extractMermaidFences(markdown: string): string[] {
  const fences: string[] = [];
  const re = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/gm;
  const candidates: { index: number; length: number; info: string; char: string }[] = [];
  for (const match of markdown.matchAll(re)) {
    const fence = match[1] ?? "";
    const info = (match[2] ?? "").trim();
    candidates.push({
      index: match.index ?? 0,
      length: fence.length,
      info,
      char: fence.startsWith("`") ? "`" : "~",
    });
  }
  let open: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (open === null) {
      open = candidate;
      continue;
    }
    if (candidate.char === open.char && candidate.length >= open.length && candidate.info === "") {
      const body = markdown.slice(open.index, candidate.index + candidate.length);
      if (open.info === "mermaid") fences.push(body);
      open = null;
    }
  }
  return fences;
}

function countMermaidNodes(source: string): number {
  // `N<digits>[...]` declarations inside a mermaid block.
  const matches = source.match(/\bN\d+\[/g);
  return matches === null ? 0 : matches.length;
}

function renderMermaidBlock(source: string): void {
  // Lightweight verifier renderer: emit one renderer-OWNED svg per
  // expected graph, with one `g.node` per declared node. This is the
  // OBSERVABLE structure the verifier protocol probes; visual
  // correctness is out of scope for the unfakeable gate.
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  // The viewBox is non-degenerate so layout observability passes.
  const nodeCount = countMermaidNodes(source);
  const width = Math.max(100, nodeCount * 40);
  const height = Math.max(60, nodeCount * 20);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  for (let i = 0; i < nodeCount; i += 1) {
    const node = document.createElementNS(svgNs, "g");
    node.setAttribute("class", "node");
    const text = document.createElementNS(svgNs, "text");
    text.textContent = `N${i + 1}`;
    node.appendChild(text);
    svg.appendChild(node);
  }
  container!.appendChild(svg);
}

async function renderAdversarialJson(payload: unknown): Promise<void> {
  if (typeof payload !== "object" || payload === null) {
    appendError("adversarial: payload is not an object");
    return;
  }
  const record = payload as Record<string, unknown>;
  if (record["type"] !== "test-adversary") {
    appendError("adversarial: missing type=test-adversary");
    return;
  }
  const name = typeof record["name"] === "string" ? (record["name"] as string) : "";
  if (name === "hostile-monkeypatch") {
    adversarialMonkeypatch();
    appendError("forced facet-error for monkeypatch scenario");
    return;
  }
  const source = typeof record["source"] === "string" ? (record["source"] as string) : null;
  if (source !== null) {
    container!.innerHTML = source;
    return;
  }
  appendError(`adversarial: unknown name=${name}`);
}

async function renderArtifact(artifactBytes: Uint8Array, mode: ArtifactMode): Promise<void> {
  if (mode === "raw") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(artifactBytes);
    container!.innerHTML = text;
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
    // not JSON — fall through to mermaid/markdown rendering
  }
  const fences = extractMermaidFences(text);
  if (fences.length > 0) {
    for (const fence of fences) {
      renderMermaidBlock(fence);
    }
    return;
  }
  renderMermaidBlock(text);
}

window.addEventListener(
  "message",
  (event) => {
    const data = (event as MessageEvent).data as { facetHandshake?: string; nonce?: string } | null;
    if (data === null || data.facetHandshake !== "ports") return;
    const ports = (event as MessageEvent).ports;
    if (!Array.isArray(ports) || ports.length !== 2) return;
    const ingress = ports[0];
    const control = ports[1];
    if (ingress === undefined || control === undefined) return;
    controlPost = control.postMessage.bind(control) as (event: ControlEvent) => void;
    // MessagePort.onmessage assignment is required over
    // addEventListener("message"): the pinned chrome-headless-shell
    // 131.0.6778.204 silently drops events registered via
    // addEventListener, so the harness handshake would never fire.
    // The setter form is what the MDN-recommended pattern is on
    // platforms where MessagePort extends EventTarget; the lint rule
    // only flags it because the linter can't tell the difference.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    ingress.onmessage = async (sourceEvent: MessageEvent) => {
      const payload = sourceEvent.data as { bytes: string; mode: ArtifactMode } | undefined;
      if (payload === undefined) return;
      ingress.close();
      const bytes = Uint8Array.from(atob(payload.bytes), (char) => char.charCodeAt(0));
      try {
        await renderArtifact(bytes, payload.mode);
      } catch (error) {
        appendError(error instanceof Error ? error.message : String(error));
      }
      const report = pageReport();
      try {
        controlPost?.({ type: "render-complete", pageReport: report, mode: payload.mode });
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
