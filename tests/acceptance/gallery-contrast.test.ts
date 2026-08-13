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
  "gallery HTML cards keep dark surfaces and readable text",
  async () => {
    const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-html-theme-"));
    const service = await startFacetService({
      dbPath: join(envDir, "facet.sqlite"),
      installTokenPath: join(envDir, "install.token"),
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath: join(envDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-html-theme" }),
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
        readFileSync(join(import.meta.dir, "../../templates/html-release-ledger.html"), "utf8"),
      );
      const htmlWorld = await artifactWorld(target);
      const colors = (await target.session.send("Runtime.evaluate", {
        contextId: htmlWorld,
        returnByValue: true,
        expression: `(() => {
          const parseColor = (value) => {
            const rgb = value.match(/^rgba?\\((\\d+), (\\d+), (\\d+)/);
            if (rgb) return rgb.slice(1).map(Number);
            const oklch = value.match(/^oklch\\(([\\d.]+)(%?) ([\\d.]+) ([\\d.]+)/);
            if (!oklch) throw new Error('unsupported color: ' + value);
            const l = Number(oklch[1]) / (oklch[2] === '%' ? 100 : 1);
            const c = Number(oklch[3]);
            const h = Number(oklch[4]) * Math.PI / 180;
            const a = c * Math.cos(h);
            const b = c * Math.sin(h);
            const l0 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
            const m0 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
            const s0 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
            return [
              4.0767416621 * l0 - 3.3077115913 * m0 + 0.2309699292 * s0,
              -1.2684380046 * l0 + 2.6097574011 * m0 - 0.3413193965 * s0,
              -0.0041960863 * l0 - 0.7034186147 * m0 + 1.707614701 * s0,
            ].map((channel) => Math.max(0, Math.min(1, channel)));
          };
          const luminance = (color) => {
            const channels = parseColor(color);
            if (channels.some((channel) => channel > 1)) {
              const linear = channels.map((channel) => {
                const normalized = channel / 255;
                return normalized <= 0.04045
                  ? normalized / 12.92
                  : ((normalized + 0.055) / 1.055) ** 2.4;
              });
              return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
            }
            return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
          };
          const alert = document.querySelector('.alert');
          if (alert === null) throw new Error('release ledger alert missing');
          const style = getComputedStyle(alert);
          const foreground = luminance(style.color);
          const background = luminance(style.backgroundColor);
          return {
            backgroundColor: style.backgroundColor,
            color: style.color,
            background,
            contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
          };
        })()`,
      })) as {
        result?: {
          value?: { backgroundColor: string; color: string; background: number; contrast: number };
        };
      };
      expect(colors.result?.value?.background).toBeLessThan(0.2);
      expect(colors.result?.value?.contrast).toBeGreaterThanOrEqual(4.5);
    } finally {
      await target?.close();
      await service.stop();
      rmSync(envDir, { recursive: true, force: true });
    }
  },
  45_000,
);
