/**
 * Gallery shell controller — DOM-touching surface.
 *
 * The shell is the loopback user's browser surface — title + revision
 * + status line, zoom/reset/fullscreen controls, the iframe canvas,
 * a terse error badge. ONE active-artifact view (no sidebar, no list).
 * The shell transforms the iframe ELEMENT for zoom/pan; fine pan/zoom
 * lands on the frame's render-result view-state handle (same-origin call).
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
 * the shell awaits the iframe `load` event, calls the frame's direct
 * `__facetFrame.render(payload)` promise, and only then swaps
 * visibility, transfers the preserved view state, and removes the old
 * frame last. A failed new frame keeps the last-good frame visible and
 * surfaces an error badge.
 */

import { assertLoopbackHostname, buildFrameAttributes, type FrameAttributes } from "./frame-html";
import { planSwap, type SwapPlanStep } from "./swap";
import { connectRevisionStream } from "./sse-client";
import type { VerdictObserved } from "../shared/contracts/validation";
import type { ObservedCountKey } from "../shared/contracts/observed-counts";
import {
  clampZoom,
  EMPTY_VIEW_STATE,
  MAX_ZOOM,
  MIN_ZOOM,
  nextViewStateForKey,
  normalizeViewState,
  resetViewState,
  zoomAtPoint,
  type ViewState,
} from "./view-state";
import type { FrameRenderPayload, GestureMode } from "./frame/frame-payload";
import type { TsxExecutionMode, Verdict } from "../shared/contracts/validation";

// Re-exports — the gate test + sibling modules import these from `app`
// for the v0.1 public surface.
export {
  assertLoopbackHostname,
  buildFrameAttributes,
  buildFrameDocument,
  isLoopbackHostname,
  type FrameAttributes,
} from "./frame-html";
export { planSwap, type SwapPlanStep } from "./swap";
export { connectRevisionStream } from "./sse-client";

import {
  clearSession,
  persistSession,
  readPersistedSession,
  validatePersistedSession,
  type GallerySession,
  type SessionStorageLike,
} from "./session";

export interface BootstrapHandoff {
  readonly authorization: string;
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly lease: { readonly leaseId: string; readonly expiresAt: number };
  readonly headers: Headers;
}

class GallerySessionExpiredError extends Error {}

function isLeaseUnauthorized(response: Response): boolean {
  return response.status === 401;
}

export type GalleryBootstrap =
  | {
      readonly outcome: "bootstrapped";
      readonly session: BootstrapHandoff;
      readonly storage: SessionStorageLike;
    }
  | {
      readonly outcome: "reused";
      readonly session: BootstrapHandoff;
      readonly storage: SessionStorageLike;
    }
  | { readonly outcome: "expired"; readonly reason: "missing" | "expired" | "invalid" };

export interface ResolveGalleryBootstrapOptions {
  readonly location: string;
  readonly storage: SessionStorageLike;
  readonly fetchImpl?: typeof fetch;
  readonly clearFragment?: () => void;
  /** Cheap authed probe — true if the live lease still services the artifact. */
  readonly validateLease: (session: GallerySession) => Promise<boolean> | boolean;
}

/**
 * Resolve the shell's bootstrap state on load.
 *
 * 1. Live `bootstrap=` token in the URL fragment → exchange it for a
 *    lease and persist the granted session to `sessionStorage`. The
 *    consumed token is stripped from the URL.
 * 2. No token, but a persisted session is still in `sessionStorage` →
 *    reuse the stored lease. The caller validates the lease via a
 *    authed round-trip; the URL is left untouched.
 * 3. No token and no persisted session, or the stored lease is
 *    expired/invalid → exhaustive fail states surface the typed
 *    "session expired — run `facet open` again" message instead of
 *    throwing on the missing-token path.
 *
 * The shell treats a service restart as an expired lease: the lease
 * manager is in-memory, so every outstanding lease evaporates the
 * moment the service comes back. The honest route is the expired
 * state, not a longer-lived credential.
 */
