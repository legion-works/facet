import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import {
  artifactWorld,
  dispatchGalleryWheel,
  galleryBrowser,
  navigateToArtifact,
} from "../helpers/gallery-live";

// One CDP launch per acceptance file (see acceptance-browser-launch-budget.test.ts) —
// the scroll-reachability check and the wheel-gesture regression pin
// share the same browser + gallery session instead of each minting one.
test("a tall fleet-dashboard document scrolls: to the bottom programmatically, and via a plain wheel; ctrl+wheel does not zoom it", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-html-scroll-"));
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-html-scroll" }),
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
      readFileSync(join(import.meta.dir, "../../templates/fleet-dashboard.html"), "utf8"),
    );
    const world = await artifactWorld(target);

    // Reachability: the final table row is only visible after scrolling
    // to the bottom of the overflow container — proves the artifact is
    // taller than its viewport and genuinely scrollable.
    const reachability = (await target.session.send("Runtime.evaluate", {
      contextId: world,
      returnByValue: true,
      expression: `(() => {
          const viewport = document.getElementById('artifact');
          const finalRow = viewport?.querySelector('tbody tr:last-child');
          if (viewport === null || finalRow === null) throw new Error('fleet dashboard table missing');
          viewport.scrollTop = viewport.scrollHeight;
          const viewportRect = viewport.getBoundingClientRect();
          const finalRowRect = finalRow.getBoundingClientRect();
          return {
            clientHeight: viewport.clientHeight,
            scrollHeight: viewport.scrollHeight,
            scrollTop: viewport.scrollTop,
            maxScrollTop: viewport.scrollHeight - viewport.clientHeight,
            overflowY: getComputedStyle(viewport).overflowY,
            viewportTop: viewportRect.top,
            viewportBottom: viewportRect.bottom,
            finalRowTop: finalRowRect.top,
            finalRowBottom: finalRowRect.bottom,
          };
        })()`,
    })) as {
      result?: {
        value?: {
          clientHeight: number;
          scrollHeight: number;
          scrollTop: number;
          maxScrollTop: number;
          overflowY: string;
          viewportTop: number;
          viewportBottom: number;
          finalRowTop: number;
          finalRowBottom: number;
        };
      };
    };
    const observed = reachability.result?.value;
    expect(observed).toBeDefined();
    expect(observed!.scrollHeight).toBeGreaterThan(observed!.clientHeight);
    expect(observed!.overflowY).toBe("auto");
    expect(observed!.scrollTop).toBeGreaterThanOrEqual(observed!.maxScrollTop - 1);
    expect(observed!.finalRowTop).toBeGreaterThanOrEqual(observed!.viewportTop);
    expect(observed!.finalRowBottom).toBeLessThanOrEqual(observed!.viewportBottom);

    // Regression pin for the operator-reported "pan and zoom breaks
    // scrolling" defect: a document artifact (html, markdown, tsx)
    // defaults to fully native wheel behavior — no gesture listener
    // installed — so a plain wheel scrolls the document, and ctrl+wheel
    // does not resize the artifact root (no pan/zoom hijack of the
    // scroll gesture). Standalone diagram artifacts (mermaid/svg/chart)
    // are a separate default — see tests/unit/gallery-frame-runtime.test.ts.
    const readState = async (): Promise<{ scrollTop: number; transform: string }> => {
      const evaluated = (await target!.session.send("Runtime.evaluate", {
        contextId: world,
        returnByValue: true,
        expression: `(() => {
            const viewport = document.getElementById('artifact');
            const root = viewport?.firstElementChild;
            return {
              scrollTop: viewport?.scrollTop ?? 0,
              transform: root ? getComputedStyle(root).transform : 'none',
            };
          })()`,
      })) as { result?: { value?: { scrollTop: number; transform: string } } };
      const value = evaluated.result?.value;
      if (value === undefined) throw new Error("gallery wheel: artifact state read failed");
      return value;
    };

    // Reset scrollTop to zero before probing the wheel path in isolation.
    await target.session.send("Runtime.evaluate", {
      contextId: world,
      expression: `document.getElementById('artifact').scrollTop = 0`,
    });
    const before = await readState();
    expect(before.scrollTop).toBe(0);

    // Plain wheel: native scroll, no gesture listener to preventDefault it.
    await dispatchGalleryWheel(target, 800);
    const afterPlainWheel = await readState();
    expect(afterPlainWheel.scrollTop).toBeGreaterThan(before.scrollTop);
    // The scroll must not have come with an unwanted zoom side effect.
    expect(afterPlainWheel.transform).toBe(before.transform);

    // ctrl+wheel: no pan/zoom listener installed by default on a
    // document artifact, so the artifact root's transform is untouched
    // (whatever native browser page-zoom the OS/browser applies is out
    // of our control and not what this assertion is about).
    const beforeCtrl = await readState();
    await dispatchGalleryWheel(target, -400, { ctrlKey: true });
    const afterCtrlWheel = await readState();
    expect(afterCtrlWheel.transform).toBe(beforeCtrl.transform);
  } finally {
    await target?.close();
    await service.stop();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 45_000);
