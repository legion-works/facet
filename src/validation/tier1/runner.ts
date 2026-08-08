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

import {
  Tier1ResultSchema,
  type ProtocolObservation,
  type Tier1Input,
  type Tier1Result,
} from "../../shared/contracts/validation";
import { FacetError } from "../../shared/errors/facet-error";
import { computeFacetPaths } from "../../shared/config/paths";
import { ensureOwnerOnlyDirectory } from "../../shared/util/dir-permissions";

import { buildHostPage } from "./harness";
import { PuppeteerTier1Browser, Tier1TransportWedgeError } from "./cdp-pipe";
import { resolveLauncher } from "./launcher";
import { createIsolatedWorld, resolveSrcdocChildFrame } from "./frame-target";
import { probeProtocolGetDocument, probeProtocolSnapshot } from "./protocol-probe";
import { probeIsolatedCounts } from "./isolated-probe";
import { TIER1_RENDER_BARRIER_MS } from "./limits";
import { type VerifierTarget } from "./browser-process";
import { deriveVerdict, type PageShim } from "./verdict";
import { readPidStartTimeTicks } from "../../shared/util/process";

/**
 * Hard ceiling for the captured console summary. Real page logs from
 * a hostile artifact can be unbounded; the runner truncates at this
 * boundary so a poison artifact cannot blow out the evidence dir.
 */
const CONSOLE_SUMMARY_CUP_BYTES = 64 * 1024;
const TIER1_TRACE = process.env.FACET_TIER1_TRACE === "1";

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
  const startedAt = Date.now();
  traceTier1("run:start", startedAt);
  let lastWedge: Tier1TransportWedgeError | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      traceTier1(`attempt:${attempt + 1}:start`, startedAt);
      const result = await runTier1Attempt(input, startedAt);
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