export async function resolveGalleryBootstrap(
  options: ResolveGalleryBootstrapOptions,
): Promise<GalleryBootstrap> {
  const url = new URL(options.location);
  assertLoopbackHostname(url.hostname);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const liveToken = fragment.get("bootstrap");

  if (liveToken !== null && liveToken.length > 0) {
    options.clearFragment?.();
    const fetcher = options.fetchImpl ?? fetch;
    const response = await fetcher(`${url.origin}/api/v1/gallery/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: liveToken }),
    });
    if (isLeaseUnauthorized(response)) return { outcome: "expired", reason: "invalid" };
    if (!response.ok) throw new Error(`Gallery bootstrap failed (${response.status})`);
    const payload = (await response.json()) as Omit<BootstrapHandoff, "headers">;
    const headers = new Headers({
      authorization: payload.authorization,
      "x-gallery-lease": payload.lease.leaseId,
      "x-gallery-artifact": payload.artifactId,
    });
    const session: BootstrapHandoff = { ...payload, headers };
    const persisted: GallerySession = {
      authorization: payload.authorization,
      artifactId: payload.artifactId,
      revisionSha: payload.revisionSha,
      lease: payload.lease,
    };
    persistSession(options.storage, persisted);
    return { outcome: "bootstrapped", session, storage: options.storage };
  }

  const persisted = readPersistedSession(options.storage);
  if (persisted === null) return { outcome: "expired", reason: "missing" };
  const validity = validatePersistedSession(persisted);
  if (!validity.valid) {
    // Stored lease is past its nominal expiry. Even if the service
    // restarted inside the same window, the persisted session is no
    // longer the source of truth — wipe it so the next refresh starts
    // from a clean state.
    clearSession(options.storage);
    return { outcome: "expired", reason: "expired" };
  }
  const leaseStillValid = await options.validateLease(persisted);
  if (!leaseStillValid) {
    clearSession(options.storage);
    return { outcome: "expired", reason: "invalid" };
  }
  const headers = new Headers({
    authorization: persisted.authorization,
    "x-gallery-lease": persisted.lease.leaseId,
    "x-gallery-artifact": persisted.artifactId,
  });
  const session: BootstrapHandoff = {
    authorization: persisted.authorization,
    artifactId: persisted.artifactId,
    revisionSha: persisted.revisionSha,
    lease: persisted.lease,
    headers,
  };
  return { outcome: "reused", session, storage: options.storage };
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
  readonly hostname: string;
}

/** View state the shell preserves across a swap. */
export type { ViewState } from "./view-state";

/**
 * Page-shim counts the frame reports after a render settles. The
 * direct render promise resolves with these; the shell treats any
 * non-zero error count as a failed render.
 */
type FrameObserved = Pick<VerdictObserved, ObservedCountKey | "html" | "errorCount">;

export interface CreateArtifactFrameOptions {
  readonly artifactType: string;
  /** Legacy direct callers omit this; revision source fetches always make it explicit. */
  readonly renderer?: string;
  readonly frameUrl?: string;
  readonly dom: ShellDom;
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

export type { FrameRenderPayload };

/**
 * Shell-side handle over the frame's direct `RenderResult`. The frame
 * promise resolves with these after the render settles; the handle
 * keeps the view-state surface callable for the frame's lifetime.
 */
export interface FrameRenderResultHandle {
  /** Post-settlement page-shim counts reported by the frame's render. */
  readonly observed: FrameObserved;
  /** The view mode the render selected (native SVG vs shell CSS fallback). */
  readonly viewMode: "native" | "css";
  /** The frame's last-applied view state (its own zoom/pan). */
  readonly readViewState: () => ViewState;
  /** Apply the shell's preserved view state inside the frame (same-origin). */
  readonly applyViewState: (state: ViewState) => void;
  /** Gesture mode this render started in — standalone diagrams default to `panzoom`, documents to `native`. */
  readonly defaultGestureMode: GestureMode;
  /** The frame's current wheel/drag gesture mode. */
  readonly gestureMode: () => GestureMode;
  /** Switch the frame between native scroll/select and wheel-zoom/drag-pan. */
  readonly setGestureMode: (mode: GestureMode) => void;
  /** Restore every embedded diagram region to its natural size and idle state. */
  readonly resetDiagramRegions: () => void;
}

export interface CreatedArtifactFrame {
  readonly frameId: string;
  readonly attrs: FrameAttributes;
  /**
   * Element wired with the attributes above. The caller mounts it via
   * a FrameHost. Kept abstract so the test gate can stub.
   */
  readonly element: FrameElementHandle;
  /**
   * Resolve true once the iframe `load` event has fired (the runtime
   * module executed and installed `__facetFrame`), or false on
   * timeout. The listener is armed at creation, BEFORE any mount — a
   * detached iframe never loads, so arming inside a mount callback
   * would deadlock on an event that can only fire after mount.
   */
  readonly awaitLoad: (timeoutMs: number) => Promise<boolean>;
  /**
   * Invoke the frame's direct render API with the exact revision
   * payload. Resolves with a handle over the frame-side RenderResult,
   * or rejects on timeout / missing API / frame-side render failure.
   * Only meaningful after `awaitLoad` resolved.
   */
  readonly render: (
    payload: FrameRenderPayload,
    timeoutMs: number,
  ) => Promise<FrameRenderResultHandle>;
  /** Handle from the last successful render (null before the first). */
  readonly renderResult: FrameRenderResultHandle | null;
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
  /** Terse error badge — failed swaps keep the last-good frame. */
  showErrorBadge(message: string): void;
}

/**
 * Create a fresh artifact frame: build the loopback document URL and
 * an ordinary same-origin iframe element. The load listener is armed
 * HERE (before any mount); the frame's direct render API is invoked
 * through the returned `render` handle once `awaitLoad` resolves.
 */
export function createArtifactFrame(options: CreateArtifactFrameOptions): CreatedArtifactFrame {
  const dom = options.dom;
  // DNS-rebinding guard — fires BEFORE the iframe is appended or any
  // capability code runs.
  assertLoopbackHostname(dom.hostname);
  const frameUrl = new URL(options.frameUrl ?? "/gallery/frame", `http://${dom.hostname}`);
  frameUrl.searchParams.set("type", options.artifactType);
  frameUrl.searchParams.set("renderer", options.renderer ?? "svg");
  const attrs = buildFrameAttributes(frameUrl.toString());
  const element = dom.document.createElement("iframe");
  element.setAttribute("referrerpolicy", attrs.referrerpolicy);
  element.setAttribute("allow", attrs.allow);
  element.setAttribute("title", attrs.title);
  element.setAttribute("src", attrs.src);
  const frameId = `frame-${crypto.randomUUID()}`;
  const raw = element as HTMLIFrameElement;

  let loaded = false;
  const loadWaiters: ((isLoaded: boolean) => void)[] = [];
  // Armed BEFORE any mount: the load event can only fire once the
  // element is in the document, and rendering before the runtime
  // bundle executes would race the __facetFrame install (the old
  // boot flake reborn).
  raw.addEventListener(
    "load",
    () => {
      loaded = true;
      for (const waiter of loadWaiters) waiter(true);
      loadWaiters.length = 0;
    },
    { once: true },
  );

  let renderResult: FrameRenderResultHandle | null = null;

  return {
    frameId,
    attrs,
    element: {
      setAttribute(name: string, value: string): void {
        element.setAttribute(name, value);
      },
      raw: element,
    },
    awaitLoad(timeoutMs) {
      if (loaded) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const waiter = (isLoaded: boolean): void => {
          clearTimeout(timer);
          resolve(isLoaded);
        };
        const timer = setTimeout(() => {
          const index = loadWaiters.indexOf(waiter);
          if (index >= 0) loadWaiters.splice(index, 1);
          resolve(false);
        }, timeoutMs);
        loadWaiters.push(waiter);
      });
    },
    async render(payload, timeoutMs) {
      // oxlint-disable-next-line no-underscore-dangle
      const api = raw.contentWindow?.__facetFrame;
      if (api === null || api === undefined || typeof api.render !== "function") {
        throw new Error("frame render API unavailable");
      }
      // The frame-side promise is the render authority; the timer only
      // bounds a never-settling render (a dead runtime bundle).
      const frameResult = await withTimeout(
        Promise.resolve(api.render(payload)),
        timeoutMs,
        "frame render timed out",
      );
      const handle: FrameRenderResultHandle = {
        observed: frameResult.observed,
        viewMode: frameResult.viewMode,
        readViewState: () => ({ ...frameResult.readViewState() }),
        applyViewState: (state) => frameResult.applyViewState(normalizeViewState(state)),
        defaultGestureMode: frameResult.defaultGestureMode,
        gestureMode: () => frameResult.gestureMode(),
        setGestureMode: (mode) => frameResult.setGestureMode(mode),
        resetDiagramRegions: () => frameResult.resetDiagramRegions(),
      };
      renderResult = handle;
      return handle;
    },
    get renderResult(): FrameRenderResultHandle | null {
      return renderResult;
    },
  };
}

