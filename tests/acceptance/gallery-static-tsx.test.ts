import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { createTier0RunnerForTests } from "../../src/validation/tier0/runner";
import { artifactWorld, galleryBrowser, navigateToArtifact } from "../helpers/gallery-live";

test("gallery static TSX renders its compiled structure", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-tsx-static-"));
  const tier0Runner = createTier0RunnerForTests(0, {});
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-tsx-static" }),
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
      [
        'import React from "react";',
        "export default function StaticStatus(){ return <main><h1>Static gallery status</h1></main>; }",
      ].join("\n"),
      "static",
    );
    const staticWorld = await artifactWorld(target);
    const rendered = (await target.session.send("Runtime.evaluate", {
      contextId: staticWorld,
      returnByValue: true,
      expression: `({ rootCount: document.querySelectorAll('[data-facet-renderer-root="true"]').length, heading: document.querySelector('h1')?.textContent ?? '' })`,
    })) as { result?: { value?: { rootCount: number; heading: string } } };
    expect(rendered.result?.value).toEqual({ rootCount: 1, heading: "Static gallery status" });
  } finally {
    await target?.close();
    await service.stop();
    tier0Runner.close?.();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 90_000);
