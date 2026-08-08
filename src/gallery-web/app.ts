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
  buildFrameSrcdoc,
  newFrameNonce,
  type FrameAttributes,
} from "./frame-html";
import { planSwap, type SwapPlanStep } from "./swap";
import { connectRevisionStream } from "./sse-client";

// Re-exports — the gate test + sibling modules import these from `app`
// for the v0.1 public surface.
export {
  FROZEN_CSP_TEMPLATE,
  assertLoopbackHostname,
  buildFrameAttributes,
  buildFrameSrcdoc,
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
export interface ViewState {
  zoom: number;
}

/**
 * Control-port events the frame emits to the shell. The frame's
 * page-shim counts ride `render-complete.observed`.
 */
export interface FrameControlEvent {
  readonly type: string;
  readonly observed?: {
    readonly rendererRootSvgCount?: number;
    readonly graphCount?: number;
    readonly mermaidNodeCount?: number;
    readonly visibleSvgCount?: number;
    readonly errorCount?: number;
  };
}

export interface CreateArtifactFrameOptions {
  readonly bootstrapUrl: string;
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
  /** Apply the preserved view state (zoom transform) to the frame element. */
  applyViewState(frameId: string, viewState: ViewState): void;
  /** Terse error badge — failed swaps keep the last-good frame. */
  showErrorBadge(message: string): void;
}

/**
 * Create a fresh artifact frame: build the srcdoc, mint a per-frame
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
  const attrs = buildFrameAttributes();
  const srcdoc = buildFrameSrcdoc({
    nonce,
    bootstrapUrl: options.bootstrapUrl,
  });
  // Fresh channels per frame. port1 = shell side; port2 = frame side
  // (transferred on the postMessage handshake).
  const ingress = new dom.MessageChannel();
  const control = new dom.MessageChannel();
  let ingressDelivered = false;
  let controlOpen = true;
  const element = dom.document.createElement("iframe");
  element.setAttribute("sandbox", attrs.sandbox);
  element.setAttribute("referrerpolicy", attrs.referrerpolicy);
  element.setAttribute("allow", attrs.allow);
  element.setAttribute("title", attrs.title);
  element.setAttribute("srcdoc", srcdoc);
  const frameId = `frame-${crypto.randomUUID()}`;

  // Control-port RECEIVE path. MessagePort.onmessage setter form with
  // a handler registry: one port listener, many subscribers.
  const controlHandlers = new Set<(event: FrameControlEvent) => void>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  control.port1.onmessage = (event: MessageEvent) => {
    const data = event.data as FrameControlEvent | null;
    if (data === null || typeof data !== "object" || typeof data.type !== "string") return;
    // Spread snapshots the handler set so a handler that unsubscribes
    // itself mid-dispatch does not skip the remaining peers.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const handler of [...controlHandlers]) handler(data);
  };

  return {
    frameId,
    nonce,
    attrs: { ...attrs, srcdoc },
    frameIngressPort: ingress.port2,
    frameControlPort: control.port2,
    deliverSource(payload) {
      if (ingressDelivered) return;
      ingressDelivered = true;
      try {
        ingress.port1.postMessage(payload);
      } finally {
        try {
          ingress.port1.close();
        } catch {
          // already closed
        }
      }
    },
    sendControl(payload) {
      if (!controlOpen) return;
      try {
        control.port1.postMessage(payload);
      } catch {
        // control channel torn down — drop silently
      }
    },
    closeControl() {
      if (!controlOpen) return;
      controlOpen = false;
      try {
        control.port1.close();
      } catch {
        // already closed
      }
    },
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
    "apply-view-state": () => host.applyViewState(next.frameId, viewState),
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
  return { executedSteps: executed, failedNewFrameReady: false };
}

export interface RevisionFetchResult {
  readonly artifactType: string;
  readonly bytes: Uint8Array;
}

export interface SwapToRevisionDeps {
  readonly dom: ShellDom;
  readonly host: FrameHost;
  readonly bootstrapUrl: string;
  /** Fetch the exact revision bytes the SSE event named. */
  readonly fetchRevision: (artifactId: string, revisionSha: string) => Promise<RevisionFetchResult>;
  readonly readyTimeoutMs?: number;
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
): Promise<{ readonly frame: CreatedArtifactFrame; readonly result: ReplaceArtifactFrameResult }> {
  const revision = await deps.fetchRevision(event.artifactId, event.revisionSha);
  const next = createArtifactFrame({ bootstrapUrl: deps.bootstrapUrl, dom: deps.dom });
  deps.onFrameCreated?.(next);
  const result = await replaceArtifactFrame({
    current,
    next,
    dom: deps.dom,
    host: deps.host,
    viewState,
    source: { artifactType: revision.artifactType, bytes: revision.bytes },
    ...(deps.readyTimeoutMs !== undefined ? { readyTimeoutMs: deps.readyTimeoutMs } : {}),
  });
  return { frame: result.failedNewFrameReady ? current : next, result };
}

interface GallerySourceResponse {
  readonly artifactType: string;
  readonly source: string;
}