export interface ReplaceArtifactFrameOptions {
  readonly current: CreatedArtifactFrame;
  readonly next: CreatedArtifactFrame;
  readonly dom: ShellDom;
  readonly host: FrameHost;
  readonly viewState: ViewState;
  /** Artifact payload rendered by the new frame exactly once. */
  readonly source?: FrameRenderPayload;
  /** Per-barrier wait window (load, then render). */
  readonly readyTimeoutMs?: number;
  readonly onProgress?: (state: "ready" | "complete") => void;
}

export interface ReplaceArtifactFrameResult {
  readonly executedSteps: readonly SwapPlanStep["name"][];
  readonly failedNewFrameReady: boolean;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;

/** Bound an already-started promise with a wall-clock timeout. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Execute a double-buffered HMR swap against the real DOM. Ordering
 * invariant: the new frame is built off-screen, loads, renders through
 * the direct frame API, and only THEN swaps in — the old frame is
 * removed last. View state is preserved across the swap. If the new
 * frame fails to load or render within the wait window, the old frame
 * stays visible with an error badge and the failed new frame's element
 * is torn down.
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
  let renderResult: FrameRenderResultHandle | null = null;
  const runners: Record<SwapPlanStep["name"], () => void> = {
    "build-new": () => host.mountOffScreen(next.frameId, next.element.raw),
    "load-new": () => {
      // Awaited below; this step records the barrier passed.
    },
    "render-new": () => {
      // Awaited below; this step records the barrier passed.
    },
    swap: () => {
      host.setVisibility(next.frameId, true);
      host.setVisibility(current.frameId, false);
    },
    "apply-view-state": () => {
      renderResult!.applyViewState(viewState);
    },
    "remove-old": () => {
      host.unmount(current.frameId);
    },
  };
  const runStep = (step: SwapPlanStep): void => {
    runners[step.name]();
    executed.push(step.name);
  };

  // build-new + load-new run before the render barrier: the iframe
  // must be mounted off-screen to load. The load listener was armed at
  // frame creation, so the detached-iframe deadlock cannot occur.
  runStep(plan[0]!);
  runStep(plan[1]!);
  const loaded = await next.awaitLoad(readyTimeoutMs);

  runStep(plan[2]!);
  if (loaded) {
    try {
      if (options.source !== undefined) {
        const result = await next.render(options.source, readyTimeoutMs);
        if (result.observed.errorCount === 0) renderResult = result;
      }
    } catch {
      renderResult = null;
    }
  }

  if (renderResult === null) {
    // Failed new frame: keep the last-good frame visible, surface the
    // badge, and tear the failed frame's element down.
    host.showErrorBadge("new revision failed to render; keeping last good revision");
    host.unmount(next.frameId);
    return { executedSteps: executed, failedNewFrameReady: true };
  }

  // Render succeeded: swap → apply-view-state → remove-old, in order.
  // The viewState passed in options is the caller's preserved state
  // (read from the current frame before the swap started).
  options.onProgress?.("ready");
  // Yield one microtask so the 80% progress state flushes before the
  // swap applies — the swap steps below are synchronous, and a caller
  // (or the perf instrumentation) that keys on the bar width must be
  // able to observe the barrier passing.
  await Promise.resolve();
  for (const step of plan.slice(3)) runStep(step);
  options.onProgress?.("complete");
  return { executedSteps: executed, failedNewFrameReady: false };
}

export interface RevisionFetchResult {
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly slug: string;
  readonly title: string;
  readonly artifactType: string;
  readonly renderer: string;
  readonly bytes: Uint8Array;
  readonly execution?: TsxExecutionMode;
  readonly verdict?: Verdict | null;
}

export interface SwapToRevisionDeps {
  readonly dom: ShellDom;
  readonly host: FrameHost;
  readonly frameUrl?: string;
  /** Fetch the exact revision bytes the SSE event named. */
  readonly fetchRevision: (artifactId: string, revisionSha: string) => Promise<RevisionFetchResult>;
  readonly readyTimeoutMs?: number;
  readonly onProgress?: (state: "ready" | "complete") => void;
}

