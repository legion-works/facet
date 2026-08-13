import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient, publishArtifact } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { createTier0RunnerForTests } from "../../src/validation/tier0/runner";
import { galleryBrowser, nestedArtifactWorld, type GalleryTarget } from "../helpers/gallery-live";

const INTERACTIVE_TEMPLATE = readFileSync(
  join(import.meta.dir, "../../templates/tsx-interactive-counter.tsx"),
  "utf8",
);
const STATUS_TEMPLATE = readFileSync(
  join(import.meta.dir, "../../templates/tsx-status-report.tsx"),
  "utf8",
);

const liveGateEnabled = process.env.FACET_LIVE_GALLERY === "1";

async function publishAndOpen(
  client: FacetClient,
  target: GalleryTarget,
  artifactType: "tsx",
  bytes: string,
  execution: "static" | "interactive",
  slug: string,
): Promise<void> {
  const published = await publishArtifact(client, {
    artifactType,
    bytes: new TextEncoder().encode(bytes).buffer as ArrayBuffer,
    slug,
    execution,
  });
  const opened = await client.sendCommand({
    command: "open",
    requestId: crypto.randomUUID(),
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
  });
  if (!opened.ok || opened.data.command !== "open") throw new Error("gallery open command failed");
  await target.session.send("Page.enable");
  const nav = (await target.session.send("Page.navigate", {
    url: opened.data.frameUrl,
  })) as { errorText?: string };
  if (nav.errorText !== undefined && nav.errorText.length > 0) {
    throw new Error(`gallery navigation failed: ${nav.errorText}`);
  }
  // The shell completes the bootstrap exchange + first render in <=1s on
  // bare hardware; the gallery-live helper uses a 7s Page.frameNavigated
  // barrier, but we only need to know the gallery reached `displayed`
  // before probing styles. Poll via Runtime.evaluate with the same
  // 7s deadline used by the gallery acceptance harness.
  await target.session.send("Runtime.evaluate", {
    returnByValue: true,
    awaitPromise: true,
    expression: `new Promise((resolve) => {
      const deadline = Date.now() + 7000;
      const wait = () => {
        const status = document.querySelector('#facet-status-line')?.textContent ?? '';
        const frameSrc = document.querySelector('iframe')?.getAttribute('src') ?? '';
        if (status === 'displayed' && frameSrc.includes('type=${artifactType}')) {
          resolve({ status, iframeCount: document.querySelectorAll('iframe').length });
          return;
        }
        if (status === 'error' || Date.now() >= deadline) {
          resolve({ status, iframeCount: document.querySelectorAll('iframe').length });
          return;
        }
        setTimeout(wait, 25);
      };
      wait();
    })`,
  });
}

test.skipIf(!liveGateEnabled)(
  "TSX starters reach the vendored HTML style vocabulary",
  async () => {
    const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-tsx-styles-template-"));
    const tier0Runner = createTier0RunnerForTests(0, {});
    const service = await startFacetService({
      dbPath: join(envDir, "facet.sqlite"),
      installTokenPath: join(envDir, "install.token"),
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath: join(envDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-tsx-styles-template" }),
      tier0Runner,
    });
    const browser = galleryBrowser();
    let target: Awaited<ReturnType<typeof browser.launch>> | undefined;
    try {
      const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });

      target = await browser.launch();
      await publishAndOpen(
        client,
        target,
        "tsx",
        INTERACTIVE_TEMPLATE,
        "interactive",
        `gallery-tsx-styles-template-interactive-${Date.now()}`,
      );
      const interactiveWorld = await nestedArtifactWorld(target);
      const interactiveProbe = (await target.session.send("Runtime.evaluate", {
        contextId: interactiveWorld,
        returnByValue: true,
        expression: `(() => {
          const button = document.querySelector('button');
          const heading = document.querySelector('h1');
          if (button === null || heading === null) {
            throw new Error('interactive TSX starter structure missing');
          }
          return {
            buttonBackground: getComputedStyle(button).backgroundColor,
            buttonBorderRadius: getComputedStyle(button).borderRadius,
            buttonPaddingLeft: getComputedStyle(button).paddingLeft,
            headingColor: getComputedStyle(heading).color,
          };
        })()`,
      })) as {
        result?: {
          value?: {
            buttonBackground: string;
            buttonBorderRadius: string;
            buttonPaddingLeft: string;
            headingColor: string;
          };
        };
      };
      const interactive = interactiveProbe.result?.value;
      expect(interactive).toBeDefined();
      // Without the vocabulary pass, the button is a UA-default <button>
      // — transparent, square corners, and the 6px UA default padding.
      // A restart against the vendored daisyUI/Tailwind vocabulary
      // shows non-transparent background, non-zero border-radius, and
      // padding-left that exceeds the UA default.
      expect(interactive?.buttonBackground).not.toMatch(/^rgba?\(0, 0, 0, 0\)$/);
      expect(interactive?.buttonBorderRadius).not.toBe("0px");
      expect(interactive?.buttonPaddingLeft).not.toBe("6px");

      await publishAndOpen(
        client,
        target,
        "tsx",
        STATUS_TEMPLATE,
        "static",
        `gallery-tsx-styles-template-static-${Date.now()}`,
      );
      const staticWorld = await nestedArtifactWorld(target);
      const staticProbe = (await target.session.send("Runtime.evaluate", {
        contextId: staticWorld,
        returnByValue: true,
        expression: `(() => {
          const heading = document.querySelector('h1');
          if (heading === null) throw new Error('static TSX starter structure missing');
          return {
            headingFontWeight: getComputedStyle(heading).fontWeight,
            headingColor: getComputedStyle(heading).color,
          };
        })()`,
      })) as { result?: { value?: { headingFontWeight: string; headingColor: string } } };
      const staticValue = staticProbe.result?.value;
      expect(staticValue).toBeDefined();
      // UA default <h1> is 400 weight and black. The vocabulary-backed
      // template renders with a styled font-weight + Legion color.
      expect(Number.parseInt(staticValue?.headingFontWeight ?? "0", 10)).toBeGreaterThanOrEqual(
        500,
      );
      expect(staticValue?.headingColor).not.toBe("rgb(0, 0, 0)");
    } finally {
      await target?.close();
      await service.stop();
      tier0Runner.close?.();
      rmSync(envDir, { recursive: true, force: true });
    }
  },
  90_000,
);

if (!liveGateEnabled) {
  console.warn(
    "SKIP gallery-tsx-styles-templates.test.ts: set FACET_LIVE_GALLERY=1 to run the live browser gate",
  );
}
