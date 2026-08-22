import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { artifactWorld, galleryBrowser, navigateToArtifact } from "../helpers/gallery-live";

/**
 * Two fences in one markdown artifact, rendered through the REAL
 * gallery service (`dist/gallery`, not the Tier 1 harness bundle).
 * The harness bundle never reproduced the defect this gates — its
 * `Bun.build` invocation is unaffected by the per-artifact-type
 * splitting the gallery build used to do. A flowchart is the
 * discriminator (its label carries no markdown-string content, just
 * plain bracket labels); a sequence diagram in the SAME document is
 * the control — it stayed correct even at the broken commit, so its
 * presence proves the assertion actually distinguishes fence content
 * rather than passing on any SVG existing at all.
 */
const markdownSource = [
  "# Status",
  "",
  ...Array.from(
    { length: 18 },
    (_, index) => `Operational context ${index + 1}: document scroll remains native.`,
  ),
  "",
  "```mermaid",
  "flowchart TD",
  "  Start[Start] --> Middle[Middle step]",
  "  Middle --> Done[Done]",
  "  Middle --> Alt[Alternate]",
  "```",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  Alice->>Bob: Hello Bob",
  "  Bob-->>Alice: Hello Alice",
  "```",
  "",
  ...Array.from(
    { length: 18 },
    (_, index) => `Release note ${index + 1}: diagrams remain locally navigable.`,
  ),
].join("\n");

interface RegionState {
  readonly scrollTop: number;
  readonly firstWidth: number;
  readonly secondWidth: number;
  readonly regionWidth: number;
  readonly regionHeight: number;
  readonly regionClientWidth: number;
  readonly regionScrollWidth: number;
  readonly regionOverflowX: string;
  readonly regionDisplay: string;
  readonly regionOutlineStyle: string;
  readonly regionOutlineColor: string;
  readonly svgDisplay: string;
  readonly svgMaxWidth: string;
  readonly tagged: boolean;
  readonly engaged: boolean[];
}

