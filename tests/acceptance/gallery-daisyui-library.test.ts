import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { artifactWorld, galleryBrowser, navigateToArtifact } from "../helpers/gallery-live";

test("gallery HTML renders daisyUI variants outside the documented recommendations", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-daisyui-library-"));
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-daisyui-library" }),
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
      [
        '<section class="card p-4">',
        '<div class="stats"><div class="stat"><span class="stat-title">verified</span><strong class="stat-value">42</strong></div></div>',
        '<button class="btn">plain</button><button class="btn btn-primary">primary</button>',
        '<span class="badge">queued</span><span class="badge badge-success">ready</span>',
        "</section>",
      ].join(""),
    );
    const world = await artifactWorld(target);
    const styles = (await target.session.send("Runtime.evaluate", {
      contextId: world,
      returnByValue: true,
      expression: `(() => {
          const stats = document.querySelector('.stats');
          const buttons = document.querySelectorAll('.btn');
          const badge = document.querySelector('.badge-success');
          if (stats === null || buttons.length !== 2 || badge === null) throw new Error('daisyUI fixture missing');
          return {
            statsDisplay: getComputedStyle(stats).display,
            plainButtonBackground: getComputedStyle(buttons[0]).backgroundColor,
            primaryButtonBackground: getComputedStyle(buttons[1]).backgroundColor,
            successBadgeBackground: getComputedStyle(badge).backgroundColor,
          };
        })()`,
    })) as {
      result?: {
        value?: {
          statsDisplay: string;
          plainButtonBackground: string;
          primaryButtonBackground: string;
          successBadgeBackground: string;
        };
      };
    };
    const observed = styles.result?.value;
    expect(observed).toBeDefined();
    expect(observed!.statsDisplay).not.toBe("block");
    expect(observed!.primaryButtonBackground).not.toBe(observed!.plainButtonBackground);
    expect(observed!.successBadgeBackground).not.toMatch(/^rgba?\(0, 0, 0, 0\)$/);
  } finally {
    await target?.close();
    await service.stop();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 45_000);
