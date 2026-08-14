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
  "gallery fits a wide Mermaid diagram to the viewport from the top-left origin",
  async () => {
    const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-mermaid-fit-"));
    const service = await startFacetService({
      dbPath: join(envDir, "facet.sqlite"),
      installTokenPath: join(envDir, "install.token"),
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath: join(envDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-mermaid-fit" }),
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
        "mermaid",
        readFileSync(join(import.meta.dir, "../../templates/service-topology.mmd"), "utf8"),
      );
      const world = await artifactWorld(target);
      const geometry = (await target.session.send("Runtime.evaluate", {
        contextId: world,
        returnByValue: true,
        expression: `(() => {
          const viewport = document.getElementById('artifact');
          const svg = viewport?.querySelector(':scope > svg');
          if (viewport === null || !(svg instanceof SVGSVGElement)) throw new Error('Mermaid SVG missing');
          const viewportRect = viewport.getBoundingClientRect();
          const svgRect = svg.getBoundingClientRect();
          const style = getComputedStyle(viewport);
          const viewBox = svg.viewBox.baseVal;
          const content = svg.getBBox();
          return {
            paddingTop: Number.parseFloat(style.paddingTop),
            paddingLeft: Number.parseFloat(style.paddingLeft),
            viewportTop: viewportRect.top,
            viewportLeft: viewportRect.left,
            viewportWidth: viewport.clientWidth,
            viewportScrollWidth: viewport.scrollWidth,
            svgTop: svgRect.top,
            svgLeft: svgRect.left,
            svgWidth: svgRect.width,
            viewBoxLeft: viewBox.x,
            viewBoxRight: viewBox.x + viewBox.width,
            contentLeft: content.x,
            contentRight: content.x + content.width,
          };
        })()`,
      })) as {
        result?: {
          value?: {
            paddingTop: number;
            paddingLeft: number;
            viewportTop: number;
            viewportLeft: number;
            viewportWidth: number;
            viewportScrollWidth: number;
            svgTop: number;
            svgLeft: number;
            svgWidth: number;
            viewBoxLeft: number;
            viewBoxRight: number;
            contentLeft: number;
            contentRight: number;
          };
        };
      };
      const observed = geometry.result?.value;
      expect(observed).toBeDefined();
      expect(observed!.svgTop).toBeLessThanOrEqual(
        observed!.viewportTop + observed!.paddingTop + 2,
      );
      expect(observed!.svgLeft).toBeLessThanOrEqual(
        observed!.viewportLeft + observed!.paddingLeft + 2,
      );
      expect(observed!.svgWidth).toBeLessThanOrEqual(
        observed!.viewportWidth - observed!.paddingLeft * 2 + 2,
      );
      expect(observed!.viewportScrollWidth).toBeLessThanOrEqual(observed!.viewportWidth + 1);
      expect(observed!.contentLeft).toBeGreaterThanOrEqual(observed!.viewBoxLeft - 1);
      expect(observed!.contentRight).toBeLessThanOrEqual(observed!.viewBoxRight + 1);
    } finally {
      await target?.close();
      await service.stop();
      rmSync(envDir, { recursive: true, force: true });
    }
  },
  45_000,
);