test("gallery keeps Markdown Mermaid labels intact and confines an engaged diagram's pan/zoom", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-markdown-mermaid-labels-"));
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-markdown-mermaid-labels" }),
    tier0Runner: stubTier0Runner,
  });
  const browser = galleryBrowser();
  let target: Awaited<ReturnType<typeof browser.launch>> | undefined;
  try {
    const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
    target = await browser.launch();
    // Ambient headless color-scheme is not a test input; pin the dark tokens asserted below.
    await target.session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await navigateToArtifact(target, client, "markdown", markdownSource);
    const world = await artifactWorld(target);
    const result = (await target.session.send("Runtime.evaluate", {
      contextId: world,
      returnByValue: true,
      expression: `(() => {
        const svgs = Array.from(document.querySelectorAll('[data-facet-renderer-graph="true"]'));
        return svgs.map((svg) => ({
          labels: Array.from(svg.querySelectorAll('text'))
            .map((node) => (node.textContent || '').trim())
            .filter((text) => text.length > 0),
        }));
      })()`,
    })) as { result?: { value?: readonly { readonly labels: readonly string[] }[] } };
    const diagrams = result.result?.value;
    expect(diagrams).toHaveLength(2);
    // Flowchart — the defect's discriminator.
    expect(diagrams?.[0]?.labels).toEqual(
      expect.arrayContaining(["Start", "Middle step", "Done", "Alternate"]),
    );
    // Sequence diagram — the control; stayed correct even at the broken commit.
    expect(diagrams?.[1]?.labels.length).toBeGreaterThan(0);

    const iframePoint = async (diagramIndex: 0 | 1): Promise<{ x: number; y: number }> => {
      const outer = (await target!.session.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const rect = document.querySelector('iframe')?.getBoundingClientRect();
          return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
        })()`,
      })) as { result?: { value?: { left: number; top: number } } };
      const inner = (await target!.session.send("Runtime.evaluate", {
        contextId: world,
        returnByValue: true,
        expression: `(() => {
          const svg = document.querySelectorAll('[data-facet-renderer-graph="true"]')[${diagramIndex}];
          if (!(svg instanceof SVGSVGElement)) throw new Error('Mermaid diagram missing');
          const rect = svg.getBoundingClientRect();
          return { x: rect.left + Math.min(40, rect.width / 2), y: rect.top + Math.min(40, rect.height / 2) };
        })()`,
      })) as { result?: { value?: { x: number; y: number } } };
      const frame = outer.result?.value;
      const diagram = inner.result?.value;
      if (frame === undefined || diagram === undefined)
        throw new Error("diagram point unavailable");
      return { x: frame.left + diagram.x, y: frame.top + diagram.y };
    };

    const readRegionState = async (): Promise<RegionState> => {
      const evaluated = (await target!.session.send("Runtime.evaluate", {
        contextId: world,
        returnByValue: true,
        expression: `(() => {
          const viewport = document.getElementById('artifact');
          const diagrams = Array.from(document.querySelectorAll('[data-facet-renderer-graph="true"]'));
          const first = diagrams[0];
          const second = diagrams[1];
          if (!(first instanceof SVGSVGElement) || !(second instanceof SVGSVGElement) || viewport === null) {
            throw new Error('Markdown Mermaid diagrams missing');
          }
          const region = first.closest('[data-facet-diagram-region]') ?? first.parentElement;
          if (!(region instanceof HTMLElement)) throw new Error('diagram region missing');
          const rect = region.getBoundingClientRect();
          const regionStyle = getComputedStyle(region);
          const svgStyle = getComputedStyle(first);
          return {
            scrollTop: viewport.scrollTop,
            firstWidth: first.getBoundingClientRect().width,
            secondWidth: second.getBoundingClientRect().width,
            regionWidth: rect.width,
            regionHeight: rect.height,
            regionClientWidth: region.clientWidth,
            regionScrollWidth: region.scrollWidth,
            regionOverflowX: regionStyle.overflowX,
            regionDisplay: regionStyle.display,
            regionOutlineStyle: regionStyle.outlineStyle,
            regionOutlineColor: regionStyle.outlineColor,
            svgDisplay: svgStyle.display,
            svgMaxWidth: svgStyle.maxWidth,
            tagged: region.hasAttribute('data-facet-diagram-region'),
            engaged: diagrams.map((diagram) =>
              diagram.closest('[data-facet-diagram-region]')?.hasAttribute('data-facet-diagram-engaged') ?? false,
            ),
          };
        })()`,
      })) as { result?: { value?: RegionState } };
      const value = evaluated.result?.value;
      if (value === undefined) throw new Error("diagram state unavailable");
      return value;
    };

    await target.session.send("Runtime.evaluate", {
      contextId: world,
      expression: `document.getElementById('artifact').scrollTop = 0`,
    });
    const beforeNativeWheel = await readRegionState();
    const initialPoint = await iframePoint(0);
    await target.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...initialPoint });
    await target.session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...initialPoint,
      deltaX: 0,
      deltaY: 400,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterNativeWheel = await readRegionState();
    expect(afterNativeWheel.scrollTop).toBeGreaterThan(beforeNativeWheel.scrollTop);
    expect(afterNativeWheel.firstWidth).toBeCloseTo(beforeNativeWheel.firstWidth, 1);

    await target.session.send("Runtime.evaluate", {
      contextId: world,
      expression: `document.getElementById('artifact').scrollTop = 300`,
    });
    const beforeEngagedWheel = await readRegionState();
    const engagedPoint = await iframePoint(0);
    await target.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...engagedPoint });
    await target.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...engagedPoint,
      button: "left",
      clickCount: 1,
    });
    await target.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...engagedPoint,
      button: "left",
      clickCount: 1,
    });
    await target.session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...engagedPoint,
      deltaX: 0,
      deltaY: -400,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterEngagedWheel = await readRegionState();
    expect(afterEngagedWheel.firstWidth).toBeGreaterThan(beforeEngagedWheel.firstWidth + 10);
    expect(afterEngagedWheel.scrollTop).toBeCloseTo(beforeEngagedWheel.scrollTop, 0);
    expect(afterEngagedWheel.secondWidth).toBeCloseTo(beforeEngagedWheel.secondWidth, 1);
    expect(afterEngagedWheel.regionWidth).toBeCloseTo(beforeEngagedWheel.regionWidth, 1);
    expect(afterEngagedWheel.regionHeight).toBeCloseTo(beforeEngagedWheel.regionHeight, 1);
    expect(afterEngagedWheel.regionOverflowX).toBe("hidden");
    expect(afterEngagedWheel.regionDisplay).toBe("block");
    expect(afterEngagedWheel.regionOutlineStyle).toBe("solid");
    expect(afterEngagedWheel.regionOutlineColor).toBe("rgb(130, 170, 255)");
    expect(afterEngagedWheel.svgDisplay).toBe("block");
    expect(afterEngagedWheel.svgMaxWidth).toBe("none");
    expect(afterEngagedWheel.firstWidth).toBeGreaterThan(afterEngagedWheel.regionWidth + 10);
    expect(afterEngagedWheel.regionScrollWidth).toBeGreaterThan(
      afterEngagedWheel.regionClientWidth + 10,
    );
    expect(afterEngagedWheel.tagged).toBeTrue();
    expect(afterEngagedWheel.engaged).toEqual([true, false]);

    const secondPoint = await iframePoint(1);
    await target.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...secondPoint });
    await target.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...secondPoint,
      button: "left",
      clickCount: 1,
    });
    await target.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...secondPoint,
      button: "left",
      clickCount: 1,
    });
    expect((await readRegionState()).engaged).toEqual([false, true]);

    await target.session.send("Runtime.evaluate", {
      expression: `document.getElementById('facet-zoom-reset')?.click()`,
    });
    const afterReset = await readRegionState();
    expect(afterReset.firstWidth).toBeCloseTo(beforeEngagedWheel.firstWidth, 1);
    expect(afterReset.engaged).toEqual([false, false]);

    await target.session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
    });
    const beforeDisengagedWheel = await readRegionState();
    const disengagedPoint = await iframePoint(0);
    await target.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...disengagedPoint,
    });
    await target.session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...disengagedPoint,
      deltaX: 0,
      deltaY: 400,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterDisengagedWheel = await readRegionState();
    expect(afterDisengagedWheel.scrollTop).toBeGreaterThan(beforeDisengagedWheel.scrollTop);
  } finally {
    await target?.close();
    await service.stop();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 45_000);