export interface RevisionEvent {
  readonly artifactId: string;
  readonly revisionSha: string;
}

/**
 * publish→visible, one revision at a time: fetch the exact revision
 * the committed event named, build a fresh frame for it, and
 * run the double-buffered swap. The returned frame becomes `current`
 * for the next revision. Bytes enter the frame exactly once through
 * the direct render call; every revision gets its own document — no
 * artifact-JS carryover between revisions.
 */
export async function swapToRevision(
  deps: SwapToRevisionDeps,
  current: CreatedArtifactFrame,
  event: RevisionEvent,
  viewState: ViewState,
): Promise<{
  readonly frame: CreatedArtifactFrame;
  readonly result: ReplaceArtifactFrameResult;
  readonly revision: RevisionFetchResult;
}> {
  const revision = await deps.fetchRevision(event.artifactId, event.revisionSha);
  const next = createArtifactFrame({
    artifactType: revision.artifactType,
    renderer: revision.renderer,
    dom: deps.dom,
    ...(deps.frameUrl === undefined ? {} : { frameUrl: deps.frameUrl }),
  });
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
      ...(revision.execution === undefined ? {} : { execution: revision.execution }),
    },
    ...(deps.onProgress === undefined ? {} : { onProgress: deps.onProgress }),
    ...(deps.readyTimeoutMs !== undefined ? { readyTimeoutMs: deps.readyTimeoutMs } : {}),
  });
  return {
    frame: result.failedNewFrameReady ? current : next,
    result,
    revision,
  };
}

