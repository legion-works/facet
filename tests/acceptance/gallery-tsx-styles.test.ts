import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { createTier0RunnerForTests } from "../../src/validation/tier0/runner";
import { galleryBrowser, navigateToArtifact, nestedArtifactWorld } from "../helpers/gallery-live";

const liveGateEnabled = process.env.FACET_LIVE_GALLERY === "1";

test.skipIf(!liveGateEnabled)(
  "gallery interactive TSX carries the vendored HTML style vocabulary",
  async () => {
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
          '  return <section className="alert"><span className="badge">ready</span><button className="btn">Increment</button></section>;',
          "}",
        ].join("\n"),
        "interactive",
      );
      const nestedWorld = await nestedArtifactWorld(target);
      const styles = (await target.session.send("Runtime.evaluate", {
        contextId: nestedWorld,
        returnByValue: true,
        expression: `(() => {
          const alert = document.querySelector('.alert');
          const button = document.querySelector('.btn');
          if (alert === null || button === null) throw new Error('styled TSX structure missing');
          return {
            alertBackground: getComputedStyle(alert).backgroundColor,
            buttonBorderRadius: getComputedStyle(button).borderRadius,
            buttonPaddingLeft: getComputedStyle(button).paddingLeft,
          };
        })()`,
      })) as {
        result?: {
          value?: {
            alertBackground: string;
            buttonBorderRadius: string;
            buttonPaddingLeft: string;
          };
        };
      };
      expect(styles.result?.value?.alertBackground).not.toMatch(/^rgba?\(0, 0, 0, 0\)$/);
      expect(styles.result?.value?.buttonBorderRadius).not.toBe("0px");
      expect(styles.result?.value?.buttonPaddingLeft).not.toBe("6px");
    } finally {
      await target?.close();
      await service.stop();
      tier0Runner.close?.();
      rmSync(envDir, { recursive: true, force: true });
    }
  },
  90_000,
);
