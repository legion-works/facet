import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { createTier0RunnerForTests } from "../../src/validation/tier0/runner";
import {
  artifactFrame,
  artifactWorld,
  galleryBrowser,
  navigateToArtifact,
} from "../helpers/gallery-live";

test("gallery delivers interactive TSX execution and mounts component structure", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-tsx-interactive-"));
  const tier0Runner = createTier0RunnerForTests(0, {});
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-tsx-interactive" }),
    tier0Runner,
  });
  const browser = galleryBrowser();
  let target: Awaited<ReturnType<typeof browser.launch>> | undefined;
  try {
    const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
    target = await browser.launch();
    await navigateToArtifact(
      target,
      client,
      "tsx",
      readFileSync(join(import.meta.dir, "../../templates/tsx-interactive-counter.tsx"), "utf8"),
      "interactive",
    );
    const artifactFrameWorld = await artifactWorld(target);
    const rendered = (await target.session.send("Runtime.evaluate", {
      contextId: artifactFrameWorld,
      returnByValue: true,
      expression: `({ heading: document.querySelector('h1')?.textContent ?? '', button: document.querySelector('button')?.textContent ?? '' })`,
    })) as { result?: { value?: { heading: string; button: string } } };
    expect(rendered.result?.value).toEqual({
      heading: "Interactive counter",
      button: "Increment",
    });

    // The original operator complaint: gesture handling must never eat
    // an artifact's own click events. TSX documents default to native
    // gesture mode (no listener at all), so the toggle stays unlatched
    // and a click on the component's own button reaches React.
    const toggleState = (await target.session.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `document.getElementById('facet-panzoom-toggle')?.getAttribute('aria-pressed')`,
    })) as { result?: { value?: string } };
    expect(toggleState.result?.value).toBe("false");

    const before = (await target.session.send("Runtime.evaluate", {
      contextId: artifactFrameWorld,
      returnByValue: true,
      expression: `document.querySelector('p')?.textContent ?? ''`,
    })) as { result?: { value?: string } };
    expect(before.result?.value).toBe("Button presses: 0");

    await target.session.send("Runtime.evaluate", {
      contextId: artifactFrameWorld,
      expression: `document.querySelector('button')?.click()`,
    });
    const after = (await target.session.send("Runtime.evaluate", {
      contextId: artifactFrameWorld,
      returnByValue: true,
      expression: `document.querySelector('p')?.textContent ?? ''`,
    })) as { result?: { value?: string } };
    expect(after.result?.value).toBe("Button presses: 1");

    await target.session.send("Runtime.evaluate", {
      contextId: artifactFrameWorld,
      expression: `document.querySelector('button')?.click()`,
    });
    const counterBefore = (await target.session.send("Runtime.evaluate", {
      contextId: artifactFrameWorld,
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise(resolve => {
        const deadline = Date.now() + 3000;
        const poll = () => document.querySelector('p')?.textContent === 'Button presses: 2'
          ? resolve(document.querySelector('p')?.textContent)
          : Date.now() >= deadline ? resolve(null) : setTimeout(poll, 10);
        poll();
      })`,
    })) as { result?: { value?: string } };
    expect(counterBefore.result?.value).toBe("Button presses: 2");

    const frameBefore = await artifactFrame(target);
    const beforeTheme = (await target.session.send("Runtime.evaluate", {
      contextId: artifactFrameWorld,
      returnByValue: true,
      expression: `({ theme: document.documentElement.dataset.theme, surface: getComputedStyle(document.documentElement).getPropertyValue('--facet-frame-surface').trim() })`,
    })) as { result?: { value?: { theme: string; surface: string } } };
    await target.session.send("Runtime.evaluate", {
      expression: `window.__themeBeforeFrame = document.querySelector('iframe')`,
    });
    await target.session.send("Runtime.evaluate", {
      expression: `document.getElementById('facet-theme-toggle')?.click()`,
    });
    const counterAfter = (await target.session.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise(resolve => {
        const deadline = Date.now() + 3000;
        const poll = () => {
          const frame = document.querySelector('iframe');
          const doc = frame?.contentDocument;
          if (frame && doc && (frame !== window.__themeBeforeFrame || doc.documentElement.dataset.theme === 'night'))
            resolve({ sameFrame: frame === window.__themeBeforeFrame, count: doc.querySelector('p')?.textContent, theme: doc.documentElement.dataset.theme, surface: getComputedStyle(doc.documentElement).getPropertyValue('--facet-frame-surface').trim() });
          else if (Date.now() >= deadline) resolve({ sameFrame: frame === window.__themeBeforeFrame, count: doc?.querySelector('p')?.textContent, theme: doc?.documentElement.dataset.theme, surface: doc && getComputedStyle(doc.documentElement).getPropertyValue('--facet-frame-surface').trim() });
          else setTimeout(poll, 10);
        };
        poll();
      })`,
    })) as {
      result?: { value?: { sameFrame: boolean; count: string; theme: string; surface: string } };
    };
    expect(counterAfter.result?.value?.sameFrame).toBe(true);
    expect(await artifactFrame(target)).toEqual(frameBefore);
    expect(counterAfter.result?.value?.count).toBe("Button presses: 2");
    expect(beforeTheme.result?.value?.theme).toBe("winter");
    expect(counterAfter.result?.value?.theme).toBe("night");
    expect(counterAfter.result?.value?.surface).not.toBe(beforeTheme.result?.value?.surface);

    await navigateToArtifact(
      target,
      client,
      "html",
      "<details open><summary>Keep me open</summary><input id='note'></details>",
    );
    const htmlWorld = await artifactWorld(target);
    await target.session.send("Runtime.evaluate", {
      contextId: htmlWorld,
      expression: `document.querySelector('#note').value = 'draft remains'`,
    });
    const htmlFrameBefore = await artifactFrame(target);
    const htmlThemeBefore = (await target.session.send("Runtime.evaluate", {
      contextId: htmlWorld,
      returnByValue: true,
      expression: `document.documentElement.dataset.theme`,
    })) as { result?: { value?: string } };
    await target.session.send("Runtime.evaluate", {
      expression: `document.getElementById('facet-theme-toggle')?.click()`,
    });
    const htmlAfter = (await target.session.send("Runtime.evaluate", {
      contextId: htmlWorld,
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise(resolve => {
        const deadline = Date.now() + 3000;
        const before = ${JSON.stringify(htmlThemeBefore.result?.value)};
        const poll = () => document.documentElement.dataset.theme !== before
          ? resolve({ theme: document.documentElement.dataset.theme, value: document.querySelector('#note')?.value, open: document.querySelector('details')?.open })
          : Date.now() >= deadline ? resolve(null) : setTimeout(poll, 10);
        poll();
      })`,
    })) as { result?: { value?: { theme: string; value: string; open: boolean } } };
    expect(await artifactFrame(target)).toEqual(htmlFrameBefore);
    expect(htmlAfter.result?.value?.value).toBe("draft remains");
    expect(htmlAfter.result?.value?.open).toBe(true);
    expect(htmlAfter.result?.value?.theme).not.toBe(htmlThemeBefore.result?.value);

    await navigateToArtifact(target, client, "mermaid", "flowchart LR\nA[Start] --> B[Done]");
    const diagramWorld = await artifactWorld(target);
    const diagramBefore = await artifactFrame(target);
    const fillBefore = (await target.session.send("Runtime.evaluate", {
      contextId: diagramWorld,
      returnByValue: true,
      expression: `getComputedStyle(document.querySelector('svg .node rect')).fill`,
    })) as { result?: { value?: string } };
    await target.session.send("Runtime.evaluate", {
      expression: `window.__themeDiagramFrame = document.querySelector('iframe')`,
    });
    await target.session.send("Runtime.evaluate", {
      expression: `document.getElementById('facet-theme-toggle')?.click()`,
    });
    const diagramAfter = (await target.session.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise(resolve => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          const frame = document.querySelector('iframe');
          const rect = frame?.contentDocument?.querySelector('svg .node rect');
          if (frame && frame !== window.__themeDiagramFrame && rect)
            resolve({ replaced: true, fill: getComputedStyle(rect).fill });
          else if (Date.now() >= deadline) resolve(null);
          else setTimeout(poll, 10);
        };
        poll();
      })`,
    })) as { result?: { value?: { replaced: boolean; fill: string } } };
    expect(diagramAfter.result?.value?.replaced).toBe(true);
    expect((await artifactFrame(target)).frameId).not.toBe(diagramBefore.frameId);
    expect(diagramAfter.result?.value?.fill).not.toBe(fillBefore.result?.value);
  } finally {
    await target?.close();
    await service.stop();
    tier0Runner.close?.();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 90_000);