async function fetchGallerySource(
  baseUrl: string,
  handoff: BootstrapHandoff,
  revisionSha: string,
): Promise<RevisionFetchResult> {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/api/v1/gallery/source`);
  assertLoopbackHostname(url.hostname);
  url.searchParams.set("revisionSha", revisionSha);
  const response = await fetch(url, {
    headers: {
      authorization: handoff.authorization,
      "x-gallery-lease": handoff.lease.leaseId,
      "x-gallery-artifact": handoff.artifactId,
    },
  });
  if (!response.ok) throw new Error(`Gallery source fetch failed (${response.status})`);
  const payload = (await response.json()) as GallerySourceResponse;
  return { artifactType: payload.artifactType, bytes: new TextEncoder().encode(payload.source) };
}

function setGalleryStatus(status: string): void {
  const target = document.getElementById("facet-status-line");
  if (target !== null) target.textContent = status;
}

function setGalleryError(message: string): void {
  const target = document.getElementById("facet-error");
  if (target !== null) target.textContent = message;
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
        mount(frame);
        void frame.awaitControlEvent("boot-ready", DEFAULT_READY_TIMEOUT_MS).then(resolve);
      },
      { once: true },
    );
  });
}

export async function startGallery(): Promise<void> {
  const baseUrl = window.location.origin;
  const handoff = await consumeBootstrapHandoff({
    location: window.location.href,
    clearFragment: () => history.replaceState(null, "", window.location.pathname),
  });
  const title = document.getElementById("facet-title");
  const revision = document.getElementById("facet-revision");
  if (title !== null) title.textContent = "facet";
  if (revision !== null) revision.textContent = handoff.revisionSha.slice(0, 12);
  setGalleryStatus("loading");
  const bootstrapUrl = `${baseUrl}/gallery/frame/bootstrap.js`;
  const canvas = document.getElementById("facet-canvas");
  if (!(canvas instanceof HTMLElement)) throw new Error("Gallery canvas is missing");
  const viewState: ViewState = { zoom: 1 };
  const host: FrameHost = {
    mountOffScreen(frameId, element) {
      const iframe = element as HTMLIFrameElement;
      iframe.dataset.frameId = frameId;
      iframe.style.visibility = "hidden";
      iframe.style.transformOrigin = "center center";
      canvas.appendChild(iframe);
    },
    setVisibility(frameId, visible) {
      const iframe = canvas.querySelector<HTMLIFrameElement>(`[data-frame-id="${frameId}"]`);
      if (iframe !== null) iframe.style.visibility = visible ? "visible" : "hidden";
    },
    unmount(frameId) {
      canvas.querySelector<HTMLIFrameElement>(`[data-frame-id="${frameId}"]`)?.remove();
    },
    applyViewState(frameId, state) {
      const iframe = canvas.querySelector<HTMLIFrameElement>(`[data-frame-id="${frameId}"]`);
      if (iframe !== null) iframe.style.transform = `scale(${state.zoom})`;
    },
    showErrorBadge: setGalleryError,
  };
  const dom: ShellDom = { document, MessageChannel, hostname: window.location.hostname, window };
  const source = await fetchGallerySource(baseUrl, handoff, handoff.revisionSha);
  let current = createArtifactFrame({ bootstrapUrl, dom });
  const boot = await armFrameLoad(current, (frame) =>
    host.mountOffScreen(frame.frameId, frame.element.raw),
  );
  if (boot === null) throw new Error("Gallery frame failed to boot");
  current.deliverSource({ artifactType: source.artifactType, bytes: source.bytes });
  const initialEvent = await current.awaitControlEvent("render-complete", DEFAULT_READY_TIMEOUT_MS);
  if (initialEvent === null || observedErrorCount(initialEvent) !== 0)
    throw new Error("Gallery artifact failed to render");
  host.setVisibility(current.frameId, true);
  host.applyViewState(current.frameId, viewState);
  setGalleryStatus("ok");
  const stream = connectRevisionStream({
    baseUrl,
    bearer: handoff.authorization.replace(/^Bearer\s+/i, ""),
    leaseId: handoff.lease.leaseId,
    artifactId: handoff.artifactId,
    hostname: window.location.hostname,
    onCommit: (event) => {
      void swapToRevision(
        {
          dom,
          host,
          bootstrapUrl,
          fetchRevision: (_artifactId, revisionSha) =>
            fetchGallerySource(baseUrl, handoff, revisionSha),
          onFrameCreated: (next) => {
            void armFrameLoad(next, (frame) =>
              host.mountOffScreen(frame.frameId, frame.element.raw),
            );
          },
        },
        current,
        event,
        viewState,
      )
        .then(({ frame, result }) => {
          current = frame;
          if (!result.failedNewFrameReady) {
            if (revision !== null) revision.textContent = event.revisionSha.slice(0, 12);
            setGalleryStatus("ok");
          }
        })
        .catch((error: unknown) =>
          setGalleryError(error instanceof Error ? error.message : String(error)),
        );
    },
    onClose: () => setGalleryStatus("closed"),
  });
  const shutdown = (): void => {
    stream.close();
    void releaseDisplayLease({
      baseUrl,
      authorization: handoff.authorization,
      artifactId: handoff.artifactId,
      leaseId: handoff.lease.leaseId,
    });
  };
  window.addEventListener("beforeunload", shutdown, { once: true });
  for (const [id, delta] of [
    ["facet-zoom-in", 0.1],
    ["facet-zoom-out", -0.1],
  ] as const) {
    document.getElementById(id)?.addEventListener("click", () => {
      viewState.zoom = Math.max(0.25, Math.min(3, viewState.zoom + delta));
      host.applyViewState(current.frameId, viewState);
    });
  }
  document.getElementById("facet-zoom-reset")?.addEventListener("click", () => {
    viewState.zoom = 1;
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
    setGalleryStatus("error");
    setGalleryError(error instanceof Error ? error.message : String(error));
  });
}
