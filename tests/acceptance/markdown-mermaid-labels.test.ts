import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import {
  createIsolatedWorld,
  resolveSrcdocChildFrame,
} from "../../src/validation/tier1/frame-target";
import { buildHostPage } from "../../src/validation/tier1/harness";
import { resolveLauncher } from "../../src/validation/tier1/launcher";

const source = new TextEncoder().encode(
  ["# Status", "", "```mermaid", "flowchart TD", "  Start[Start] --> Done[Done]", "```"].join("\n"),
);

test("Markdown Mermaid keeps every label inside its rendered SVG", async () => {
  const directory = await mkdtemp(join(tmpdir(), "facet-markdown-mermaid-labels-"));
  const launcher = resolveLauncher();
  const browser = new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
  let target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>> | undefined;
  try {
    const { html } = await buildHostPage(source, "render", directory, "markdown");
    const hostPath = join(directory, "host.html");
    await writeFile(hostPath, html, "utf8");
    target = await browser.launch();
    await target.session.send("Runtime.enable");
    await target.session.send("Page.enable");
    await target.session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const original = DOMParser.prototype.parseFromString;
        DOMParser.prototype.parseFromString = function(input, type) {
          if (type === "image/svg+xml") {
            document.documentElement.setAttribute("data-facet-raw-mermaid-svg", btoa(input));
          }
          return original.call(this, input, type);
        };
      })()`,
    });
    await target.session.send("Page.navigate", { url: `file://${hostPath}` });
    await target.session.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const wait = () => {
          const events = window.__facetShimEvents || [];
          if (events.some((event) => event?.type === "boot-ready")) { resolve(undefined); return; }
          if (Date.now() >= deadline) { reject(new Error("boot-ready timeout")); return; }
          setTimeout(wait, 10);
        };
        wait();
      })`,
    });
    await target.session.send("Runtime.evaluate", {
      expression:
        "window.__facetHostArtifact.ingress.postMessage({bytes:window.__facetHostArtifact.bytes,mode:window.__facetHostArtifact.mode,artifactType:window.__facetHostArtifact.artifactType,renderer:window.__facetHostArtifact.renderer,execution:window.__facetHostArtifact.execution})",
    });
    await target.session.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const wait = () => {
          const events = window.__facetShimEvents || [];
          if (events.some((event) => event?.type === "render-complete")) { resolve(undefined); return; }
          if (Date.now() >= deadline) { reject(new Error("render-complete timeout")); return; }
          setTimeout(wait, 10);
        };
        wait();
      })`,
    });
    const frameViewport = (await target.session.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const frame = document.querySelector("iframe");
        return { height: frame?.clientHeight ?? 0 };
      })()`,
    })) as { result?: { value?: { height?: number } } };
    const child = await resolveSrcdocChildFrame(target.session);
    const world = await createIsolatedWorld(target.session, child.frameId);
    const result = (await target.session.send("Runtime.evaluate", {
      contextId: world.executionContextId,
      returnByValue: true,
      expression: `(() => {
        const svg = document.querySelector('[data-facet-renderer-root="true"]');
        if (svg === null) return null;
        const raw = atob(document.documentElement.getAttribute("data-facet-raw-mermaid-svg") || "");
        const root = svg.getBoundingClientRect();
        return {
          documentHeight: document.documentElement.scrollHeight,
          rawContainsText: raw.includes("<text"),
          labels: Array.from(svg.querySelectorAll("text"))
            .filter((node) => (node.textContent || "").trim().length > 0)
            .map((node) => {
              const rect = node.getBoundingClientRect();
              return { label: node.textContent, top: rect.top - root.top, bottom: rect.bottom - root.top, rootHeight: root.height };
            }),
        };
      })()`,
    })) as { result?: { value?: unknown } };
    const observed = result.result?.value as
      | {
          readonly documentHeight: number;
          readonly rawContainsText: boolean;
          readonly labels: readonly {
            readonly label: string;
            readonly top: number;
            readonly bottom: number;
            readonly rootHeight: number;
          }[];
        }
      | undefined;
    const labels = observed?.labels;

    expect(frameViewport.result?.value?.height).toBeGreaterThanOrEqual(
      observed?.documentHeight ?? Infinity,
    );
    expect(observed?.rawContainsText).toBe(true);
    expect(labels).toEqual([
      expect.objectContaining({
        label: "Start",
        top: expect.any(Number),
        bottom: expect.any(Number),
      }),
      expect.objectContaining({
        label: "Done",
        top: expect.any(Number),
        bottom: expect.any(Number),
      }),
    ]);
    for (const label of labels ?? []) {
      expect(label.top).toBeGreaterThanOrEqual(0);
      expect(label.bottom).toBeLessThanOrEqual(label.rootHeight);
    }
  } finally {
    await target?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
