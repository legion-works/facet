import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { artifactWorld, galleryBrowser, navigateToArtifact } from "../helpers/gallery-live";

/** Shared color-contrast math (WCAG relative-luminance ratio) evaluated inside the artifact's isolated world. */
const CONTRAST_HELPERS = `
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
  const contrastOf = (el) => {
    const style = getComputedStyle(el);
    const foreground = luminance(style.color);
    let node = el;
    let backgroundColor = style.backgroundColor;
    while ((backgroundColor === 'rgba(0, 0, 0, 0)' || backgroundColor === 'transparent') && node.parentElement) {
      node = node.parentElement;
      backgroundColor = getComputedStyle(node).backgroundColor;
    }
    const background = luminance(backgroundColor);
    return {
      text: el.textContent.trim(),
      backgroundColor,
      color: style.color,
      contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
    };
  };
`;

// One CDP launch per acceptance file (see acceptance-browser-launch-budget.test.ts) —
// both fixtures and both resolved themes share one browser session.
test("gallery HTML cards keep readable text in both resolved themes", async () => {
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
    for (const theme of ["dark", "light"] as const) {
      await navigateToArtifact(
        target,
        client,
        "html",
        readFileSync(join(import.meta.dir, "../../templates/html-release-ledger.html"), "utf8"),
        undefined,
        { slug: `gallery-contrast-release-ledger-${theme}` },
      );
      const shellColors = (await target.session.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          document.documentElement.dataset.theme = ${JSON.stringify(theme)};
          ${CONTRAST_HELPERS}
          const selectors = ['#facet-status .title', '#facet-status .revision', '#facet-status-line', '#facet-verdict', '#facet-live'];
          const elements = selectors.map((selector) => document.querySelector(selector));
          if (elements.some((element) => element === null)) throw new Error('gallery shell contrast fixture missing');
          return elements.map((element, index) => ({ selector: selectors[index], ...contrastOf(element) }));
        })()`,
      })) as {
        result?: {
          value?: readonly {
            selector: string;
            color: string;
            backgroundColor: string;
            contrast: number;
          }[];
        };
      };
      expect(shellColors.result?.value).toHaveLength(5);
      for (const color of shellColors.result!.value!) {
        if (color.contrast < 4.5)
          throw new Error(
            `${color.selector} ${color.color} on ${color.backgroundColor}: ${color.contrast}`,
          );
      }
      const ledgerWorld = await artifactWorld(target);
      const colors = (await target.session.send("Runtime.evaluate", {
        contextId: ledgerWorld,
        returnByValue: true,
        expression: `(() => {
          document.documentElement.dataset.theme = ${JSON.stringify(theme === "dark" ? "night" : "winter")};
           ${CONTRAST_HELPERS}
           const alert = document.querySelector('.alert');
           if (alert === null) throw new Error('release ledger alert missing');
          const style = getComputedStyle(alert);
          const foreground = luminance(style.color);
          const background = luminance(style.backgroundColor);
           return {
             backgroundColor: style.backgroundColor,
             color: style.color,
             bodyColor: getComputedStyle(document.body).color,
             dataTheme: document.documentElement.dataset.theme,
             background,
             contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
           };
         })()`,
      })) as {
        result?: {
          value?: {
            backgroundColor: string;
            color: string;
            bodyColor: string;
            dataTheme: string;
            background: number;
            contrast: number;
          };
        };
      };
      if (theme === "dark") expect(colors.result?.value?.bodyColor).toBe("rgb(200, 211, 245)");
      else {
        expect(colors.result?.value?.dataTheme).toBe("winter");
        expect(colors.result?.value?.bodyColor).toBe("rgb(23, 32, 51)");
      }
      expect(colors.result?.value?.contrast).toBeGreaterThanOrEqual(4.5);

      // Regression pin for worker allocation cards: every label + status span
      // must clear WCAG AA against its own card background.
      await navigateToArtifact(
        target,
        client,
        "html",
        readFileSync(join(import.meta.dir, "../../templates/fleet-dashboard.html"), "utf8"),
        undefined,
        { slug: `gallery-contrast-fleet-dashboard-${theme}` },
      );
      const fleetWorld = await artifactWorld(target);
      const cards = (await target.session.send("Runtime.evaluate", {
        contextId: fleetWorld,
        returnByValue: true,
        expression: `(() => {
          document.documentElement.dataset.theme = ${JSON.stringify(theme === "dark" ? "night" : "winter")};
           ${CONTRAST_HELPERS}
           const cards = Array.from(document.querySelectorAll('.bg-legion-paper, .bg-legion-ink'));
          if (cards.length === 0) throw new Error('fleet dashboard worker cards missing');
          return cards.map((card) => ({
            cardBackgroundColor: getComputedStyle(card).backgroundColor,
            spans: Array.from(card.querySelectorAll('span, strong')).map(contrastOf),
          }));
        })()`,
      })) as {
        result?: {
          value?: readonly {
            cardBackgroundColor: string;
            spans: readonly {
              text: string;
              backgroundColor: string;
              color: string;
              contrast: number;
            }[];
          }[];
        };
      };
      const observed = cards.result?.value;
      expect(observed).toBeDefined();
      expect(observed!.length).toBe(3);
      for (const card of observed!) {
        for (const span of card.spans) {
          expect(span.contrast).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  } finally {
    await target?.close();
    await service.stop();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 45_000);
