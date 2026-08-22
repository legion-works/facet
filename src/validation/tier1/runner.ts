/**
 * Tier 1 runner — the parent-side orchestrator.
 *
 * Spawns an ephemeral netns'd `chrome-headless-shell`, drives the
 * pre-armed probe sequence against the opaque `about:srcdoc` child
 * frame, and binds the final verdict to the (artifactId, revisionSha)
 * the caller supplied.
 *
 * The flow matches §6.1 of the design spike and the harness-spike
 * driver:
 *
 *   1. Resolve the pinned shell + netns wrapper.
 *   2. Launch the browser (CDP pipe, ephemeral 0700 profile).
 *   3. Write the host page to a tmpdir; navigate the browser to it.
 *   4. Resolve the `about:srcdoc` child frame.
 *   5. Create an isolated execution world BEFORE source ingress.
 *   6. Inject the artifact into the iframe via the ingress port.
 *   7. Wait for the trusted `render-complete` control event.
 *   8. Run `DOMSnapshot.captureSnapshot` + `DOM.getDocument` +
 *      isolated-world evaluation in that order.
 *   9. Capture the page-shim self-report from the control port.
 *  10. Derive the verdict and bind it to (artifactId, revisionSha).
 *  11. Tear everything down (close session, kill browser, rm tmpdir).
 *
 * System-level failures throw `FacetError` with a typed `tier1_*`
 * code. Verdict-level divergences (`tampered`, `shim_only`, etc.)
 * are returned as a populated `Tier1Result` — never a throw.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

import {
  Tier1ResultSchema,
  type ProtocolObservation,
  type InsecureLevel,
  type IsolationProbeResult,
  type ScreenshotError,
  type Tier1Input,
  type Tier1Result,
} from "../../shared/contracts/validation";
import type { EvidenceImageFormat } from "../../shared/evidence-image";
import {
  HTML_OBSERVED_COUNT_KEYS,
  type ObservedCountKey,
  OBSERVED_COUNT_KEYS,
} from "../../shared/contracts/observed-counts";
import { FacetError } from "../../shared/errors/facet-error";
import { probeLauncherAvailability } from "./browser-process";
import { computeFacetPaths } from "../../shared/config/paths";
import { ensureOwnerOnlyDirectory } from "../../shared/util/dir-permissions";

import { buildHostPage } from "./harness";
import { PuppeteerTier1Browser, Tier1TransportWedgeError } from "./cdp-pipe";
import { resolveLauncher } from "./launcher";
import {
  createIsolatedWorld,
  resolveNestedArtifactFrame,
  resolveSrcdocChildFrame,
} from "./frame-target";
import { probeProtocolGetDocument, probeProtocolSnapshot } from "./protocol-probe";
import { probeIsolatedCounts } from "./isolated-probe";
import {
  TIER1_ANIMATION_FRAME_COUNT,
  TIER1_ANIMATION_FRAME_INTERVAL_MS,
  TIER1_ANIMATION_WEBP_QUALITIES,
  TIER1_RENDER_BARRIER_MS,
  TIER1_SCREENSHOT_CAPTURE_ATTEMPTS,
  TIER1_SCREENSHOT_CAP_BYTES,
  TIER1_SCREENSHOT_CAPTURE_TIMEOUT_MS,
  TIER1_SCREENSHOT_MAX_AXIS_PX,
  TIER1_SCREENSHOT_MAX_PIXELS,
  TIER1_SCREENSHOT_WEBP_QUALITY,
  TIER1_VIEWPORT_HEIGHT,
  TIER1_VIEWPORT_WIDTH,
  TSX_STABILITY_WINDOW_MS,
} from "./limits";
import { encodeAnimatedWebpWithinCap } from "./webp";
import { type VerifierCdpSession, type VerifierTarget } from "./browser-process";
import { countsDiffer, deriveVerdict, type PageShim } from "./verdict";
import { readPidStartTimeTicks } from "../../shared/util/process";

/**
 * Hard ceiling for the captured console summary. Real page logs from
 * a hostile artifact can be unbounded; the runner truncates at this
 * boundary so a poison artifact cannot blow out the evidence dir.
 */
const CONSOLE_SUMMARY_CUP_BYTES = 64 * 1024;
const RUNTIME_EXCEPTION_CAP = 16;
const TIER1_TRACE = process.env.FACET_TIER1_TRACE === "1";

/** Probe the pinned wrapper and browser before selecting Tier 1. */
export async function probeTier1Availability(): Promise<IsolationProbeResult> {
  return probeLauncherAvailability();
}

function traceTier1(stage: string, startedAt: number, detail = ""): void {
  if (!TIER1_TRACE) return;
  const suffix = detail.length > 0 ? ` ${detail}` : "";
  process.stderr.write(`[tier1] +${Date.now() - startedAt}ms ${stage}${suffix}\n`);
}

/**
 * The wedge's second face: with the pipe torn down, puppeteer rejects
 * sends with a target/session-closed error instead of pending forever.
 * Same cause, same remedy — relaunch once with a fresh browser.
 */
function isTransportClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Session closed") ||
    message.includes("Target closed") ||
    message.includes("Connection closed")
  );
}

