/**
 * Gallery shell controller — DOM-touching surface.
 *
 * The shell is the loopback user's browser surface — title + revision
 * + status line, zoom/reset/fullscreen controls, the iframe canvas,
 * a terse error badge. ONE active-artifact view (no sidebar, no list).
 * The shell transforms the iframe ELEMENT for zoom/pan; fine pan/zoom
 * commands to the artifact cross ONLY the private control port.
 *
 * Pure helpers live in sibling modules (`frame-html.ts`, `swap.ts`,
 * `frame/bootstrap.ts`) so the security invariants are testable
 * without a browser harness. The DOM-mutating surface here is small
 * and thin over those helpers.
 *
 * The shell rejects a non-loopback hostname BEFORE any capability-bearing
 * code runs — DNS-rebinding defense at the trust boundary, not after.
 *
 * Swap model (double-buffered HMR): the new frame is built OFF-SCREEN,
 * the shell waits for its `boot-ready`, transfers the artifact bytes
 * ONCE over the one-shot ingress, waits for `render-complete`, and
 * only then swaps visibility, applies the preserved view state, closes
 * the old control port, and removes the old frame. A failed new frame
 * keeps the last-good frame visible and surfaces an error badge.
 */

import {
  assertLoopbackHostname,
  buildFrameAttributes,
  newFrameNonce,
  type FrameAttributes,
} from "./frame-html";
import { createChannelPair } from "./frame/channels";
import { planSwap, type SwapPlanStep } from "./swap";
import { connectRevisionStream } from "./sse-client";
import {
  clampZoom,
  resetViewState,
  validateViewIntent,
  validateViewMode,
  zoomAtPoint,
  type ViewIntent,
  type ViewMode,
  type ViewState,
} from "./view-state";
import type { Verdict } from "../shared/contracts/validation";

// Re-exports — the gate test + sibling modules import these from `app`
// for the v0.1 public surface.
export {
  FROZEN_CSP_TEMPLATE,
  assertLoopbackHostname,
  buildFrameAttributes,
  buildFrameDocument,
  isLoopbackHostname,
  newFrameNonce,
  type FrameAttributes,
} from "./frame-html";
export { planSwap, type SwapPlanStep } from "./swap";
export { connectRevisionStream } from "./sse-client";

export interface BootstrapHandoff {
  readonly authorization: string;
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly lease: { readonly leaseId: string; readonly expiresAt: number };
  readonly headers: Headers;
}

export function buildGalleryUrl(baseUrl: string, bootstrapToken: string): string {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/gallery`);
  if (url.hostname !== "127.0.0.1") throw new Error("Gallery URL must be loopback-only");
  url.hash = `bootstrap=${encodeURIComponent(bootstrapToken)}`;
  return url.toString();
}

export async function consumeBootstrapHandoff(options: {
  readonly location: string;
  readonly fetchImpl?: typeof fetch;
  readonly clearFragment?: () => void;
}): Promise<BootstrapHandoff> {
  const location = new URL(options.location);
  assertLoopbackHostname(location.hostname);
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = params.get("bootstrap");
  if (token === null || token.length === 0)
    throw new Error("Gallery bootstrap capability is missing");
  options.clearFragment?.();
  const fetcher = options.fetchImpl ?? fetch;
  const response = await fetcher(`${location.origin}/api/v1/gallery/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error(`Gallery bootstrap failed (${response.status})`);
  const payload = (await response.json()) as Omit<BootstrapHandoff, "headers">;
  const headers = new Headers({
    authorization: payload.authorization,
    "x-gallery-lease": payload.lease.leaseId,
    "x-gallery-artifact": payload.artifactId,
  });
  return { ...payload, headers };
}

