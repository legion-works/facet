import { expect, test } from "bun:test";
import sharp from "sharp";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { galleryBrowser, navigateToArtifact } from "../helpers/gallery-live";

test("gallery toolbar labels paint in light and dark themes", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-toolbar-"));
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-toolbar" }),
    tier0Runner: stubTier0Runner,
  });
  const browser = galleryBrowser();
  let target: Awaited<ReturnType<typeof browser.launch>> | undefined;
  try {
    const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
    target = await browser.launch();
    await target.session.send("Page.enable");
    for (const theme of ["light", "dark"] as const) {
      await navigateToArtifact(
        target,
        client,
        "html",
        "<main>Toolbar regression fixture</main>",
        undefined,
        {
          slug: `gallery-light-toolbar-${theme}`,
        },
      );
      const selectedTheme = (await target.session.send("Runtime.evaluate", {
        returnByValue: true,
        awaitPromise: true,
        expression: `new Promise((resolve, reject) => {
          const toggle = document.getElementById('facet-theme-toggle');
          if (toggle === null) return reject(new Error('theme toggle missing'));
          for (let index = 0; index < ${theme === "dark" ? 1 : 2}; index += 1) toggle.click();
          const deadline = Date.now() + 7000;
          const inspect = () => {
            if (document.documentElement.dataset.theme === ${JSON.stringify(theme)}) return resolve(document.documentElement.dataset.theme);
            if (Date.now() >= deadline) return reject(new Error('theme toggle did not settle'));
            setTimeout(inspect, 25);
          };
          inspect();
        })`,
      })) as { result?: { value?: string } };
      expect(selectedTheme.result?.value).toBe(theme);
      // The buttons animate `color` for 120ms after a theme switch; read styles and capture only after it settles.
      await target.session.send("Runtime.evaluate", {
        awaitPromise: true,
        expression:
          "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300))))",
      });
      const observed = (await target.session.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
            const buttons = Array.from(document.querySelectorAll('#facet-controls button'));
            return buttons.flatMap((button) => {
              const rect = button.getBoundingClientRect();
              const style = getComputedStyle(button);
              if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || button.offsetParent === null) return [];
              const color = style.color.match(/\\d+/g).slice(0, 3).map(Number);
              const background = style.backgroundColor.match(/\\d+/g).slice(0, 3).map(Number);
              return [{ label: button.textContent.trim(), x: rect.x, y: rect.y, width: rect.width, height: rect.height, color, background }];
            });
        })()`,
      })) as {
        result?: {
          value?: {
            label: string;
            x: number;
            y: number;
            width: number;
            height: number;
            color: number[];
            background: number[];
          }[];
        };
      };
      const boxes = observed.result?.value;
      if (!boxes)
        throw new Error(
          `toolbar evaluation returned no value: ${JSON.stringify(observed).slice(0, 2000)}`,
        );
      const labels = boxes.map((box) => box.label);
      expect(labels).toHaveLength(7);
      expect(labels).toContain("pan/zoom");
      expect(labels).toContain("−");
      expect(labels).toContain("100%");
      expect(labels).toContain("+");
      expect(labels.some((label) => label.startsWith("theme:"))).toBe(true);
      expect(labels).toContain("export");
      expect(labels).toContain("fullscreen");
      const viewport = (await target.session.send("Runtime.evaluate", {
        returnByValue: true,
        expression: "({ width: innerWidth, height: innerHeight })",
      })) as { result?: { value?: { width: number; height: number } } };
      const dimensions = viewport.result?.value;
      if (!dimensions) throw new Error("toolbar viewport dimensions unavailable");
      const captured = (await target.session.send("Page.captureScreenshot", { format: "png" })) as {
        data?: string;
      };
      const { data, info } = await sharp(Buffer.from(captured.data!, "base64"))
        .raw()
        .toBuffer({ resolveWithObject: true });
      const scaleX = info.width / dimensions.width;
      const scaleY = info.height / dimensions.height;
      for (const box of boxes) {
        // Antialiased 11.5px glyphs rarely reach the exact text colour, and the `−` label is a
        // one-pixel dash, so a pixel counts as label ink when it sits 30% of the way from the
        // button background toward the text colour. The threshold stays below 0.4 because a
        // disabled button renders its label at `opacity: 0.4`. An unpainted label leaves a uniform
        // box with zero ink. The 6px inset (the corner radius) keeps the border and the toolbar
        // behind the rounded corners out of the sample.
        const axis = [0, 1, 2].map((channel) => box.color[channel]! - box.background[channel]!);
        const axisLengthSquared = axis.reduce((sum, component) => sum + component * component, 0);
        const left = Math.max(0, Math.floor((box.x + 6) * scaleX));
        const top = Math.max(0, Math.floor((box.y + 6) * scaleY));
        const right = Math.min(info.width, Math.ceil((box.x + box.width - 6) * scaleX));
        const bottom = Math.min(info.height, Math.ceil((box.y + box.height - 6) * scaleY));
        let inkPixels = 0;
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            const offset = (y * info.width + x) * info.channels;
            let projection = 0;
            for (const channel of [0, 1, 2]) {
              projection += (data[offset + channel]! - box.background[channel]!) * axis[channel]!;
            }
            if (projection / axisLengthSquared >= 0.3) inkPixels += 1;
          }
        }
        expect(
          inkPixels,
          `${theme} toolbar button "${box.label}" ${JSON.stringify(box)} capture=${info.width}x${info.height} viewport=${JSON.stringify(dimensions)}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  } finally {
    await target?.close();
    await service.stop();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 45_000);
