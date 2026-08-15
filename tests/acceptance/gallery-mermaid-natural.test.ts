import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { artifactWorld, galleryBrowser, navigateToArtifact } from "../helpers/gallery-live";

test("gallery renders a wide Mermaid diagram at natural size, horizontally scrollable, vertically centered when it fits", async () => {
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
          const node = svg.querySelector('.node rect, .node polygon, .node circle, .node ellipse');
          const nodeFill = node === null ? null : getComputedStyle(node).fill;
          const label = svg.querySelector('.node .label');
          const labelText = label === null ? null : (label.textContent ?? '').trim();
          return {
            paddingTop: Number.parseFloat(style.paddingTop),
            paddingLeft: Number.parseFloat(style.paddingLeft),
            viewportTop: viewportRect.top,
            viewportLeft: viewportRect.left,
            viewportHeight: viewport.clientHeight,
            viewportWidth: viewport.clientWidth,
            viewportScrollWidth: viewport.scrollWidth,
            viewportScrollHeight: viewport.scrollHeight,
            svgTop: svgRect.top,
            svgLeft: svgRect.left,
            svgWidth: svgRect.width,
            svgHeight: svgRect.height,
            viewBoxLeft: viewBox.x,
            viewBoxRight: viewBox.x + viewBox.width,
            contentLeft: content.x,
            contentRight: content.x + content.width,
            nodeFill,
            labelText,
          };
        })()`,
    })) as {
      result?: {
        value?: {
          paddingTop: number;
          paddingLeft: number;
          viewportTop: number;
          viewportLeft: number;
          viewportHeight: number;
          viewportWidth: number;
          viewportScrollWidth: number;
          viewportScrollHeight: number;
          svgTop: number;
          svgLeft: number;
          svgWidth: number;
          svgHeight: number;
          viewBoxLeft: number;
          viewBoxRight: number;
          contentLeft: number;
          contentRight: number;
          nodeFill: string | null;
          labelText: string | null;
        };
      };
    };
    const observed = geometry.result?.value;
    expect(observed).toBeDefined();
    // Horizontal axis overflows (asserted below) so `safe center` falls
    // back to start alignment — the diagram stays pinned to the left,
    // exactly like before this UX pass.
    expect(observed!.svgLeft).toBeLessThanOrEqual(
      observed!.viewportLeft + observed!.paddingLeft + 2,
    );
    // Vertical axis fits the stage, so the new centering contract
    // applies: the diagram sits vertically centered rather than
    // pinned to the top (the top-pinned assertion this replaced was
    // the pre-centering contract).
    if (observed!.viewportScrollHeight <= observed!.viewportHeight + 2) {
      const expectedTop =
        observed!.viewportTop + (observed!.viewportHeight - observed!.svgHeight) / 2;
      expect(Math.abs(observed!.svgTop - expectedTop)).toBeLessThanOrEqual(2);
    } else {
      expect(observed!.svgTop).toBeLessThanOrEqual(
        observed!.viewportTop + observed!.paddingTop + 2,
      );
    }
    // Natural size: the SVG is pinned at its viewBox width (readable
    // labels), NOT shrunk to the viewport. A wide diagram therefore
    // overflows and the stage must expose the overflow as scrollable
    // width — the jail regression (fit-to-container squeeze) reads
    // svgWidth ≈ viewportWidth and scrollWidth ≈ clientWidth, which
    // this pair rejects.
    expect(observed!.svgWidth).toBeGreaterThanOrEqual(
      observed!.viewBoxRight - observed!.viewBoxLeft - 2,
    );
    expect(observed!.viewportScrollWidth).toBeGreaterThan(observed!.viewportWidth + 100);
    expect(observed!.contentLeft).toBeGreaterThanOrEqual(observed!.viewBoxLeft - 1);
    expect(observed!.contentRight).toBeLessThanOrEqual(observed!.viewBoxRight + 1);
    // Style-effectiveness discriminator: the frame CSP must allow mermaid's
    // injected <style> element to take effect. A blocked style-src leaves
    // the node's rendered shape at the SVG default black fill (verified live:
    // rgb(0, 0, 0) under `style-src 'self'`, the class-driven theme color under
    // the fixed policy) even though geometry and counts look correct — the
    // regression this pair exists to catch. Label text stays populated and
    // colored via mermaid's per-node inline `style="fill:...!important"`
    // attribute regardless of policy (inline attribute styles aren't gated by
    // `style-src`), so the second assertion is a content-presence guard
    // rather than an independent CSP discriminator for this fixture.
    expect(observed!.nodeFill).not.toBeNull();
    expect(observed!.nodeFill).not.toBe("rgb(0, 0, 0)");
    expect(observed!.labelText).not.toBeNull();
    expect(observed!.labelText).not.toBe("");
  } finally {
    await target?.close();
    await service.stop();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 45_000);