interface GallerySourceResponse {
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly slug: string;
  readonly title: string;
  readonly artifactType: string;
  readonly renderer?: string;
  readonly source: string;
  readonly renderBytesBase64?: string;
  readonly execution?: TsxExecutionMode;
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
  if (isLeaseUnauthorized(response)) throw new GallerySessionExpiredError("Gallery lease expired");
  if (!response.ok) throw new Error(`Gallery source fetch failed (${response.status})`);
  const payload = (await response.json()) as GallerySourceResponse;
  return {
    artifactId: payload.artifactId,
    revisionSha: payload.revisionSha,
    slug: payload.slug,
    title: payload.title,
    artifactType: payload.artifactType,
    renderer: payload.renderer ?? "svg",
    bytes:
      payload.renderBytesBase64 === undefined
        ? new TextEncoder().encode(payload.source)
        : Uint8Array.from(atob(payload.renderBytesBase64), (char) => char.charCodeAt(0)),
    ...(payload.execution === undefined ? {} : { execution: payload.execution }),
    verdict: payload.verdict ?? null,
  };
}

function setGalleryTitle(document: Document, artifactTitle: string | null): void {
  const normalized = artifactTitle?.trim() ?? "";
  const displayTitle = normalized.length === 0 ? null : normalized;
  const shellTitle = document.getElementById("facet-artifact-title");
  if (shellTitle !== null) shellTitle.textContent = displayTitle ?? "";
  document.title = displayTitle === null ? "facet gallery" : `${displayTitle} · facet`;
}

function setGalleryStatus(document: Document, status: string): void {
  const target = document.getElementById("facet-status-line");
  if (target !== null) target.textContent = status;
  if (status !== "session expired") {
    const expired = document.getElementById("facet-expired");
    if (expired !== null) expired.hidden = true;
  }
}

function setGalleryError(document: Document, message: string): void {
  const target = document.getElementById("facet-error");
  if (target !== null) {
    target.textContent = message;
    target.classList.toggle("facet-visible", message.length > 0);
  }
}

function renderSessionExpired(
  document: Document,
  setError: (message: string) => void,
  setStatus: (status: string) => void,
): void {
  const empty = document.getElementById("facet-empty");
  if (empty !== null) empty.hidden = true;
  const expired = document.getElementById("facet-expired");
  if (expired !== null) expired.hidden = false;
  setStatus("session expired");
  setError("session expired — run facet open again");
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
          : verdict.status === "partial:external_resources"
            ? "external"
            : verdict.status === "partial:unstable"
              ? "unstable"
              : null;
    const insecure = verdict.insecure === undefined ? null : `INSECURE L${verdict.insecure.level}`;
    const suffix = insecure === null ? `T${verdict.tier}` : `${insecure} · T${verdict.tier}`;
    tier.textContent = detail === null ? `· ${suffix}` : `· ${detail} · ${suffix}`;
  }
  const observed = verdict.observed;
  const counts = document.getElementById("facet-evidence-counts");
  if (counts !== null)
    counts.textContent =
      observed.html === undefined
        ? `svg ${observed.rendererRootSvgCount} · graphs ${observed.graphCount} · nodes ${observed.mermaidNodeCount} · opaque ${observed.opaqueRegionCount} · errors ${observed.errorCount}`
        : `roots ${observed.html.rendererRootCount} · headings ${observed.html.headingCount} · tables ${observed.html.tableCount} · lists ${observed.html.listCount} · images ${observed.html.imageCount} · canvas ${observed.html.canvasCount} · external ${observed.html.externalImageCount}`;
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

/**
 * Disable the zoom button that sits at its clamp bound (0.25x /
 * 8x from view-state.ts) so a clamped click reads as a no-op instead
 * of silently eating the input. Pure + testable against a fake
 * document, same shape as the other set* helpers above.
 */
