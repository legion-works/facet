import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FacetClient, publishArtifact } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";

const browser = new PuppeteerTier1Browser();
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
  "real gallery route mounts an opaque frame and renders an SVG artifact",
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
        artifactType: "mermaid",
        bytes: new TextEncoder().encode("graph TD\n  A-->B").buffer as ArrayBuffer,
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
      await target.session.send("Page.navigate", { url: opened.data.frameUrl });
      const evaluation = await target.session.send<{
        result?: { value?: { iframeCount: number; svgCount: number; status: string } };
      }>("Runtime.evaluate", {
        awaitPromise: true,
        expression: `new Promise((resolve) => {
          const deadline = Date.now() + 15000;
          const inspect = () => {
            const iframe = document.querySelector('iframe');
            const status = document.querySelector('#facet-status-line')?.textContent ?? '';
            const svgCount = iframe?.contentDocument?.querySelectorAll('svg').length ?? 0;
            if (svgCount > 0 || status === 'error' || Date.now() >= deadline) {
              resolve({ iframeCount: document.querySelectorAll('iframe').length, svgCount, status });
              return;
            }
            setTimeout(inspect, 100);
          };
          inspect();
        })`,
      });
      const result = evaluation.result?.value;
      expect(result?.iframeCount).toBe(1);
      expect(result?.svgCount).toBeGreaterThan(0);
      expect(result?.status).not.toBe("loading");
      expect(result?.status).not.toBe("error");
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
