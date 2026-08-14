import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { createTier0RunnerForTests } from "../../src/validation/tier0/runner";
import { artifactWorld, galleryBrowser, navigateToArtifact } from "../helpers/gallery-live";

test("gallery interactive TSX renders daisyUI variants outside the documented recommendations", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-tsx-styles-"));
  const tier0Runner = createTier0RunnerForTests(0, {});
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-tsx-styles" }),
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
        "export default function StyledCounter(){",
        '  return <section className="alert"><span className="badge badge-success">ready</span><button className="btn">Plain</button><button className="btn btn-primary">Increment</button></section>;',
        "}",
      ].join("\n"),
      "interactive",
    );
    const artifactFrameWorld = await artifactWorld(target);
    const styles = (await target.session.send("Runtime.evaluate", {
      contextId: artifactFrameWorld,
      returnByValue: true,
      expression: `(() => {
          const alert = document.querySelector('.alert');
          const buttons = document.querySelectorAll('.btn');
          const badge = document.querySelector('.badge-success');
          if (alert === null || buttons.length !== 2 || badge === null) throw new Error('styled TSX structure missing');
          return {
            alertBackground: getComputedStyle(alert).backgroundColor,
            plainButtonBackground: getComputedStyle(buttons[0]).backgroundColor,
            primaryButtonBackground: getComputedStyle(buttons[1]).backgroundColor,
            successBadgeBackground: getComputedStyle(badge).backgroundColor,
          };
        })()`,
    })) as {
      result?: {
        value?: {
          alertBackground: string;
          plainButtonBackground: string;
          primaryButtonBackground: string;
          successBadgeBackground: string;
        };
      };
    };
    expect(styles.result?.value?.alertBackground).not.toMatch(/^rgba?\(0, 0, 0, 0\)$/);
    expect(styles.result?.value?.primaryButtonBackground).not.toBe(
      styles.result?.value?.plainButtonBackground,
    );
    expect(styles.result?.value?.successBadgeBackground).not.toMatch(/^rgba?\(0, 0, 0, 0\)$/);
  } finally {
    await target?.close();
    await service.stop();
    tier0Runner.close?.();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 90_000);
