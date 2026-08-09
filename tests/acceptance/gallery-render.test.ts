import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FacetClient, publishArtifact } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import { resolveLauncher } from "../../src/validation/tier1/launcher";

/**
 * The gallery is Tier 2 — the USER'S browser looking at a loopback service —
 * so it must NOT launch through the netns wrapper. A Tier 1 verifier browser
 * runs with no egress and `lo` down, which is the whole point of that tier and
 * also means it cannot reach 127.0.0.1: navigation returns
 * `net::ERR_INTERNET_DISCONNECTED` and the page stays blank. This gate was
 * structurally unable to pass while it modelled the verifier instead of the
 * viewer. `binaryPath` is the pinned shell itself; `executablePath` is the
 * netns wrapper puppeteer execs — overriding one with the other launches the
 * same audited binary without the namespace.
 */
function galleryBrowser(): PuppeteerTier1Browser {
  const launcher = resolveLauncher();
  return new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
}

const browser = galleryBrowser();
const liveGateEnabled = process.env.FACET_LIVE_GALLERY === "1";
// probeAvailability() launches a REAL browser through the netns wrapper and
// tears it down. Doing that at module level ran it on EVERY suite run for a
// test that only executes under FACET_LIVE_GALLERY=1 — and a browser
// lifecycle completing before the next file's service exists is the observed
// trigger for a hung response in the following test.
const availability = liveGateEnabled
  ? await browser.probeAvailability()
  : { available: false, reason: "live gallery gate disabled" };

test.skipIf(!liveGateEnabled || !availability.available)(
  "real gallery route mounts an opaque frame and renders a canvas chart",
  async () => {
    const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-acceptance-"));
    const service = await startFacetService({
      dbPath: join(envDir, "facet.sqlite"),
      installTokenPath: join(envDir, "install.token"),
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath: join(envDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-acceptance" }),
      tier0Runner: stubTier0Runner,
    });
    let target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>> | undefined;
    try {
      const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
      const published = await publishArtifact(client, {
        artifactType: "chart",
        renderer: "canvas",
        bytes: new TextEncoder().encode(
          '{"mark":"bar","data":{"values":[{"x":"A","y":1}]},"encoding":{"x":{"field":"x","type":"nominal"},"y":{"field":"y","type":"quantitative"}}}',
        ).buffer as ArrayBuffer,
        slug: "gallery-render-acceptance",
      });
      const opened = await client.sendCommand({
        command: "open",
        requestId: crypto.randomUUID(),
        artifactId: published.artifactId,
        revisionSha: published.revisionSha,
      });
      if (!opened.ok || opened.data.command !== "open")
        throw new Error("gallery open command failed");

      target = await browser.launch();
      const navResult = await target.session.send<{ errorText?: string }>("Page.navigate", {
        url: opened.data.frameUrl,
      });
      // Surface a navigation error directly. Without this the failure arrives
      // as "no iframe rendered", which reads as a renderer bug and sends the
      // next reader into the gallery code instead of at the transport.
      if (navResult.errorText !== undefined && navResult.errorText.length > 0) {
        throw new Error(`gallery navigation failed: ${navResult.errorText}`);
      }
      const evaluation = await target.session.send<{
        result?: {
          value?: {
            iframeCount: number;
            status: string;
            live: string;
            revision: string;
            frameSrc: string;
          };
        };
      }>("Runtime.evaluate", {
        // Without returnByValue the CDP result is an object HANDLE, so
        // `result.value` is undefined no matter what the page resolved. The
        // test then fails on every run and its diagnostic reports `undefined`
        // for every field — it could not observe a working gallery, let alone
        // a broken one. Both production probes (isolated-probe.ts,
        // scripts/perf/gallery-stages.ts) pass it; this gate did not.
        returnByValue: true,
        awaitPromise: true,
        // MUST stay below TIER1_CDP_CALL_WATCHDOG_MS (10s): the watchdog kills
        // the CDP call, so an in-page deadline above it can never resolve and
        // the test reports a transport wedge instead of the diagnostic it
        // exists to collect — the same inversion that hid the render-barrier
        // timeout. Strict ordering: in-page deadline < CDP watchdog < test budget.
        expression: `new Promise((resolve) => {
          const deadline = Date.now() + 7000;
          const inspect = () => {
            const iframe = document.querySelector('iframe');
            const status = document.querySelector('#facet-status-line')?.textContent ?? '';
            const live = document.querySelector('#facet-live')?.dataset.state ?? '';
            const revision = document.querySelector('#facet-revision')?.textContent ?? '';
            // contentDocument is null for an opaque-origin sandboxed frame, by
            // design — the shell cannot read into the artifact and neither can
            // this gate. Observe the SHELL's own state instead: the frame src
            // carries the routed artifact type, and the status line reaches
            // 'displayed' only after the frame reports render-complete over
            // the control port.
            if ((status === 'displayed' && live === 'live') || status === 'error' || Date.now() >= deadline) {
              const frameSrc = iframe?.getAttribute('src') ?? '';
              resolve({
                iframeCount: document.querySelectorAll('iframe').length,
                status,
                live,
                revision,
                frameSrc,
              });
              return;
            }
            setTimeout(inspect, 100);
          };
          inspect();
        })`,
      });
      const result = evaluation.result?.value;
      if (result?.status !== "displayed") {
        console.error(
          `gallery diagnostic: status=${result?.status} live=${result?.live} iframes=${result?.iframeCount} src=${result?.frameSrc}`,
        );
      }
      expect(result?.iframeCount).toBe(1);
      expect(result?.status).toBe("displayed");
      expect(result?.live).toBe("live");
      // The shell can only observe the opaque frame URL; both routing values
      // prove the gallery selected the chart bundle and canvas backend.
      expect(result?.frameSrc).toContain("type=chart");
      expect(result?.frameSrc).toContain("renderer=canvas");
      expect(result?.revision).toContain(published.revisionSha.slice(0, 7));

      const nativeView = await target.session.send<{
        result?: { value?: { mode: string; transform: string } };
      }>("Runtime.evaluate", {
        returnByValue: true,
        awaitPromise: true,
        expression: `new Promise((resolve) => {
           document.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
           const deadline = Date.now() + 7000;
           const inspect = () => {
             const iframe = document.querySelector('iframe');
             const mode = document.querySelector('#facet-canvas')?.dataset.viewMode ?? '';
             const transform = iframe?.style.transform ?? '';
             if (mode === 'native' || Date.now() >= deadline) {
               resolve({ mode, transform });
               return;
             }
             setTimeout(inspect, 50);
           };
           inspect();
         })`,
      });
      expect(nativeView.result?.value?.mode).toBe("css");
    } finally {
      await target?.close();
      await service.stop();
      rmSync(envDir, { recursive: true, force: true });
    }
  },
  45_000,
);

if (!liveGateEnabled)
  console.warn(
    "SKIP gallery-render.test.ts: set FACET_LIVE_GALLERY=1 to run the live browser gate",
  );
else if (!availability.available)
  console.warn(`SKIP gallery-render.test.ts: pinned browser unavailable — ${availability.reason}`);
