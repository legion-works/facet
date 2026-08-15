import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { createTier0RunnerForTests } from "../../src/validation/tier0/runner";
import { artifactWorld, galleryBrowser, navigateToArtifact } from "../helpers/gallery-live";

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
  } finally {
    await target?.close();
    await service.stop();
    tier0Runner.close?.();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 90_000);