interface ShimCapture {
  readonly pageShim: PageShim | null;
  readonly bootReady: boolean;
  readonly renderComplete: boolean;
}

export interface CapturedEvidenceImage {
  readonly bytes: Buffer;
  readonly format: EvidenceImageFormat;
}

export interface ArtifactCaptureBounds {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

interface ArtifactCaptureMeasurement {
  readonly width: number;
  readonly height: number;
}

interface BoundedScreenshotCapture {
  readonly bounds: ArtifactCaptureBounds;
  readonly source: ArtifactCaptureMeasurement;
}

type ScreenshotCapture = (
  session: VerifierCdpSession,
  bounds?: BoundedScreenshotCapture,
) => Promise<CapturedEvidenceImage | null>;

/** Test-only hook for pinning the screenshot transport without changing verifier logic. */
export interface Tier1RunnerTestHooks {
  readonly captureScreenshot?: ScreenshotCapture;
  readonly createBrowser?: () => Pick<PuppeteerTier1Browser, "launch">;
}

export function createTier1RunnerForTests(
  hooks: Tier1RunnerTestHooks,
): (input: Tier1Input) => Promise<Tier1Result> {
  return async (input) => runTier1WithHooks(input, hooks, 0);
}

/**
 * Drive the verifier end-to-end. Returns the typed `Tier1Result`.
 * Throws `FacetError` only on system-level failures (no shell,
 * netns unavailable, browser died, probe timed out, protocol
 * error); verdict-level divergences are surfaced via the `status`
 * field on the returned result.
 *
 * A wedged CDP transport (browser alive, pipe dead — a launch-time
 * race in the subprocess layer when a browser is spawned immediately
 * after another browser's teardown) is retried ONCE with a fresh
 * browser: it is a property of the launch, not of the artifact, so a
 * relaunch verifies the same bytes.
 */
export async function runTier1(input: Tier1Input): Promise<Tier1Result> {
  return runTier1WithHooks(input, {}, 0);
}

/** Create a Tier 1 runner using the requested browser isolation level. */
export function createTier1Runner(
  level: InsecureLevel,
): (input: Tier1Input) => Promise<Tier1Result> {
  return (input) => runTier1WithHooks(input, {}, level);
}

async function runTier1WithHooks(
  input: Tier1Input,
  hooks: Tier1RunnerTestHooks,
  level: InsecureLevel,
): Promise<Tier1Result> {
  const startedAt = Date.now();
  traceTier1("run:start", startedAt);
  let lastWedge: Tier1TransportWedgeError | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      traceTier1(`attempt:${attempt + 1}:start`, startedAt);
      const result = await runTier1Attempt(input, startedAt, hooks, level);
      traceTier1(`attempt:${attempt + 1}:complete`, startedAt, `status=${result.status}`);
      return result;
    } catch (error) {
      if (error instanceof Tier1TransportWedgeError) {
        traceTier1(`attempt:${attempt + 1}:transport-wedge`, startedAt, error.message);
        lastWedge = error;
        continue;
      }
      traceTier1(
        `attempt:${attempt + 1}:error`,
        startedAt,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
  traceTier1("run:transport-error", startedAt);
  throw new FacetError("tier1_protocol_error", lastWedge?.message ?? "tier1 transport wedged", {
    retryable: false,
  });
}

async function runTier1Attempt(
  input: Tier1Input,
  startedAt = Date.now(),
  hooks: Tier1RunnerTestHooks = {},
  level: InsecureLevel = 0,
): Promise<Tier1Result> {
  if (!Number.isInteger(input.artifactType === undefined)) {
    void (input.artifactType as unknown);
  }
  const profileDir = mkdtempSync(join(tmpdir(), "facet-tier1-host-"));
  let target: VerifierTarget | undefined;
  let runtimeExceptions: RuntimeExceptionCollector | undefined;
  let targetStartTime = 0;
  let hostHtmlPath: string | undefined;
  const hostDir = mkdtempSync(join(tmpdir(), "facet-tier1-hostdir-"));
  let wedged = false;
  // Per-run evidence directory under the XDG-state evidence root
  // (mode 0700). The dispatcher wires the parent's evidenceRoot in;
  // when omitted the runner falls back to the canonical path so
  // production callers never have to specify it. The mkdir goes
  // through `ensureOwnerOnlyDirectory` so a hostile process umask
  // cannot widen the secret-bearing layout to 0755 — a fix in that
  // helper lands in one place (the service's `evidence-retention.ts`
  // delegates to the same helper).
  const evidenceRoot = input.evidenceDir ?? computeFacetPaths().evidence;
  const runId = crypto.randomUUID();
  const runEvidenceDir = ensureOwnerOnlyDirectory(
    join(evidenceRoot, "tier1", input.revisionSha, runId),
  );
  const screenshotPath = join(runEvidenceDir, "screenshot.webp");
  const consolePath = join(runEvidenceDir, "console.txt");
  const observationPath = join(runEvidenceDir, "protocol-observation.json");

  try {
    const browser =
      hooks.createBrowser?.() ??
      new PuppeteerTier1Browser({
        launcher: resolveLauncher(level, { version: input.launcherVersion }),
      });
    traceTier1("launch:start", startedAt);
    target = await browser.launch();
    traceTier1("launch:complete", startedAt, `pid=${target.pid}`);
    runtimeExceptions = new RuntimeExceptionCollector(target.session);
    // Snapshot the OS start time NOW so the wedge teardown can confirm
    // the pid still belongs to this browser before signaling it (a
    // dead browser's pid can be reused by an unrelated process).
    targetStartTime = target.startTime;
    hostHtmlPath = join(hostDir, "host.html");
    traceTier1("host-page:start", startedAt);
    const { html } = await buildHostPage(
      input.source,
      "render",
      hostDir,
      input.artifactType,
      input.renderer,
      input.execution ?? "static",
    );
    traceTier1("host-page:complete", startedAt);
    writeFileSync(hostHtmlPath, html, "utf8");
    traceTier1("cdp:enable:start", startedAt);
    await target.session.send("Runtime.enable");
    await target.session.send("Page.enable");
    traceTier1("cdp:enable:complete", startedAt);
    await configureTier1Viewport(target.session);
    traceTier1("viewport:configured", startedAt);
    traceTier1("navigate:start", startedAt);
    await target.session.send("Page.navigate", { url: `file://${hostHtmlPath}` });
    traceTier1("navigate:complete", startedAt);
    // Wait for the host page to settle.
    await waitForBootReady(target, TIER1_RENDER_BARRIER_MS);
    traceTier1("boot-ready:complete", startedAt);

    traceTier1("frame-resolve:start", startedAt);
    const childFrame = await resolveSrcdocChildFrame(target.session);
    traceTier1("frame-resolve:complete", startedAt);
    const interactiveTsx = input.artifactType === "tsx" && input.execution === "interactive";
    const staticIsolated = interactiveTsx
      ? null
      : await createIsolatedWorld(target.session, childFrame.frameId);

    // Inject the artifact via the parent page world's transfer (the
    // parent page has the ingress port; the iframe receives it via
    // postMessage handshake).
    traceTier1("deliver:start", startedAt);
    await target.session.send("Runtime.evaluate", {
      expression:
        "(function(){" +
        "var host=window.__facetHostArtifact;" +
        "if(!host){return 'no-host-artifact';}" +
        "host.ingress.postMessage({bytes:host.bytes,mode:host.mode,artifactType:host.artifactType,renderer:host.renderer,execution:host.execution});" +
        "return 'delivered';" +
        "})()",
      returnByValue: true,
    });
    traceTier1("deliver:complete", startedAt);

    traceTier1("render-complete:wait", startedAt);
    const shim = await waitForRenderComplete(target, TIER1_RENDER_BARRIER_MS);
    traceTier1("render-complete:complete", startedAt, `received=${shim.renderComplete}`);

    const artifactFrame = interactiveTsx
      ? await resolveNestedArtifactFrame(target.session, childFrame)
      : childFrame;
    const isolated =
      staticIsolated ?? (await createIsolatedWorld(target.session, artifactFrame.frameId));
    const firstObservation = await observeArtifact(
      target.session,
      artifactFrame,
      isolated.executionContextId,
      interactiveTsx ? runtimeExceptions!.errorsForFrame(artifactFrame.frameId) : [],
    );
    const secondObservation = interactiveTsx
      ? await waitForStabilityObservation(
          target.session,
          artifactFrame,
          isolated.executionContextId,
          () => runtimeExceptions!.errorsForFrame(artifactFrame.frameId),
        )
      : firstObservation;
    const protocolObservation = secondObservation.protocol;
    const isolatedObservation = secondObservation.isolated;
    const channelDivergence =
      interactiveTsx && observationsDiverge(firstObservation, secondObservation);

    const status = deriveVerdict(
      input.lexical,
      protocolObservation,
      isolatedObservation,
      interactiveTsx ? null : shim.pageShim,
      {
        bootReady: shim.bootReady,
        renderComplete: shim.renderComplete,
        interactive: interactiveTsx,
        channelDivergence,
        structureChanged:
          interactiveTsx && countsDiffer(firstObservation.protocol, secondObservation.protocol),
      },
    );
    traceTier1("verdict:complete", startedAt, `status=${status}`);

    // Capture follows derivation so a transport-only failure cannot rewrite the render verdict.
    const captured = await captureEvidence(
      target,
      {
        input,
        screenshotPath,
        consolePath,
        observationPath,
        firstProtocolObservation: firstObservation.protocol,
        protocolObservation,
        pageShim: shim.pageShim,
        executionContextId: isolated.executionContextId,
      },
      hooks.captureScreenshot,
    );
    traceTier1("evidence:complete", startedAt);

    const observed = protocolObservation;
    const result: Tier1Result = Tier1ResultSchema.parse({
      tier: 1,
      status,
      artifactId: "tier1-runner",
      revisionSha: input.revisionSha,
      expected: input.lexical,
      observed: {
        rendererRootSvgCount: observed.rendererRootSvgCount,
        graphCount: observed.graphCount,
        mermaidNodeCount: observed.mermaidNodeCount,
        visibleSvgCount: observed.visibleSvgCount,
        viewBoxes: observed.viewBoxes,
        errorCount: observed.errorCount,
        opaqueRegionCount: observed.opaqueRegionCount,
        externalImageCount: observed.externalImageCount,
        ...(observed.html === undefined ? {} : { html: observed.html }),
        discriminativeErrors: observed.discriminativeErrors,
      },
      screenshotPath: captured.screenshotPath,
      ...(captured.screenshotFormat === null
        ? {}
        : { screenshotFormat: captured.screenshotFormat }),
      consolePath: captured.consolePath,
      ...(status.startsWith("partial:") && captured.screenshotError !== null
        ? { screenshotError: captured.screenshotError }
        : {}),
    });
    return result;
  } catch (error) {
    if (error instanceof FacetError) throw error;
    if (error instanceof Tier1TransportWedgeError || isTransportClosedError(error)) {
      // Flag before the finally block so teardown kills the wedged
      // browser instead of pending on its dead pipe.
      wedged = true;
      if (error instanceof Tier1TransportWedgeError) throw error;
      const closedMessage = error instanceof Error ? error.message : String(error);
      throw new Tier1TransportWedgeError(closedMessage);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("timed out") || message.includes("timeout")) {
      throw new FacetError("tier1_timeout", message, { retryable: false });
    }
    if (message.includes("not found")) {
      throw new FacetError("tier1_launcher_missing", message, { retryable: false });
    }
    if (level === 0 && /unshare|operation not permitted|network namespace|netns/i.test(message)) {
      throw new FacetError("tier1_unavailable", message, { retryable: false });
    }
    throw new FacetError("tier1_protocol_error", message, { retryable: false, cause: error });
  } finally {
    runtimeExceptions?.close();
    if (target !== undefined) {
      if (wedged && target.pid > 0 && readPidStartTimeTicks(target.pid) === targetStartTime) {
        // A wedged transport makes close() pend on the dead pipe;
        // kill the browser first so close only reaps. The start-time
        // check pins the kill to THIS browser — signaling a reused
        // pid (or -1, the whole process group) is not an option.
        try {
          process.kill(target.pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
      await Promise.race([
        target.close().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
    if (hostHtmlPath !== undefined) {
      const cleanupStartedAt = performance.now();
      traceTier1("cleanup:host-html:start", startedAt);
      try {
        rmSync(hostHtmlPath, { force: true });
      } catch {
        // best-effort
      } finally {
        traceTier1(
          "cleanup:host-html:complete",
          startedAt,
          `durationMs=${Math.round(performance.now() - cleanupStartedAt)}`,
        );
      }
    }
    const hostDirCleanupStartedAt = performance.now();
    traceTier1("cleanup:host-dir:start", startedAt);
    try {
      rmSync(hostDir, { recursive: true, force: true });
    } catch {
      // best-effort
    } finally {
      traceTier1(
        "cleanup:host-dir:complete",
        startedAt,
        `durationMs=${Math.round(performance.now() - hostDirCleanupStartedAt)}`,
      );
    }
    const profileCleanupStartedAt = performance.now();
    traceTier1("cleanup:profile-dir:start", startedAt);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // best-effort
    } finally {
      traceTier1(
        "cleanup:profile-dir:complete",
        startedAt,
        `durationMs=${Math.round(performance.now() - profileCleanupStartedAt)}`,
      );
    }
    clearTimeout(undefined as unknown as NodeJS.Timeout);
  }
}

/**
 * Wait for the harness to emit `boot-ready` on the control port.
 * The verifier reads the control port via a Runtime.evaluate that
 * drains the parent page's recorded events; the host page keeps the
 * shim events in a JS array the verifier can inspect.
 */
async function waitForBootReady(target: VerifierTarget, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = (await target.session.send("Runtime.evaluate", {
      expression: "(function(){return JSON.stringify(window.__facetShimEvents || []);})()",
      returnByValue: true,
    })) as { result: { value: string } };
    try {
      const events = JSON.parse(result.result.value) as { type?: string }[];
      if (events.some((event) => event.type === "boot-ready")) return;
    } catch {
      // ignore parse errors
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Wait for the harness to emit `render-complete` and capture the
 * page shim's self-report.
 */
async function waitForRenderComplete(
  target: VerifierTarget,
  timeoutMs: number,
): Promise<ShimCapture> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = (await target.session.send("Runtime.evaluate", {
      expression:
        "(function(){" +
        "var events = window.__facetShimEvents || [];" +
        "var bootReady = events.some(function(e){return e.type==='boot-ready';});" +
        "var renderEvent = events.find(function(e){return e.type==='render-complete';});" +
        "return JSON.stringify({bootReady:bootReady, renderEvent:renderEvent||null});" +
        "})()",
      returnByValue: true,
    })) as { result: { value: string } };
    let parsed: { bootReady: boolean; renderEvent: { observed?: PageShim } | null };
    try {
      parsed = JSON.parse(result.result.value);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    if (parsed.renderEvent !== null && parsed.renderEvent !== undefined) {
      return {
        bootReady: parsed.bootReady,
        renderComplete: true,
        pageShim: parsed.renderEvent.observed ?? null,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { bootReady: false, renderComplete: false, pageShim: null };
}

/**
 * Combine `DOMSnapshot` and `DOM.getDocument` into a single
 * authoritative observation. When the two channels disagree on
 * counts, the protocol layer reports the disagreement to the
 * verdict via the `discriminativeErrors` field rather than picking
 * one arbitrarily — the verdict layer treats any non-empty
 * discriminativeErrors as `error`.
 */
function mergeProtocol(
  snapshot: ProtocolObservation,
  getDocument: ProtocolObservation,
  runtimeErrors: readonly { readonly code: string; readonly message: string }[] = [],
): ProtocolObservation {
  const errors = [...snapshot.discriminativeErrors, ...runtimeErrors];
  const counts = OBSERVED_COUNT_KEYS.filter((key) => key !== "externalImageCount").map(
    (key) => [key.replace(/Count$/, ""), snapshot[key], getDocument[key]] as const,
  );
  for (const [name, fromSnapshot, fromDocument] of counts) {
    if (fromSnapshot === fromDocument) continue;
    errors.push({
      code: "protocol_divergence",
      message: `DOMSnapshot.${name}=${fromSnapshot} vs DOM.getDocument.${name}=${fromDocument}`,
    });
  }
  if (snapshot.errorCount !== getDocument.errorCount) {
    errors.push({
      code: "protocol_divergence",
      message: `DOMSnapshot.errors=${snapshot.errorCount} vs DOM.getDocument.errors=${getDocument.errorCount}`,
    });
  }
  // The top-level external-image count is compared below, matching the
  // established protocol divergence behavior without double-reporting it.
  const htmlKeys = HTML_OBSERVED_COUNT_KEYS.filter((key) => key !== "externalImageCount");
  if (snapshot.html === undefined || getDocument.html === undefined) {
    if (snapshot.html !== getDocument.html) {
      errors.push({
        code: "protocol_divergence",
        message: "DOMSnapshot.html presence differs from DOM.getDocument.html",
      });
    }
  } else {
    for (const key of htmlKeys) {
      if (snapshot.html[key] !== getDocument.html[key]) {
        errors.push({
          code: "protocol_divergence",
          message: `DOMSnapshot.html.${key}=${snapshot.html[key]} vs DOM.getDocument.html.${key}=${getDocument.html[key]}`,
        });
      }
    }
  }
  if (snapshot.externalImageCount !== getDocument.externalImageCount) {
    errors.push({
      code: "protocol_divergence",
      message: `DOMSnapshot.externalImageCount=${snapshot.externalImageCount} vs DOM.getDocument.externalImageCount=${getDocument.externalImageCount}`,
    });
  }
  const observedCounts = Object.fromEntries(
    OBSERVED_COUNT_KEYS.map((key) => [key, snapshot[key]]),
  ) as Pick<ProtocolObservation, ObservedCountKey>;
  return {
    ...observedCounts,
    viewBoxes: snapshot.viewBoxes,
    errorCount: snapshot.errorCount,
    ...(snapshot.html === undefined ? {} : { html: snapshot.html }),
    discriminativeErrors: errors,
  };
}

export interface ArtifactObservation {
  readonly protocol: ProtocolObservation;
  readonly isolated: ProtocolObservation | null;
}

interface RuntimeExceptionDetails {
  readonly executionContextId?: number;
  readonly text?: string;
  readonly exception?: {
    readonly description?: string;
    readonly value?: unknown;
  };
}

interface RuntimeExecutionContextCreated {
  readonly context?: {
    readonly id?: number;
    readonly auxData?: { readonly frameId?: string };
  };
}

interface RuntimeExceptionThrown {
  readonly exceptionDetails?: RuntimeExceptionDetails;
}

/**
 * Runtime exceptions are protocol authority: the page cannot erase an event
 * that CDP delivered before either DOM observation runs.
 */
export class RuntimeExceptionCollector {
  private readonly frameByExecutionContext = new Map<number, string>();
  private readonly exceptions: Array<{
    readonly executionContextId: number;
    readonly message: string;
  }> = [];
  private readonly onContextCreated = (params: unknown): void => {
    const created = params as RuntimeExecutionContextCreated;
    const id = created.context?.id;
    const frameId = created.context?.auxData?.frameId;
    if (typeof id === "number" && typeof frameId === "string") {
      this.frameByExecutionContext.set(id, frameId);
    }
  };
  private readonly onExceptionThrown = (params: unknown): void => {
    if (this.exceptions.length >= RUNTIME_EXCEPTION_CAP) return;
    const details = (params as RuntimeExceptionThrown).exceptionDetails;
    const executionContextId = details?.executionContextId;
    if (typeof executionContextId !== "number") return;
    const message = runtimeExceptionMessage(details);
    this.exceptions.push({ executionContextId, message });
  };

  constructor(private readonly session: VerifierCdpSession) {
    session.on("Runtime.executionContextCreated", this.onContextCreated);
    session.on("Runtime.exceptionThrown", this.onExceptionThrown);
  }

  errorsForFrame(frameId: string): readonly { readonly code: string; readonly message: string }[] {
    return this.exceptions
      .filter((entry) => this.frameByExecutionContext.get(entry.executionContextId) === frameId)
      .map((entry) => ({ code: "runtime_exception", message: entry.message }));
  }

  close(): void {
    this.session.off("Runtime.executionContextCreated", this.onContextCreated);
    this.session.off("Runtime.exceptionThrown", this.onExceptionThrown);
  }
}

function runtimeExceptionMessage(details: RuntimeExceptionDetails | undefined): string {
  if (typeof details?.exception?.description === "string") return details.exception.description;
  if (typeof details?.exception?.value === "string") return details.exception.value;
  if (typeof details?.text === "string") return details.text;
  return "runtime exception";
}

export function authorityChannelsDiverge(
  protocol: ProtocolObservation,
  isolated: ProtocolObservation | null,
): boolean {
  return (
    protocol.discriminativeErrors.some((error) => error.code === "protocol_divergence") ||
    (isolated !== null && countsDiffer(isolated, protocol))
  );
}

export function observationsDiverge(
  first: ArtifactObservation,
  second: ArtifactObservation,
): boolean {
  return (
    authorityChannelsDiverge(first.protocol, first.isolated) ||
    authorityChannelsDiverge(second.protocol, second.isolated)
  );
}

async function observeArtifact(
  session: VerifierCdpSession,
  frame: { readonly frameId: string; readonly url: string },
  executionContextId: number,
  runtimeErrors: readonly { readonly code: string; readonly message: string }[],
): Promise<ArtifactObservation> {
  const snapshot = await probeProtocolSnapshot(session, frame);
  const document = await probeProtocolGetDocument(session, frame);
  const isolated = await probeIsolatedCounts(session, executionContextId);
  return { protocol: mergeProtocol(snapshot, document, runtimeErrors), isolated };
}

async function waitForStabilityObservation(
  session: VerifierCdpSession,
  frame: { readonly frameId: string; readonly url: string },
  executionContextId: number,
  runtimeErrors: () => readonly { readonly code: string; readonly message: string }[],
): Promise<ArtifactObservation> {
  await Bun.sleep(TSX_STABILITY_WINDOW_MS);
  return observeArtifact(session, frame, executionContextId, runtimeErrors());
}

interface EvidenceCapture {
  readonly screenshotPath: string | null;
  readonly screenshotFormat: EvidenceImageFormat | null;
  readonly screenshotError: ScreenshotError | null;
  /**
   * Console summary path. The bounded console write is pure
   * filesystem IO and always succeeds, so this field is non-nullable
   * — a transport-wedged browser can lose its screenshot but not its
   * console summary (the per-run directory is already on disk by the
   * time captureEvidence runs).
   */
  readonly consolePath: string;
}

/**
 * Capture screenshot + bounded console summary + protocol observation
 * to the per-run evidence directory. Always succeeds at writing the
 * console summary + observation JSON (pure filesystem IO); the screenshot
 * may fail when the browser transport is wedged or the page is closed
 * — those failures land as `null` rather than throwing so the verdict
 * can still be recorded.
 *
 * Determinism: emulate prefers-reduced-motion + await
 * `document.fonts.ready` BEFORE `Page.captureScreenshot`. Without the
 * two, two runs over the same artifact differ byte-for-byte in font
 * loading order + animation timing (perf-spike finding).
 */
export async function configureTier1Viewport(session: VerifierCdpSession): Promise<void> {
  return configureTier1ViewportBounds(session, {
    width: TIER1_VIEWPORT_WIDTH,
    height: TIER1_VIEWPORT_HEIGHT,
  });
}

async function configureTier1ViewportBounds(
  session: VerifierCdpSession,
  bounds: ArtifactCaptureMeasurement,
): Promise<void> {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: bounds.width,
    height: bounds.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

export function boundCaptureSize(input: {
  readonly width: number;
  readonly height: number;
}): ArtifactCaptureBounds {
  if (
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.height) ||
    input.width <= 0 ||
    input.height <= 0
  )
    throw new Error("artifact capture bounds are invalid");
  const scale = Math.min(
    1,
    TIER1_SCREENSHOT_MAX_AXIS_PX / input.width,
    TIER1_SCREENSHOT_MAX_AXIS_PX / input.height,
    Math.sqrt(TIER1_SCREENSHOT_MAX_PIXELS / (input.width * input.height)),
  );
  return {
    width: Math.max(1, Math.floor(input.width * scale)),
    height: Math.max(1, Math.floor(input.height * scale)),
    scale,
  };
}

export async function measureArtifactCaptureBounds(
  session: VerifierCdpSession,
  executionContextId: number,
): Promise<ArtifactCaptureBounds> {
  return boundCaptureSize(await measureArtifactCaptureSize(session, executionContextId));
}

async function measureArtifactCaptureSize(
  session: VerifierCdpSession,
  executionContextId: number,
): Promise<ArtifactCaptureMeasurement> {
  const measured = (await session.send("Runtime.evaluate", {
    contextId: executionContextId,
    returnByValue: true,
    expression: [
      "(function(){",
      "  var container=document.getElementById('artifact');",
      "  if(!container) return null;",
      "  var containerRect=container.getBoundingClientRect();",
      "  var child=container.firstElementChild;",
      "  var childRect=child ? child.getBoundingClientRect() : containerRect;",
      "  return {",
      "    width:Math.max(container.scrollWidth,childRect.right-containerRect.left),",
      "    height:Math.max(container.scrollHeight,childRect.bottom-containerRect.top)",
      "  };",
      "})()",
    ].join("\n"),
  })) as { result: { value?: { width?: unknown; height?: unknown } | null } };
  const value = measured.result.value;
  if (
    value === null ||
    value === undefined ||
    typeof value.width !== "number" ||
    typeof value.height !== "number"
  )
    throw new Error("artifact capture bounds are unavailable");
  return { width: Math.ceil(value.width), height: Math.ceil(value.height) };
}

export async function captureBoundedScreenshot(
  session: VerifierCdpSession,
  bounded?: BoundedScreenshotCapture,
): Promise<CapturedEvidenceImage | null> {
  const shot = (await session.send(
    "Page.captureScreenshot",
    captureBoundedScreenshotParams("webp", bounded),
  )) as { data?: string };
  if (typeof shot.data !== "string" || shot.data.length === 0) return null;
  if (shot.data.length > (TIER1_SCREENSHOT_CAP_BYTES * 4) / 3 + 4) return null;
  const bytes = Buffer.from(shot.data, "base64");
  if (bytes.byteLength > TIER1_SCREENSHOT_CAP_BYTES) return null;
  return { bytes, format: "webp" };
}

export function captureBoundedScreenshotParams(
  format: "png" | "webp",
  bounded?: BoundedScreenshotCapture,
): {
  readonly format: "png" | "webp";
  readonly quality?: number;
  readonly captureBeyondViewport: true;
  readonly clip?: {
    readonly x: 0;
    readonly y: 0;
    readonly width: number;
    readonly height: number;
    readonly scale: number;
  };
} {
  return {
    format,
    ...(format === "webp" ? { quality: TIER1_SCREENSHOT_WEBP_QUALITY } : {}),
    captureBeyondViewport: true,
    ...(bounded === undefined || bounded.bounds.scale === 1
      ? {}
      : {
          clip: {
            x: 0,
            y: 0,
            width: bounded.source.width,
            height: bounded.source.height,
            scale: bounded.bounds.scale,
          },
        }),
  };
}

async function captureBoundedPngScreenshot(
  session: VerifierCdpSession,
  bounded?: BoundedScreenshotCapture,
): Promise<Buffer | null> {
  const shot = (await session.send(
    "Page.captureScreenshot",
    captureBoundedScreenshotParams("png", bounded),
  )) as { data?: string };
  if (typeof shot.data !== "string" || shot.data.length === 0) return null;
  return Buffer.from(shot.data, "base64");
}

export async function hasDeclaredAnimation(
  input: Tier1Input,
  session: VerifierCdpSession,
  executionContextId: number,
): Promise<boolean> {
  if (input.execution === "interactive") return true;
  const evaluated = (await session.send("Runtime.evaluate", {
    contextId: executionContextId,
    returnByValue: true,
    expression:
      "document.getAnimations().some(a => a.playState === 'running' || a.playState === 'pending')",
  })) as { result?: { value?: unknown } };
  return evaluated.result?.value === true;
}

async function captureAnimatedScreenshot(
  session: VerifierCdpSession,
  bounds?: BoundedScreenshotCapture,
): Promise<CapturedEvidenceImage | null> {
  if (bounds === undefined) return null;
  const frames: Buffer[] = [];
  for (let index = 0; index < TIER1_ANIMATION_FRAME_COUNT; index += 1) {
    const frame = await captureBoundedPngScreenshot(session, bounds);
    if (frame === null) return null;
    frames.push(frame);
    if (index < TIER1_ANIMATION_FRAME_COUNT - 1) {
      await session.send("Runtime.evaluate", {
        contextId: undefined,
        expression: `new Promise(resolve => setTimeout(resolve, ${TIER1_ANIMATION_FRAME_INTERVAL_MS}))`,
        awaitPromise: true,
        returnByValue: true,
      });
    }
  }
  const bytes = await encodeAnimatedWebpWithinCap(frames, {
    width: bounds.bounds.width,
    height: bounds.bounds.height,
    delayMs: TIER1_ANIMATION_FRAME_INTERVAL_MS,
    qualities: TIER1_ANIMATION_WEBP_QUALITIES,
    capBytes: TIER1_SCREENSHOT_CAP_BYTES,
  });
  return bytes === null ? null : { bytes, format: "webp" };
}

export async function captureEvidenceScreenshot(
  session: VerifierCdpSession,
  options: {
    readonly animated: boolean;
    readonly bounds: BoundedScreenshotCapture;
    readonly captureStatic?: ScreenshotCapture;
  },
): Promise<{
  readonly screenshot: CapturedEvidenceImage | null;
  readonly screenshotError: ScreenshotError | null;
}> {
  if (options.animated) {
    return captureScreenshotWithRetry(session, {
      bounds: options.bounds,
      capture: captureAnimatedScreenshot,
    });
  }
  return options.captureStatic === undefined
    ? captureScreenshotWithRetry(session, { bounds: options.bounds })
    : captureScreenshotWithRetry(session, {
        bounds: options.bounds,
        capture: options.captureStatic,
      });
}

interface ScreenshotRetryOptions {
  readonly attempts?: number;
  readonly timeoutMs?: number;
  readonly capture?: ScreenshotCapture;
  readonly bounds?: BoundedScreenshotCapture;
}

function screenshotFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `screenshot capture unavailable: ${message}`;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`screenshot capture timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function captureScreenshotWithRetry(
  session: VerifierCdpSession,
  options: ScreenshotRetryOptions = {},
): Promise<{
  readonly screenshot: CapturedEvidenceImage | null;
  readonly screenshotError: ScreenshotError | null;
}> {
  const attempts = options.attempts ?? TIER1_SCREENSHOT_CAPTURE_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? TIER1_SCREENSHOT_CAPTURE_TIMEOUT_MS;
  const capture = options.capture ?? captureBoundedScreenshot;
  let failure: unknown = new Error("screenshot capture returned no data");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pendingCapture = capture(session, options.bounds);
    try {
      const screenshot = await withTimeout(pendingCapture, timeoutMs);
      if (screenshot !== null) return { screenshot, screenshotError: null };
      failure = new Error("screenshot capture returned no data");
    } catch (error) {
      failure = error;
      try {
        await withTimeout(
          pendingCapture.catch(() => undefined),
          timeoutMs,
        );
      } catch {
        break;
      }
    }
  }
  return {
    screenshot: null,
    screenshotError: { code: "screenshot_unavailable", message: screenshotFailureMessage(failure) },
  };
}

async function captureEvidence(
  target: VerifierTarget,
  options: {
    readonly input: Tier1Input;
    readonly screenshotPath: string;
    readonly consolePath: string;
    readonly observationPath: string;
    readonly firstProtocolObservation: ProtocolObservation;
    readonly protocolObservation: ProtocolObservation;
    readonly pageShim: PageShim | null;
    readonly executionContextId: number;
  },
  captureScreenshot?: ScreenshotCapture,
): Promise<EvidenceCapture> {
  let screenshotPath: string | null = null;
  let screenshotFormat: EvidenceImageFormat | null = null;
  let screenshotError: ScreenshotError | null = null;
  try {
    const animated = await hasDeclaredAnimation(
      options.input,
      target.session,
      options.executionContextId,
    );
    // Static evidence resolves reduced motion deterministically; animated
    // evidence restores no-preference after the verdict has been derived.
    await target.session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    if (animated) {
      await target.session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
    }
    await target.session.send("Runtime.evaluate", {
      expression:
        "(async()=>{if(document.fonts&&document.fonts.ready){await document.fonts.ready;}" +
        "return 'ready';})()",
      awaitPromise: true,
      returnByValue: true,
    });
    const initialSize = await measureArtifactCaptureSize(
      target.session,
      options.executionContextId,
    );
    await configureTier1ViewportBounds(target.session, initialSize);
    await target.session.send("Runtime.evaluate", {
      contextId: options.executionContextId,
      expression: "new Promise(requestAnimationFrame)",
      awaitPromise: true,
      returnByValue: true,
    });
    const finalSize = await measureArtifactCaptureSize(target.session, options.executionContextId);
    if (finalSize.width > initialSize.width || finalSize.height > initialSize.height)
      throw new Error("artifact grew after viewport resize");
    const bounds = boundCaptureSize(finalSize);
    const captureOptions = { bounds: { bounds, source: finalSize } };
    const capture = await captureEvidenceScreenshot(target.session, {
      animated,
      bounds: captureOptions.bounds,
      ...(captureScreenshot === undefined ? {} : { captureStatic: captureScreenshot }),
    });
    screenshotError = capture.screenshotError;
    const screenshot = capture.screenshot;
    if (screenshot !== null) {
      writeFileSync(options.screenshotPath, screenshot.bytes);
      screenshotPath = options.screenshotPath;
      screenshotFormat = screenshot.format;
    }
  } catch (error) {
    screenshotError = {
      code: "screenshot_unavailable",
      message: screenshotFailureMessage(error),
    };
  }
  // Bounded console summary — never grow past CONSOLE_SUMMARY_CUP_BYTES.
  // The shim self-report + a fixed header covers the diagnostic surface;
  // a hostile artifact cannot inflate this past the cap.
  const summaryParts: string[] = [
    `tier1 evidence for revisionSha=${options.protocolObservation ? "ok" : "ok"}`,
    `protocol: ${JSON.stringify(options.protocolObservation)}`,
  ];
  if (options.pageShim !== null) {
    summaryParts.push(`shim: ${JSON.stringify(options.pageShim)}`);
  }
  const summary = summaryParts.join("\n").slice(0, CONSOLE_SUMMARY_CUP_BYTES);
  writeFileSync(options.consolePath, summary, "utf8");
  writeFileSync(
    options.observationPath,
    JSON.stringify(
      { first: options.firstProtocolObservation, second: options.protocolObservation },
      null,
      2,
    ),
    "utf8",
  );
  return { screenshotPath, screenshotFormat, screenshotError, consolePath: options.consolePath };
}
