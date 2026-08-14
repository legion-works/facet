import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { artifactWorld, galleryBrowser, navigateToArtifact } from "../helpers/gallery-live";

const liveGateEnabled = process.env.FACET_LIVE_GALLERY === "1";

test.skipIf(!liveGateEnabled)(
  "gallery reaches the final fleet-dashboard table row after scrolling to the bottom",
  async () => {
    const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-html-scroll-"));
    const service = await startFacetService({
      dbPath: join(envDir, "facet.sqlite"),
      installTokenPath: join(envDir, "install.token"),
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath: join(envDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-html-scroll" }),
      tier0Runner: stubTier0Runner,
    });
    const browser = galleryBrowser();
    let target: Awaited<ReturnType<typeof browser.launch>> | undefined;
    try {
      const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
      target = await browser.launch();
      await navigateToArtifact(
        target,
        client,
        "html",
        readFileSync(join(import.meta.dir, "../../templates/fleet-dashboard.html"), "utf8"),
      );
      const world = await artifactWorld(target);
      const reachability = (await target.session.send("Runtime.evaluate", {
        contextId: world,
        returnByValue: true,
        expression: `(() => {
          const viewport = document.getElementById('artifact');
          const finalRow = viewport?.querySelector('tbody tr:last-child');
          if (viewport === null || finalRow === null) throw new Error('fleet dashboard table missing');
          viewport.scrollTop = viewport.scrollHeight;
          const viewportRect = viewport.getBoundingClientRect();
          const finalRowRect = finalRow.getBoundingClientRect();
          return {
            clientHeight: viewport.clientHeight,
            scrollHeight: viewport.scrollHeight,
            scrollTop: viewport.scrollTop,
            maxScrollTop: viewport.scrollHeight - viewport.clientHeight,
            viewportTop: viewportRect.top,
            viewportBottom: viewportRect.bottom,
            finalRowTop: finalRowRect.top,
            finalRowBottom: finalRowRect.bottom,
          };
        })()`,
      })) as {
        result?: {
          value?: {
            clientHeight: number;
            scrollHeight: number;
            scrollTop: number;
            maxScrollTop: number;
            viewportTop: number;
            viewportBottom: number;
            finalRowTop: number;
            finalRowBottom: number;
          };
        };
      };
      const observed = reachability.result?.value;
      expect(observed).toBeDefined();
      expect(observed!.scrollHeight).toBeGreaterThan(observed!.clientHeight);
      expect(observed!.scrollTop).toBeGreaterThanOrEqual(observed!.maxScrollTop - 1);
      expect(observed!.finalRowTop).toBeGreaterThanOrEqual(observed!.viewportTop);
      expect(observed!.finalRowBottom).toBeLessThanOrEqual(observed!.viewportBottom);
    } finally {
      await target?.close();
      await service.stop();
      rmSync(envDir, { recursive: true, force: true });
    }
  },
  45_000,
);