export async function releaseDisplayLease(options: {
  readonly baseUrl: string;
  readonly authorization: string;
  readonly artifactId: string;
  readonly leaseId: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<void> {
  const url = new URL(options.baseUrl);
  assertLoopbackHostname(url.hostname);
  const fetcher = options.fetchImpl ?? fetch;
  await fetcher(`${url.origin}/api/v1/gallery/release`, {
    method: "POST",
    headers: {
      authorization: options.authorization,
      "x-gallery-lease": options.leaseId,
      "x-gallery-artifact": options.artifactId,
    },
  });
}

/**
 * Public surface of the shell — names only. Used by the gate test to
 * assert no list/sidebar/multi-frame APIs exist (single-artifact view).
 */
export const SHELL_EXPORTS = [
  "createArtifactFrame",
  "replaceArtifactFrame",
  "connectRevisionStream",
] as const;

/**
 * Minimal DOM interface the shell needs. Injected so the DOM-touching
 * code is testable without a real document; in production the shell
 * passes `document` from the browser.
 */
export interface ShellDom {
  readonly document: Document;
  readonly MessageChannel: new () => { port1: MessagePort; port2: MessagePort };
  readonly hostname: string;
  readonly window: { postMessage?: unknown };
}

/** View state the shell preserves across a swap. */
export type { ViewIntent, ViewState } from "./view-state";

/**
 * Control-port events the frame emits to the shell. The frame's
 * page-shim counts ride `render-complete.observed`.
 */
interface FrameObserved {
  readonly rendererRootSvgCount: number;
  readonly graphCount: number;
  readonly mermaidNodeCount: number;
  readonly visibleSvgCount: number;
  readonly opaqueRegionCount: number;
  readonly errorCount: number;
}

export interface FrameControlEvent {
  readonly type: string;
  readonly mode?: string;
  readonly observed?: FrameObserved;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateObserved(value: unknown): FrameObserved | null {
  if (value === null || typeof value !== "object") return null;
  const observed = value as Record<string, unknown>;
  const keys = [
    "rendererRootSvgCount",
    "graphCount",
    "mermaidNodeCount",
    "visibleSvgCount",
    "opaqueRegionCount",
    "errorCount",
  ];
  const rendererRootSvgCount = observed.rendererRootSvgCount;
  const graphCount = observed.graphCount;
  const mermaidNodeCount = observed.mermaidNodeCount;
  const visibleSvgCount = observed.visibleSvgCount;
  const opaqueRegionCount = observed.opaqueRegionCount;
  const errorCount = observed.errorCount;
  if (
    Object.keys(observed).length !== keys.length ||
    !finite(rendererRootSvgCount) ||
    !finite(graphCount) ||
    !finite(mermaidNodeCount) ||
    !finite(visibleSvgCount) ||
    !finite(opaqueRegionCount) ||
    !finite(errorCount)
  )
    return null;
  return {
    rendererRootSvgCount,
    graphCount,
    mermaidNodeCount,
    visibleSvgCount,
    opaqueRegionCount,
    errorCount,
  };
}

function validateFrameControlEvent(value: unknown): FrameControlEvent | null {
  if (value === null || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string" || "kind" in event) return null;
  if (event.type === "view-intent") return validateViewIntent(event);
  if (event.type === "view-mode") {
    const mode = validateViewMode(event);
    return mode === null ? null : { type: "view-mode", mode };
  }
  if (event.type === "boot-ready")
    return Object.keys(event).length === 1 ? { type: event.type } : null;
  if (event.type !== "render-complete" || Object.keys(event).length !== 2) return null;
  const observed = validateObserved(event.observed);
  return observed === null ? null : { type: event.type, observed };
}

export interface CreateArtifactFrameOptions {
  readonly artifactType: string;
  /** Legacy direct callers omit this; revision source fetches always make it explicit. */
  readonly renderer?: string;
  readonly bootstrapUrl: string;
  readonly frameUrl?: string;
  readonly dom: ShellDom;
  readonly nonce?: string;
}

/**
 * Host-side element handle. `raw` is the real HTMLIFrameElement in
 * production; the FrameHost adapter is the only surface that touches
 * it, so test hosts can substitute a recording stub.
 */
export interface FrameElementHandle {
  setAttribute(name: string, value: string): void;
  readonly raw: unknown;
}

export interface CreatedArtifactFrame {
  readonly frameId: string;
  readonly nonce: string;
  readonly attrs: FrameAttributes;
  /** Caller transfers these into the iframe via postMessage. */
  readonly frameIngressPort: MessagePort;
  readonly frameControlPort: MessagePort;
  /** Shell-side control surface. */
  readonly deliverSource: (payload: unknown) => void;
  readonly sendControl: (payload: unknown) => void;
  readonly closeControl: () => void;
  /** Control-port RECEIVE path (frame → shell). Returns an unsubscribe. */
  readonly onControlEvent: (handler: (event: FrameControlEvent) => void) => () => void;
  /**
   * Resolve with the next control event of the given type, or null on
   * timeout. This is the async boot-ready / render-complete wait.
   */
  readonly awaitControlEvent: (
    type: string,
    timeoutMs: number,
  ) => Promise<FrameControlEvent | null>;
  /**
   * Element wired with the attributes above. The caller mounts it via
   * a FrameHost. Kept abstract so the test gate can stub.
   */
  readonly element: FrameElementHandle;
}

/**
 * DOM adapter the swap executes against. Production binds it to the
 * real document; tests bind a recording stub. The shell never touches
 * the iframe element outside this surface.
 */
export interface FrameHost {
  /** Mount a frame element off-screen (loaded, but not visible). */
  mountOffScreen(frameId: string, element: unknown): void;
  /** Swap visibility. */
  setVisibility(frameId: string, visible: boolean): void;
  /** Remove the frame element from the document. */
  unmount(frameId: string): void;
  /** Apply the preserved view state transform to the frame element. */
  applyViewState(frameId: string, viewState: ViewState): void;
  /** Terse error badge — failed swaps keep the last-good frame. */
  showErrorBadge(message: string): void;
}

/**
 * Create a fresh artifact frame: build the loopback document URL, mint a per-frame
 * nonce, open two MessageChannels, hold port1 of each. The returned
 * `frameIngressPort` + `frameControlPort` MUST be transferred into the
 * frame via `frame.contentWindow.postMessage({facetHandshake: "ports",
 * nonce}, targetOrigin, ports)` AFTER the iframe's `load` event fires.
 */
export function createArtifactFrame(options: CreateArtifactFrameOptions): CreatedArtifactFrame {
  const dom = options.dom;
  // DNS-rebinding guard — fires BEFORE the iframe is appended or any
  // capability code runs.
  assertLoopbackHostname(dom.hostname);
  const nonce = options.nonce ?? newFrameNonce();
  const frameUrl = new URL(options.frameUrl ?? "/gallery/frame", `http://${dom.hostname}`);
  frameUrl.searchParams.set("nonce", nonce);
  frameUrl.searchParams.set("type", options.artifactType);
  frameUrl.searchParams.set("renderer", options.renderer ?? "svg");
  const attrs = buildFrameAttributes(frameUrl.toString());
  const channels = createChannelPair({ messageChannelCtor: dom.MessageChannel });
  const element = dom.document.createElement("iframe");
  element.setAttribute("sandbox", attrs.sandbox);
  element.setAttribute("referrerpolicy", attrs.referrerpolicy);
  element.setAttribute("allow", attrs.allow);
  element.setAttribute("title", attrs.title);
  element.setAttribute("src", attrs.src);
  const frameId = `frame-${crypto.randomUUID()}`;

  // Control-port RECEIVE path. MessagePort.onmessage setter form with
  // a handler registry: one port listener, many subscribers.
  const controlHandlers = new Set<(event: FrameControlEvent) => void>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  channels.controlPort.onmessage = (event: MessageEvent) => {
    const data = validateFrameControlEvent(event.data);
    if (data === null) return;
    // Spread snapshots the handler set so a handler that unsubscribes
    // itself mid-dispatch does not skip the remaining peers.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const handler of [...controlHandlers]) handler(data);
  };

  return {
    frameId,
    nonce,
    attrs,
    frameIngressPort: channels.frameIngressPort,
    frameControlPort: channels.frameControlPort,
    deliverSource: channels.deliverSource,
    sendControl: channels.sendControl,
    closeControl: channels.closeControl,
    onControlEvent(handler) {
      controlHandlers.add(handler);
      return () => {
        controlHandlers.delete(handler);
      };
    },
    awaitControlEvent(type, timeoutMs) {
      return new Promise<FrameControlEvent | null>((resolve) => {
        let unsubscribe: (() => void) | null = null;
        const timer = setTimeout(() => {
          unsubscribe?.();
          resolve(null);
        }, timeoutMs);
        unsubscribe = ((handler: (event: FrameControlEvent) => void) => {
          controlHandlers.add(handler);
          return () => {
            controlHandlers.delete(handler);
          };
        })((event) => {
          if (event.type !== type) return;
          clearTimeout(timer);
          unsubscribe?.();
          resolve(event);
        });
      });
    },
    element: {
      setAttribute(name: string, value: string): void {
        element.setAttribute(name, value);
      },
      raw: element,
    },
  };
}

export interface ReplaceArtifactFrameOptions {
  readonly current: CreatedArtifactFrame;
  readonly next: CreatedArtifactFrame;
  readonly dom: ShellDom;
  readonly host: FrameHost;
  readonly viewState: ViewState;
  /** Artifact payload transferred to the new frame exactly once. */
  readonly source?: unknown;
  /** Per-barrier wait window (boot-ready, then render-complete). */
  readonly readyTimeoutMs?: number;
  readonly onProgress?: (state: "ready" | "complete") => void;
}

export interface ReplaceArtifactFrameResult {
  readonly executedSteps: readonly SwapPlanStep["name"][];
  readonly failedNewFrameReady: boolean;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;

function observedErrorCount(event: FrameControlEvent): number {
  const count = event.observed?.errorCount;
  return typeof count === "number" ? count : 0;
}

function viewStateMessage(state: ViewState): {
  readonly type: "view-state";
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
} {
  return { type: "view-state", zoom: state.zoom, panX: state.panX ?? 0, panY: state.panY ?? 0 };
}

/**
 * Execute a double-buffered HMR swap against the real DOM. Ordering
 * invariant: the new frame is built off-screen, reaches boot-ready +
 * render-complete, and only THEN swaps in — the old frame is removed
 * last. View state is preserved across the swap. If the new frame
 * fails to reach a clean render-complete within the wait window, the
 * old frame stays visible with an error badge and the failed new
 * frame's channels + element are torn down.
 */
export async function replaceArtifactFrame(
  options: ReplaceArtifactFrameOptions,
): Promise<ReplaceArtifactFrameResult> {
  const { current, next, dom, host, viewState } = options;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  assertLoopbackHostname(dom.hostname);
  const plan = planSwap({
    currentFrameId: current.frameId,
    nextFrameId: next.frameId,
    viewState,
  });
  const executed: SwapPlanStep["name"][] = [];
  // The plan's step list executes against the real DOM through these
  // runners; the async boot-ready/render-complete barrier runs between
  // `open-new-control` and `new-frame-ready`.
  const runners: Record<SwapPlanStep["name"], () => void> = {
    "build-new": () => host.mountOffScreen(next.frameId, next.element.raw),
    "open-new-control": () => {
      // The control channel opens at frame creation and stays open
      // across the swap; nothing to do here.
    },
    "new-frame-ready": () => {
      // Awaited below; this step records the barrier passed.
    },
    swap: () => {
      host.setVisibility(next.frameId, true);
      host.setVisibility(current.frameId, false);
    },
    "apply-view-state": () => {
      next.sendControl(viewStateMessage(viewState));
      host.applyViewState(next.frameId, viewState);
    },
    "close-old-control": () => current.closeControl(),
    "remove-old": () => host.unmount(current.frameId),
  };
  const runStep = (step: SwapPlanStep): void => {
    runners[step.name]();
    executed.push(step.name);
  };

  // build-new + open-new-control run BEFORE the barrier: the iframe
  // must be mounted off-screen to load and boot.
  for (const step of plan.slice(0, 2)) runStep(step);

  // Async boot-ready WAIT before the swap.
  const bootReady = await next.awaitControlEvent("boot-ready", readyTimeoutMs);
  let renderComplete: FrameControlEvent | null = null;
  if (bootReady !== null) {
    options.onProgress?.("ready");
    if (options.source !== undefined) next.deliverSource(options.source);
    renderComplete = await next.awaitControlEvent("render-complete", readyTimeoutMs);
  }
  const ready =
    bootReady !== null && renderComplete !== null && observedErrorCount(renderComplete) === 0;

  if (!ready) {
    // Failed new frame: keep the last-good frame visible, surface the
    // badge, and tear the failed frame down (channels + element).
    host.showErrorBadge("new revision failed to render; keeping last good revision");
    next.closeControl();
    host.unmount(next.frameId);
    return { executedSteps: executed, failedNewFrameReady: true };
  }

  // new-frame-ready → … → remove-old: the rest of the plan, in order.
  for (const step of plan.slice(2)) runStep(step);
  options.onProgress?.("complete");
  return { executedSteps: executed, failedNewFrameReady: false };
}

export interface RevisionFetchResult {
  readonly artifactType: string;
  readonly renderer: string;
  readonly bytes: Uint8Array;
  readonly verdict?: Verdict | null;
}

export interface SwapToRevisionDeps {
  readonly dom: ShellDom;
  readonly host: FrameHost;
  readonly bootstrapUrl: string;
  readonly frameUrl?: string;
  /** Fetch the exact revision bytes the SSE event named. */
  readonly fetchRevision: (artifactId: string, revisionSha: string) => Promise<RevisionFetchResult>;
  readonly readyTimeoutMs?: number;
  readonly onProgress?: (state: "ready" | "complete") => void;
  /**
   * Called with the fresh frame BEFORE the swap runs — production
   * uses it to transfer the port ends into the iframe once the load
   * event fires; tests use it to play the frame side.
   */
  readonly onFrameCreated?: (frame: CreatedArtifactFrame) => void;
}

export interface RevisionEvent {
  readonly artifactId: string;
  readonly revisionSha: string;
}

/**
 * publish→visible, one revision at a time: fetch the exact revision
 * the committed event named, build a FRESH opaque frame for it, and
 * run the double-buffered swap. The returned frame becomes `current`
 * for the next revision. Bytes cross the ingress exactly once; every
 * revision gets its own nonce, srcdoc, and channels — no artifact-JS
 * carryover between revisions.
 */
export async function swapToRevision(
  deps: SwapToRevisionDeps,
  current: CreatedArtifactFrame,
  event: RevisionEvent,
  viewState: ViewState,
): Promise<{
  readonly frame: CreatedArtifactFrame;
  readonly result: ReplaceArtifactFrameResult;
  readonly verdict: Verdict | null;
}> {
  const revision = await deps.fetchRevision(event.artifactId, event.revisionSha);
  const next = createArtifactFrame({
    artifactType: revision.artifactType,
    renderer: revision.renderer,
    bootstrapUrl: deps.bootstrapUrl,
    dom: deps.dom,
    ...(deps.frameUrl === undefined ? {} : { frameUrl: deps.frameUrl }),
  });
  deps.onFrameCreated?.(next);
  const result = await replaceArtifactFrame({
    current,
    next,
    dom: deps.dom,
    host: deps.host,
    viewState,
    source: {
      artifactType: revision.artifactType,
      renderer: revision.renderer,
      bytes: revision.bytes,
    },
    ...(deps.onProgress === undefined ? {} : { onProgress: deps.onProgress }),
    ...(deps.readyTimeoutMs !== undefined ? { readyTimeoutMs: deps.readyTimeoutMs } : {}),
  });
  return {
    frame: result.failedNewFrameReady ? current : next,
    result,
    verdict: revision.verdict ?? null,
  };
}

interface GallerySourceResponse {
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly artifactType: string;
  readonly renderer?: string;
  readonly source: string;
  readonly verdict: Verdict | null;
}

async function fetchGallerySource(
  baseUrl: string,
  handoff: BootstrapHandoff,
  revisionSha: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RevisionFetchResult> {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/api/v1/gallery/source`);
  assertLoopbackHostname(url.hostname);
  url.searchParams.set("revisionSha", revisionSha);
  const response = await fetchImpl(url, {
    headers: {
      authorization: handoff.authorization,
      "x-gallery-lease": handoff.lease.leaseId,
      "x-gallery-artifact": handoff.artifactId,
    },
  });
  if (!response.ok) throw new Error(`Gallery source fetch failed (${response.status})`);
  const payload = (await response.json()) as GallerySourceResponse;
  return {
    artifactType: payload.artifactType,
    renderer: payload.renderer ?? "svg",
    bytes: new TextEncoder().encode(payload.source),
    verdict: payload.verdict ?? null,
  };
}

function setGalleryStatus(document: Document, status: string): void {
  const target = document.getElementById("facet-status-line");
  if (target !== null) target.textContent = status;
}

function setGalleryError(document: Document, message: string): void {
  const target = document.getElementById("facet-error");
  if (target !== null) target.textContent = message;
}

function setGalleryVerdict(document: Document, verdict: Verdict | null): void {
  const badge = document.getElementById("facet-verdict");
  const evidence = document.getElementById("facet-evidence");
  if (badge === null || badge === undefined) return;
  const tier = badge.querySelector<HTMLElement>(".tier");
  if (verdict === null) {
    badge.dataset.status = "unverified";
    badge.childNodes[0]!.textContent = "unverified";
    if (tier !== null) tier.textContent = "";
    if (evidence !== null) evidence.hidden = true;
    return;
  }
  badge.dataset.status = verdict.status;
  badge.childNodes[0]!.textContent = verdict.status.split(":")[0] ?? verdict.status;
  if (tier !== null) {
    const detail =
      verdict.status === "partial:opaque_content"
        ? "opaque"
        : verdict.status === "partial:layout_unverified"
          ? "layout"
          : null;
    const insecure = verdict.insecure === undefined ? null : `INSECURE L${verdict.insecure.level}`;
    const suffix = insecure === null ? `T${verdict.tier}` : `${insecure} · T${verdict.tier}`;
    tier.textContent = detail === null ? `· ${suffix}` : `· ${detail} · ${suffix}`;
  }
  const observed = verdict.observed;
  const counts = document.getElementById("facet-evidence-counts");
  if (counts !== null)
    counts.textContent = `svg ${observed.rendererRootSvgCount} · graphs ${observed.graphCount} · nodes ${observed.mermaidNodeCount} · opaque ${observed.opaqueRegionCount} · errors ${observed.errorCount}`;
  const channels = document.getElementById("facet-evidence-channels");
  if (channels !== null) {
    channels.dataset.agree = verdict.status === "tampered" ? "false" : "true";
    channels.textContent =
      verdict.status === "tampered"
        ? "●≠●"
        : verdict.status === "timeout"
          ? "○○○"
          : verdict.status === "shim_only"
            ? "○○●"
            : verdict.status === "probe_only"
              ? "●○○"
              : "●●●";
  }
  const sha = document.getElementById("facet-evidence-sha");
  if (sha !== null) sha.textContent = verdict.revisionSha.slice(0, 8);
  const divergence = document.getElementById("facet-evidence-divergence");
  if (divergence !== null) {
    const detail = verdict.observed.discriminativeErrors?.[0]?.message;
    divergence.textContent = verdict.status === "tampered" ? (detail ?? "channels disagree") : "";
  }
  if (evidence !== null) evidence.hidden = false;
}

function setLiveState(document: Document, state: "idle" | "connecting" | "live"): void {
  const live = document.getElementById("facet-live");
  const label = document.getElementById("facet-live-label");
  if (live !== null) live.dataset.state = state;
  if (label !== null) label.textContent = state;
}

function setSwapBar(
  document: Document,
  window: Window,
  state: "start" | "ready" | "complete" | "failed",
): void {
  const swapbar = document.getElementById("facet-swapbar");
  const bar = swapbar?.querySelector<HTMLElement>(".bar");
  if (swapbar === null || swapbar === undefined || bar === null || bar === undefined) return;
  if (state === "start") {
    delete swapbar.dataset.failed;
    swapbar.hidden = false;
    bar.style.width = "34%";
  } else if (state === "ready") {
    bar.style.width = "80%";
  } else if (state === "complete") {
    bar.style.width = "100%";
    window.setTimeout(() => {
      swapbar.hidden = true;
    }, 200);
  } else {
    swapbar.dataset.failed = "";
    bar.style.width = "0%";
    window.setTimeout(() => {
      swapbar.hidden = true;
    }, 2_000);
  }
}

function armFrameLoad(
  frame: CreatedArtifactFrame,
  mount: (frame: CreatedArtifactFrame) => void,
): Promise<FrameControlEvent | null> {
  const element = frame.element.raw as HTMLIFrameElement;
  return new Promise((resolve) => {
    element.addEventListener(
      "load",
      () => {
        element.contentWindow?.postMessage({ facetHandshake: "ports", nonce: frame.nonce }, "*", [
          frame.frameIngressPort,
          frame.frameControlPort,
        ]);
        void frame.awaitControlEvent("boot-ready", DEFAULT_READY_TIMEOUT_MS).then(resolve);
      },
      { once: true },
    );
    // Mount AFTER the listener is armed: a detached iframe never loads, so
    // mounting inside the load handler deadlocks on an event that can only
    // fire once mounted. The swap path (`planSwap` build-new) orders it the
    // same way.
    mount(frame);
  });
}

export interface GalleryRuntime {
  readonly window: Window;
  readonly document: Document;
  readonly history: History;
  readonly HTMLElement: typeof HTMLElement;
  readonly MessageChannel: typeof MessageChannel;
  readonly fetch: typeof fetch;
}

function browserGalleryRuntime(): GalleryRuntime {
  return { window, document, history, HTMLElement, MessageChannel, fetch };
}

export async function startGallery(runtime = browserGalleryRuntime()): Promise<void> {
  const { window, document, history, HTMLElement, MessageChannel, fetch } = runtime;
  const updateGalleryStatus = (status: string): void => setGalleryStatus(document, status);
  const updateGalleryError = (message: string): void => setGalleryError(document, message);
  const updateGalleryVerdict = (verdict: Verdict | null): void =>
    setGalleryVerdict(document, verdict);
  const updateLiveState = (state: "idle" | "connecting" | "live"): void =>
    setLiveState(document, state);
  const updateSwapBar = (state: "start" | "ready" | "complete" | "failed"): void =>
    setSwapBar(document, window, state);
  const baseUrl = window.location.origin;
  const handoff = await consumeBootstrapHandoff({
    location: window.location.href,
    clearFragment: () => history.replaceState(null, "", window.location.pathname),
    fetchImpl: fetch,
  });
  const title = document.getElementById("facet-title");
  const revision = document.getElementById("facet-revision");
  if (title !== null) title.textContent = "facet";
  if (revision !== null) revision.textContent = handoff.revisionSha.slice(0, 12);
  updateGalleryStatus("idle");
  updateLiveState("connecting");
  const bootstrapUrl = `${baseUrl}/gallery/frame/bootstrap.js`;
  const frameUrl = `${baseUrl}/gallery/frame`;
  const canvas = document.getElementById("facet-canvas");
  if (!(canvas instanceof HTMLElement)) throw new Error("Gallery canvas is missing");
  const viewState: ViewState = { zoom: 1, panX: 0, panY: 0 };
  const viewModes = new Map<string, ViewMode>();
  let activeFrameId: string | null = null;
  const host: FrameHost = {
    mountOffScreen(frameId, element) {
      const iframe = element as HTMLIFrameElement;
      iframe.dataset.frameId = frameId;
      iframe.style.visibility = "hidden";
      iframe.style.transformOrigin = "top left";
      iframe.classList.add("facet-ready");
      canvas.appendChild(iframe);
      const empty = document.getElementById("facet-empty");
      if (empty !== null) empty.hidden = true;
    },
    setVisibility(frameId, visible) {
      const iframe = canvas.querySelector<HTMLIFrameElement>(`[data-frame-id="${frameId}"]`);
      if (iframe !== null) iframe.style.visibility = visible ? "visible" : "hidden";
      if (visible) {
        activeFrameId = frameId;
        canvas.dataset.viewMode = viewModes.get(frameId) ?? "css";
      }
    },
    unmount(frameId) {
      canvas.querySelector<HTMLIFrameElement>(`[data-frame-id="${frameId}"]`)?.remove();
    },
    applyViewState(frameId, state) {
      const iframe = canvas.querySelector<HTMLIFrameElement>(`[data-frame-id="${frameId}"]`);
      if (iframe === null) return;
      iframe.style.transform =
        viewModes.get(frameId) === "native"
          ? ""
          : `translate(${state.panX ?? 0}px, ${state.panY ?? 0}px) scale(${state.zoom})`;
    },
    showErrorBadge: updateGalleryError,
  };
  const dom: ShellDom = { document, MessageChannel, hostname: window.location.hostname, window };
  const source = await fetchGallerySource(baseUrl, handoff, handoff.revisionSha, fetch);
  let current = createArtifactFrame({
    artifactType: source.artifactType,
    renderer: source.renderer,
    bootstrapUrl,
    frameUrl,
    dom,
  });
  const bindFrameMode = (frame: CreatedArtifactFrame): void => {
    frame.onControlEvent((event) => {
      const mode = validateViewMode(event);
      if (mode === null) return;
      viewModes.set(frame.frameId, mode);
      if (activeFrameId === frame.frameId) canvas.dataset.viewMode = mode;
      host.applyViewState(frame.frameId, viewState);
    });
  };
  bindFrameMode(current);
  const boot = await armFrameLoad(current, (frame) =>
    host.mountOffScreen(frame.frameId, frame.element.raw),
  );
  if (boot === null) throw new Error("Gallery frame failed to boot");
  current.deliverSource({
    artifactType: source.artifactType,
    renderer: source.renderer,
    bytes: source.bytes,
  });
  const initialEvent = await current.awaitControlEvent("render-complete", DEFAULT_READY_TIMEOUT_MS);
  if (initialEvent === null || observedErrorCount(initialEvent) !== 0)
    throw new Error("Gallery artifact failed to render");
  host.setVisibility(current.frameId, true);
  current.sendControl(viewStateMessage(viewState));
  host.applyViewState(current.frameId, viewState);
  updateGalleryVerdict(source.verdict ?? null);
  updateGalleryStatus("displayed");
  updateLiveState("live");
  const stream = connectRevisionStream({
    baseUrl,
    bearer: handoff.authorization.replace(/^Bearer\s+/i, ""),
    leaseId: handoff.lease.leaseId,
    artifactId: handoff.artifactId,
    hostname: window.location.hostname,
    onState: updateLiveState,
    onCommit: (event) => {
      updateGalleryStatus("swapping");
      updateSwapBar("start");
      updateGalleryVerdict(null);
      void swapToRevision(
        {
          dom,
          host,
          bootstrapUrl,
          frameUrl,
          fetchRevision: (_artifactId, revisionSha) =>
            fetchGallerySource(baseUrl, handoff, revisionSha, fetch),
          onFrameCreated: (next) => {
            bindFrameMode(next);
            bindFrameIntents(next);
            void armFrameLoad(next, (frame) =>
              host.mountOffScreen(frame.frameId, frame.element.raw),
            );
          },
          onProgress: updateSwapBar,
        },
        current,
        event,
        viewState,
      )
        .then(({ frame, result, verdict }) => {
          current = frame;
          if (!result.failedNewFrameReady) {
            if (revision !== null) revision.textContent = event.revisionSha.slice(0, 12);
            updateGalleryVerdict(verdict);
            updateGalleryStatus("displayed");
            updateSwapBar("complete");
          } else {
            updateSwapBar("failed");
            updateGalleryVerdict(null);
            updateGalleryStatus("displayed");
          }
        })
        .catch((error: unknown) => {
          updateSwapBar("failed");
          updateGalleryStatus("displayed");
          updateGalleryError(error instanceof Error ? error.message : String(error));
        });
    },
    onClose: () => {
      updateLiveState("idle");
      updateGalleryStatus("idle");
    },
  });
  const shutdown = (): void => {
    stream.close();
    void releaseDisplayLease({
      baseUrl,
      authorization: handoff.authorization,
      artifactId: handoff.artifactId,
      leaseId: handoff.lease.leaseId,
      fetchImpl: fetch,
    });
  };
  window.addEventListener("beforeunload", shutdown, { once: true });

  const applyIntent = (intent: ViewIntent): void => {
    if (intent.mode === "pan") {
      viewState.panX = (viewState.panX ?? 0) + intent.dx;
      viewState.panY = (viewState.panY ?? 0) + intent.dy;
    } else {
      const factor = Math.exp(-intent.deltaY * 0.001);
      Object.assign(
        viewState,
        zoomAtPoint(viewState, clampZoom(viewState.zoom * factor), intent.cursorX, intent.cursorY),
      );
    }
    current.sendControl(viewStateMessage(viewState));
    host.applyViewState(current.frameId, viewState);
  };
  const forwardCanvasIntent = (intent: ViewIntent): void => applyIntent(intent);
  const bindFrameIntents = (frame: CreatedArtifactFrame): void => {
    frame.onControlEvent((event) => {
      const intent = validateViewIntent(event);
      if (intent !== null) forwardCanvasIntent(intent);
    });
  };
  bindFrameIntents(current);
  const canvasRect = (): DOMRect => canvas.getBoundingClientRect();
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = canvasRect();
      forwardCanvasIntent({
        type: "view-intent",
        mode: "zoom",
        deltaY: event.deltaY,
        cursorX: event.clientX - rect.left,
        cursorY: event.clientY - rect.top,
        rect: { w: rect.width, h: rect.height },
      });
    },
    { passive: false },
  );
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointermove", (event) => {
    if (drag === null) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag = { x: event.clientX, y: event.clientY };
    forwardCanvasIntent({ type: "view-intent", mode: "pan", dx, dy });
  });
  const endDrag = (event: PointerEvent): void => {
    drag = null;
    canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = "grab";
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.style.cursor = "grab";
  document.addEventListener("keydown", (event) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      const rect = canvasRect();
      applyIntent({
        type: "view-intent",
        mode: "zoom",
        deltaY: -100,
        cursorX: rect.width / 2,
        cursorY: rect.height / 2,
        rect: { w: rect.width, h: rect.height },
      });
    } else if (event.key === "-") {
      event.preventDefault();
      const rect = canvasRect();
      applyIntent({
        type: "view-intent",
        mode: "zoom",
        deltaY: 100,
        cursorX: rect.width / 2,
        cursorY: rect.height / 2,
        rect: { w: rect.width, h: rect.height },
      });
    } else if (event.key === "0") {
      event.preventDefault();
      Object.assign(viewState, resetViewState(viewState));
      current.sendControl(viewStateMessage(viewState));
      host.applyViewState(current.frameId, viewState);
    } else if (
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowDown"
    ) {
      event.preventDefault();
      const amount = event.shiftKey ? 50 : 10;
      const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
      const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
      applyIntent({ type: "view-intent", mode: "pan", dx, dy });
    }
  });
  for (const [id, delta] of [
    ["facet-zoom-in", 0.1],
    ["facet-zoom-out", -0.1],
  ] as const) {
    document.getElementById(id)?.addEventListener("click", () => {
      const rect = canvasRect();
      Object.assign(
        viewState,
        zoomAtPoint(viewState, viewState.zoom + delta, rect.width / 2, rect.height / 2),
      );
      current.sendControl(viewStateMessage(viewState));
      host.applyViewState(current.frameId, viewState);
    });
  }
  document.getElementById("facet-zoom-reset")?.addEventListener("click", () => {
    Object.assign(viewState, resetViewState(viewState));
    current.sendControl(viewStateMessage(viewState));
    host.applyViewState(current.frameId, viewState);
  });
  document
    .getElementById("facet-fullscreen")
    ?.addEventListener("click", () => void canvas.requestFullscreen());
}

if (
  typeof document !== "undefined" &&
  typeof window !== "undefined" &&
  document.getElementById("facet-canvas") !== null
) {
  void startGallery().catch((error: unknown) => {
    setGalleryStatus(document, "error");
    setGalleryError(document, error instanceof Error ? error.message : String(error));
  });
}