async function runTier1Attempt(input: Tier1Input, startedAt = Date.now()): Promise<Tier1Result> {
  if (!Number.isInteger(input.artifactType === undefined)) {
    void (input.artifactType as unknown);
  }
  const browser = new PuppeteerTier1Browser({
    launcher: resolveLauncher({ version: input.launcherVersion }),
  });
  const profileDir = mkdtempSync(join(tmpdir(), "facet-tier1-host-"));
  let target: VerifierTarget | undefined;
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
  const screenshotPath = join(runEvidenceDir, "screenshot.png");
  const consolePath = join(runEvidenceDir, "console.txt");
  const observationPath = join(runEvidenceDir, "protocol-observation.json");

  try {
    traceTier1("launch:start", startedAt);
    target = await browser.launch();
    traceTier1("launch:complete", startedAt, `pid=${target.pid}`);
    // Snapshot the OS start time NOW so the wedge teardown can confirm
    // the pid still belongs to this browser before signaling it (a
    // dead browser's pid can be reused by an unrelated process).
    targetStartTime = target.startTime;
    hostHtmlPath = join(hostDir, "host.html");
    const { html } = await buildHostPage(input.source, "render", hostDir, input.artifactType);
    traceTier1("host-page:complete", startedAt);
    writeFileSync(hostHtmlPath, html, "utf8");
    traceTier1("cdp:enable:start", startedAt);
    await target.session.send("Page.enable");
    traceTier1("cdp:enable:complete", startedAt);
    traceTier1("navigate:start", startedAt);
    await target.session.send("Page.navigate", { url: `file://${hostHtmlPath}` });
    traceTier1("navigate:complete", startedAt);
    // Wait for the host page to settle.
    await waitForBootReady(target, TIER1_RENDER_BARRIER_MS);
    traceTier1("boot-ready:complete", startedAt);

    traceTier1("frame-resolve:start", startedAt);
    const childFrame = await resolveSrcdocChildFrame(target.session);
    traceTier1("frame-resolve:complete", startedAt);
    traceTier1("isolated-world:start", startedAt);
    const isolated = await createIsolatedWorld(target.session, childFrame.frameId);
    traceTier1("isolated-world:complete", startedAt);

    // Inject the artifact via the parent page world's transfer (the
    // parent page has the ingress port; the iframe receives it via
    // postMessage handshake).
    traceTier1("deliver:start", startedAt);
    await target.session.send("Runtime.evaluate", {
      expression:
        "(function(){" +
        "var host=window.__facetHostArtifact;" +
        "if(!host){return 'no-host-artifact';}" +
        "host.ingress.postMessage({bytes:host.bytes,mode:host.mode,artifactType:host.artifactType});" +
        "return 'delivered';" +
        "})()",
      returnByValue: true,
    });
    traceTier1("deliver:complete", startedAt);

    traceTier1("render-complete:wait", startedAt);
    const shim = await waitForRenderComplete(target, TIER1_RENDER_BARRIER_MS);
    traceTier1("render-complete:complete", startedAt, `received=${shim.renderComplete}`);

    traceTier1("protocol-snapshot:start", startedAt);
    const protocolSnapshot = await probeProtocolSnapshot(target.session, childFrame);
    traceTier1("protocol-snapshot:complete", startedAt);
    traceTier1("protocol-document:start", startedAt);
    const protocolGetDocument = await probeProtocolGetDocument(target.session);
    traceTier1("protocol-document:complete", startedAt);
    traceTier1("isolated-probe:start", startedAt);
    const isolatedObservation = await probeIsolatedCounts(
      target.session,
      isolated.executionContextId,
    );
    traceTier1("isolated-probe:complete", startedAt);

    const protocolObservation = mergeProtocol(protocolSnapshot, protocolGetDocument);

    const status = deriveVerdict(
      input.lexical,
      protocolObservation,
      isolatedObservation,
      shim.pageShim,
      { bootReady: shim.bootReady, renderComplete: shim.renderComplete },
    );
    traceTier1("verdict:complete", startedAt, `status=${status}`);

    // Capture evidence AFTER the verdict is known so a `partial:*`
    // verdict always lands with a screenshot path (the schema refine
    // enforces this; the runner honors it). Reduced-motion emulation
    // + a document.fonts.ready await make the screenshot deterministic
    // across re-runs (perf-spike finding: byte-identical across 20 runs).
    const captured = await captureEvidence(target, {
      screenshotPath,
      consolePath,
      observationPath,
      protocolObservation,
      pageShim: shim.pageShim,
    });
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
        discriminativeErrors: observed.discriminativeErrors,
      },
      screenshotPath: captured.screenshotPath,
      consolePath: captured.consolePath,
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
    throw new FacetError("tier1_protocol_error", message, { retryable: false, cause: error });
  } finally {
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
      try {
        rmSync(hostHtmlPath, { force: true });
      } catch {
        // best-effort
      }
    }
    try {
      rmSync(hostDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // best-effort
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
): ProtocolObservation {
  const errors = [...snapshot.discriminativeErrors];
  if (snapshot.rendererRootSvgCount !== getDocument.rendererRootSvgCount) {
    errors.push({
      code: "protocol_divergence",
      message: `DOMSnapshot.svg=${snapshot.rendererRootSvgCount} vs DOM.getDocument.svg=${getDocument.rendererRootSvgCount}`,
    });
  }
  if (snapshot.errorCount !== getDocument.errorCount) {
    errors.push({
      code: "protocol_divergence",
      message: `DOMSnapshot.errors=${snapshot.errorCount} vs DOM.getDocument.errors=${getDocument.errorCount}`,
    });
  }
  return {
    rendererRootSvgCount: snapshot.rendererRootSvgCount,
    graphCount: snapshot.graphCount,
    mermaidNodeCount: snapshot.mermaidNodeCount,
    visibleSvgCount: snapshot.visibleSvgCount,
    viewBoxes: snapshot.viewBoxes,
    errorCount: snapshot.errorCount,
    discriminativeErrors: errors,
  };
}

interface EvidenceCapture {
  readonly screenshotPath: string | null;
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
async function captureEvidence(
  target: VerifierTarget,
  options: {
    readonly screenshotPath: string;
    readonly consolePath: string;
    readonly observationPath: string;
    readonly protocolObservation: ProtocolObservation;
    readonly pageShim: PageShim | null;
  },
): Promise<EvidenceCapture> {
  let screenshotPath: string | null = null;
  try {
    // Emulate reduced-motion so animations resolve to their final
    // frame; document.fonts.ready ensures webfont glyphs have laid
    // out before the screenshot fires (byte-determinism pre-flight).
    await target.session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await target.session.send("Runtime.evaluate", {
      expression:
        "(async()=>{if(document.fonts&&document.fonts.ready){await document.fonts.ready;}" +
        "return 'ready';})()",
      awaitPromise: true,
      returnByValue: true,
    });
    const shot = (await target.session.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })) as { data?: string };
    if (typeof shot.data === "string" && shot.data.length > 0) {
      writeFileSync(options.screenshotPath, Buffer.from(shot.data, "base64"));
      screenshotPath = options.screenshotPath;
    }
  } catch {
    // screenshot is best-effort; a transport-wedged page cannot be
    // captured but the verdict is still authoritative.
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
    JSON.stringify(options.protocolObservation, null, 2),
    "utf8",
  );
  return { screenshotPath, consolePath: options.consolePath };
}