function setZoomButtonState(document: Document, zoom: number): void {
  // `as HTMLButtonElement` rather than `instanceof` — the shell's other
  // set* helpers (setGalleryStatus, setLiveState, ...) all assign DOM
  // properties directly without a runtime type guard, and this file's
  // test-harness DOM shims don't universally expose HTMLButtonElement
  // as a global to guard against.
  const zoomOut = document.getElementById("facet-zoom-out") as HTMLButtonElement | null;
  const zoomIn = document.getElementById("facet-zoom-in") as HTMLButtonElement | null;
  if (zoomOut !== null) zoomOut.disabled = zoom <= MIN_ZOOM;
  if (zoomIn !== null) zoomIn.disabled = zoom >= MAX_ZOOM;
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

export interface SerializedSwapQueue<T> {
  /** Latest-wins enqueue: an in-flight swap absorbs newer events; intermediates are skipped. */
  readonly enqueue: (event: T) => void;
  /** Resolve when no swap is in flight and nothing is queued. */
  readonly settle: () => Promise<void>;
  /** Drop queued work; an already-running task may finish but callers gate its writes. */
  readonly close: () => void;
}

/**
 * Serialize revision swaps: at most one swap runs at a time; a commit
 * that lands mid-swap is queued latest-wins. Two concurrent swaps
 * would leave two visible frames and a leaked document realm.
 */
export function createSerializedSwapQueue<T>(
  run: (event: T) => Promise<void>,
): SerializedSwapQueue<T> {
  let inFlight: Promise<void> | null = null;
  let pending: T | null = null;
  let closed = false;
  let tail: Promise<void> = Promise.resolve();

  const drain = async (): Promise<void> => {
    while (pending !== null) {
      const event = pending;
      pending = null;
      inFlight = run(event);
      try {
        await inFlight;
      } catch {
        // swapToRevision failures are handled by the caller's run
        // wrapper; a throw here must not strand a queued revision.
      } finally {
        inFlight = null;
      }
    }
  };

  return {
    enqueue(event: T): void {
      if (closed) return;
      pending = event;
      if (inFlight === null) {
        tail = drain().catch(() => undefined);
      }
    },
    settle(): Promise<void> {
      return tail;
    },
    close(): void {
      closed = true;
      pending = null;
    },
  };
}

export interface GalleryRuntime {
  readonly window: Window;
  readonly document: Document;
  readonly history: History;
  readonly HTMLElement: typeof HTMLElement;
  readonly fetch: typeof fetch;
}

function browserGalleryRuntime(): GalleryRuntime {
  return { window, document, history, HTMLElement, fetch };
}

export async function startGallery(runtime = browserGalleryRuntime()): Promise<void> {
  const { window, document, history, HTMLElement, fetch } = runtime;
  let expired = false;
  const updateGalleryStatus = (status: string): void => {
    if (!expired) setGalleryStatus(document, status);
  };
  const updateGalleryError = (message: string): void => {
    if (!expired) setGalleryError(document, message);
  };
  const updateGalleryVerdict = (verdict: Verdict | null): void =>
    expired ? undefined : setGalleryVerdict(document, verdict);
  const updateGalleryTitle = (artifactTitle: string | null): void => {
    if (!expired) setGalleryTitle(document, artifactTitle);
  };
  const updateLiveState = (state: "idle" | "connecting" | "live"): void =>
    expired ? undefined : setLiveState(document, state);
  const updateSwapBar = (state: "start" | "ready" | "complete" | "failed"): void =>
    expired ? undefined : setSwapBar(document, window, state);
  const updateZoomButtons = (zoom: number): void => setZoomButtonState(document, zoom);
  const baseUrl = window.location.origin;
  const bootstrap = await resolveGalleryBootstrap({
    location: window.location.href,
    storage: window.sessionStorage,
    fetchImpl: fetch,
    clearFragment: () => history.replaceState(null, "", window.location.pathname),
    validateLease: async (session) => {
      try {
        const probe = new URL(`${baseUrl.replace(/\/$/, "")}/api/v1/gallery/source`);
        probe.searchParams.set("revisionSha", session.revisionSha);
        const response = await fetch(probe, {
          headers: {
            authorization: session.authorization,
            "x-gallery-lease": session.lease.leaseId,
            "x-gallery-artifact": session.artifactId,
          },
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  });
  if (bootstrap.outcome === "expired") {
    expired = true;
    renderSessionExpired(
      document,
      (message) => setGalleryError(document, message),
      (status) => setGalleryStatus(document, status),
    );
    return;
  }
  const handoff = bootstrap.session;
  const title = document.getElementById("facet-title");
  const revisionLabel = document.getElementById("facet-revision");
  if (title !== null) title.textContent = "facet";
  if (revisionLabel !== null) revisionLabel.textContent = handoff.revisionSha.slice(0, 12);
  updateGalleryStatus("idle");
  updateLiveState("connecting");
  const frameUrl = `${baseUrl}/gallery/frame`;
  const canvas = document.getElementById("facet-canvas");
  if (!(canvas instanceof HTMLElement)) throw new Error("Gallery canvas is missing");
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
    },
    unmount(frameId) {
      canvas.querySelector<HTMLIFrameElement>(`[data-frame-id="${frameId}"]`)?.remove();
    },
    showErrorBadge: updateGalleryError,
  };
  const dom: ShellDom = { document, hostname: window.location.hostname };
  let source: RevisionFetchResult;
  try {
    source = await fetchGallerySource(baseUrl, handoff, handoff.revisionSha, fetch);
  } catch (error) {
    if (error instanceof GallerySessionExpiredError) {
      expired = true;
      clearSession(window.sessionStorage);
      renderSessionExpired(
        document,
        (message) => setGalleryError(document, message),
        (status) => setGalleryStatus(document, status),
      );
      return;
    }
    throw error;
  }
  let current = createArtifactFrame({
    artifactType: source.artifactType,
    renderer: source.renderer,
    frameUrl,
    dom,
  });
  host.mountOffScreen(current.frameId, current.element.raw);
  const loaded = await current.awaitLoad(DEFAULT_READY_TIMEOUT_MS);
  if (!loaded) throw new Error("Gallery frame failed to load");
  const initialResult = await current.render(
    {
      artifactType: source.artifactType,
      renderer: source.renderer,
      bytes: source.bytes,
      ...(source.execution === undefined ? {} : { execution: source.execution }),
    },
    DEFAULT_READY_TIMEOUT_MS,
  );
  if (initialResult.observed.errorCount !== 0) {
    throw new Error("Gallery artifact failed to render");
  }
  host.setVisibility(current.frameId, true);
  updateGalleryTitle(source.title);
  updateGalleryVerdict(source.verdict ?? null);
  updateGalleryStatus("displayed");
  updateLiveState("live");
  const swaps = createSerializedSwapQueue<RevisionEvent>((event) =>
    swapToRevision(
      {
        dom,
        host,
        frameUrl,
        fetchRevision: (_artifactId, revisionSha) =>
          fetchGallerySource(baseUrl, handoff, revisionSha, fetch),
        onProgress: updateSwapBar,
      },
      current,
      event,
      current.renderResult?.readViewState() ?? EMPTY_VIEW_STATE,
    )
      .then(({ frame, result, revision }) => {
        if (expired) return;
        current = frame;
        syncPanZoomToggle();
        syncZoomButtons();
        if (!result.failedNewFrameReady) {
          if (revisionLabel !== null) revisionLabel.textContent = event.revisionSha.slice(0, 12);
          updateGalleryTitle(revision.title);
          updateGalleryVerdict(revision.verdict ?? null);
          updateGalleryStatus("displayed");
          updateSwapBar("complete");
        } else {
          updateSwapBar("failed");
          updateGalleryVerdict(null);
          updateGalleryStatus("displayed");
        }
      })
      .catch((error: unknown) => {
        if (expired) return;
        if (error instanceof GallerySessionExpiredError) {
          expireSession();
          return;
        }
        updateSwapBar("failed");
        updateGalleryStatus("displayed");
        updateGalleryError(error instanceof Error ? error.message : String(error));
      }),
  );
  const expireSession = (): void => {
    if (expired) return;
    expired = true;
    swaps.close();
    clearSession(window.sessionStorage);
    renderSessionExpired(
      document,
      (message) => setGalleryError(document, message),
      (status) => setGalleryStatus(document, status),
    );
    setLiveState(document, "idle");
  };
  const stream = connectRevisionStream({
    baseUrl,
    bearer: handoff.authorization.replace(/^Bearer\s+/i, ""),
    leaseId: handoff.lease.leaseId,
    artifactId: handoff.artifactId,
    hostname: window.location.hostname,
    fetchImpl: fetch,
    onState: updateLiveState,
    onCommit: (event) => {
      updateGalleryStatus("swapping");
      updateSwapBar("start");
      updateGalleryVerdict(null);
      swaps.enqueue(event);
    },
    onClose: (event) => {
      // `lease_expired` (the per-lease TTL firing server-side) and a
      // rejected reconnect (`stream_status_401`, the lease no longer
      // authenticating) both mean the session itself is gone — the
      // typed expired screen and a cleared persisted session are the
      // correct terminal state. Any other close reason is a transient
      // transport loss; those just go idle, matching the previous
      // (deliberately unbranched) behavior.
      if (event.reason === "lease_expired" || event.reason === "stream_status_401") {
        expireSession();
        stream.close();
        return;
      }
      updateLiveState("idle");
      updateGalleryStatus("idle");
    },
  });
  // Set below, once the toolbar wiring installs the wheel-zoom sync
  // poll — declared here so the one `beforeunload` listener can clear
  // it alongside closing the stream, instead of a second listener
  // registration (the shell keeps exactly one shutdown path).
  let zoomButtonPoll: ReturnType<typeof setInterval> | undefined;
  const shutdown = (): void => {
    // The display lease is bound to a per-lease TTL on the service
    // (see GalleryLeaseManager.schedule). Releasing it eagerly on
    // beforeunload would defeat the sessionStorage re-attach path on
    // F5 — the lease would be gone by the time the new shell ran
    // resolveGalleryBootstrap. The idle controller on the service
    // releases the lease when the TTL fires, which is the only path
    // that lets "refresh the tab" reach the same displayed canvas.
    stream.close();
    if (zoomButtonPoll !== undefined) clearInterval(zoomButtonPoll);
  };
  window.addEventListener("beforeunload", shutdown, { once: true });

  const canvasRect = (): DOMRect => canvas.getBoundingClientRect();
  // Shell-side listener: keyboard focus can legitimately sit in the
  // parent document (e.g. the user tabbed to a control) rather than
  // inside the frame, so this listener stays alongside the frame's
  // own (frame/runtime.ts) rather than being the only one. Both route
  // through `nextViewStateForKey` so the key-to-state mapping has one
  // tested home.
  document.addEventListener("keydown", (event) => {
    const result = current.renderResult;
    if (!result) return;
    const next = nextViewStateForKey(
      result.readViewState(),
      event.key,
      event.shiftKey,
      canvasRect(),
    );
    if (next === null) return;
    event.preventDefault();
    if (event.key === "0") {
      result.setGestureMode(result.defaultGestureMode);
      syncPanZoomToggle();
    }
    result.applyViewState(next);
    syncZoomButtons();
  });
  for (const [id, delta] of [
    ["facet-zoom-in", 0.1],
    ["facet-zoom-out", -0.1],
  ] as const) {
    document.getElementById(id)?.addEventListener("click", () => {
      const result = current.renderResult;
      if (!result) return;
      const state = result.readViewState();
      const rect = canvasRect();
      result.applyViewState(
        zoomAtPoint(state, clampZoom(state.zoom + delta), rect.width / 2, rect.height / 2),
      );
      syncZoomButtons();
    });
  }
  const panZoomToggle = document.getElementById("facet-panzoom-toggle");
  /** Reflect the frame's actual gesture mode on the toolbar toggle — called after every render/swap so a fresh diagram's default-on panzoom shows latched without a click. */
  const syncPanZoomToggle = (): void => {
    if (panZoomToggle === null) return;
    const active = current.renderResult?.gestureMode() === "panzoom";
    panZoomToggle.setAttribute("aria-pressed", active ? "true" : "false");
  };
  /** Disable the zoom button sitting at its clamp bound — called at every point the zoom value can change (buttons, keyboard, reset, swap, and the wheel-zoom poll below), mirroring syncPanZoomToggle's called-everywhere shape. */
  const syncZoomButtons = (): void => {
    updateZoomButtons(current.renderResult?.readViewState().zoom ?? 1);
  };
  panZoomToggle?.addEventListener("click", () => {
    const result = current.renderResult;
    if (!result) return;
    result.setGestureMode(result.gestureMode() === "panzoom" ? "native" : "panzoom");
    syncPanZoomToggle();
  });
  document.getElementById("facet-zoom-reset")?.addEventListener("click", () => {
    const result = current.renderResult;
    if (!result) return;
    result.setGestureMode(result.defaultGestureMode);
    result.applyViewState(resetViewState(result.readViewState()));
    result.resetDiagramRegions();
    syncPanZoomToggle();
    syncZoomButtons();
  });
  syncPanZoomToggle();
  syncZoomButtons();
  document
    .getElementById("facet-fullscreen")
    ?.addEventListener("click", () => void canvas.requestFullscreen());
  // Wheel-zoom happens inside the frame's own document (see the
  // `onWheel` listener installed by `installGalleryFrameApi` in
  // frame/runtime.ts) — an iframe's events never bubble to the parent
  // document, so the shell has no listener to hook a sync call onto.
  // A callback threaded through the render-result handle (the same
  // same-origin boundary `applyViewState`/`gestureMode` already cross)
  // would avoid polling entirely; the poll is simpler for a local
  // single-tab tool and cheap enough (one unref'd 200ms interval,
  // cleared on shutdown, not re-created per swap) that the tradeoff
  // wasn't worth the extra plumbing here. Bare `setInterval`
  // (globalThis, not `window.*`) so this works whether the injected
  // runtime's `window` fake implements timers or not — the shell's
  // own DOM interface never required it.
  zoomButtonPoll = setInterval(syncZoomButtons, 200);
  if (typeof zoomButtonPoll.unref === "function") zoomButtonPoll.unref();
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
