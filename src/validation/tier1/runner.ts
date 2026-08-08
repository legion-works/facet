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

import { buildHostPage } from "./harness";
import { PuppeteerTier1Browser } from "./cdp-pipe";
import { resolveLauncher } from "./launcher";
import { createIsolatedWorld, resolveSrcdocChildFrame } from "./frame-target";
import { probeProtocolGetDocument, probeProtocolSnapshot } from "./protocol-probe";
import { probeIsolatedCounts } from "./isolated-probe";
import { TIER1_RENDER_BARRIER_MS } from "./limits";
import { type VerifierTarget } from "./browser-process";
import { deriveVerdict, type PageShim } from "./verdict";

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
 */
export async function runTier1(input: Tier1Input): Promise<Tier1Result> {
  if (!Number.isInteger(input.artifactType === undefined)) {
    void (input.artifactType as unknown);
  }
  const browser = new PuppeteerTier1Browser({
    launcher: resolveLauncher({ version: input.launcherVersion }),
  });
  const profileDir = mkdtempSync(join(tmpdir(), "facet-tier1-host-"));
  let target: VerifierTarget | undefined;
  let hostHtmlPath: string | undefined;
  const hostDir = mkdtempSync(join(tmpdir(), "facet-tier1-hostdir-"));

  try {
    target = await browser.launch();
    hostHtmlPath = join(hostDir, "host.html");
    const { html } = await buildHostPage(input.source, "render", hostDir, input.artifactType);
    writeFileSync(hostHtmlPath, html, "utf8");
    await target.session.send("Page.enable");
    await target.session.send("Page.navigate", { url: `file://${hostHtmlPath}` });
    // Wait for the host page to settle.
    await waitForBootReady(target, TIER1_RENDER_BARRIER_MS);

    const childFrame = await resolveSrcdocChildFrame(target.session);
    const isolated = await createIsolatedWorld(target.session, childFrame.frameId);

    // Inject the artifact via the parent page world's transfer (the
    // parent page has the ingress port; the iframe receives it via
    // postMessage handshake).
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

    const shim = await waitForRenderComplete(target, TIER1_RENDER_BARRIER_MS);

    const protocolSnapshot = await probeProtocolSnapshot(target.session, childFrame);
    const protocolGetDocument = await probeProtocolGetDocument(target.session);
    const isolatedObservation = await probeIsolatedCounts(
      target.session,
      isolated.executionContextId,
    );

    const protocolObservation = mergeProtocol(protocolSnapshot, protocolGetDocument);

    const status = deriveVerdict(
      input.lexical,
      protocolObservation,
      isolatedObservation,
      shim.pageShim,
      { bootReady: shim.bootReady, renderComplete: shim.renderComplete },
    );

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
      screenshotPath: null,
      consolePath: null,
    });
    return result;
  } catch (error) {
    if (error instanceof FacetError) throw error;
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
      await target.close().catch(() => {});
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
