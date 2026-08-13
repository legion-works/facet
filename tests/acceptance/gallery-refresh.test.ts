import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient, publishArtifact } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { galleryBrowser } from "../helpers/gallery-live";

const liveGateEnabled = process.env.FACET_LIVE_GALLERY === "1";

interface GalleryShellState {
  readonly status: string;
  readonly revision: string;
  readonly iframeCount: number;
  readonly fragment: string;
  readonly sessionStorageEmpty: boolean;
  readonly expiredVisible: boolean;
}

async function readShellState(
  session: { send: (method: string, params: Record<string, unknown>) => Promise<unknown> },
  timeoutMs: number,
): Promise<GalleryShellState> {
  const evaluation = (await session.send("Runtime.evaluate", {
    returnByValue: true,
    awaitPromise: true,
    expression: `new Promise((resolve) => {
      const deadline = Date.now() + ${timeoutMs};
      const inspect = () => {
        const status = document.querySelector('#facet-status-line')?.textContent ?? '';
        const expired = document.getElementById('facet-expired');
        const expiredVisible = expired !== null && !expired.hidden;
        const iframeCount = document.querySelectorAll('iframe').length;
        if (
          status === 'displayed' ||
          status === 'session expired' ||
          status === 'error' ||
          expiredVisible ||
          Date.now() >= deadline
        ) {
          resolve({
            status,
            revision: document.querySelector('#facet-revision')?.textContent ?? '',
            iframeCount,
            fragment: window.location.hash,
            sessionStorageEmpty: window.sessionStorage.getItem('facet:gallery-session') === null,
            expiredVisible,
          });
          return;
        }
        setTimeout(inspect, 25);
      };
      inspect();
    })`,
  })) as { result?: { value?: GalleryShellState } };
  if (evaluation.result?.value === undefined) {
    throw new Error("gallery shell never settled");
  }
  return evaluation.result.value;
}

test.skipIf(!liveGateEnabled)(
  "gallery refresh survives without re-issuing the bootstrap token",
  async () => {
    const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-refresh-"));
    const service = await startFacetService({
      dbPath: join(envDir, "facet.sqlite"),
      installTokenPath: join(envDir, "install.token"),
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath: join(envDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-refresh" }),
      tier0Runner: stubTier0Runner,
    });
    const browser = galleryBrowser();
    let target: Awaited<ReturnType<typeof browser.launch>> | undefined;
    try {
      const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
      const published = await publishArtifact(client, {
        artifactType: "markdown",
        bytes: new TextEncoder().encode(
          "# refresh survives\n\nThis artifact must still render after F5.",
        ).buffer as ArrayBuffer,
        slug: "gallery-refresh-survives",
      });
      const opened = await client.sendCommand({
        command: "open",
        requestId: crypto.randomUUID(),
        artifactId: published.artifactId,
        revisionSha: published.revisionSha,
      });
      if (!opened.ok || opened.data.command !== "open") {
        throw new Error("gallery open command failed");
      }

      target = await browser.launch();
      await target.session.send("Page.enable");
      const baseUrl = new URL(opened.data.frameUrl).origin;
      const galleryPath = new URL(opened.data.frameUrl).pathname;
      const firstNavigation = await target.session.send("Page.navigate", {
        url: opened.data.frameUrl,
      });
      if ((firstNavigation as { errorText?: string }).errorText) {
        throw new Error(
          `first navigation failed: ${(firstNavigation as { errorText?: string }).errorText}`,
        );
      }
      const before = await readShellState(target.session, 7_000);
      expect(before.status).toBe("displayed");
      expect(before.expiredVisible).toBe(false);
      expect(before.sessionStorageEmpty).toBe(false);
      expect(before.revision).toContain(published.revisionSha.slice(0, 7));
      expect(before.fragment).toBe("");

      await target.session.send("Page.navigate", {
        url: `${baseUrl}${galleryPath}`,
      });
      const after = await readShellState(target.session, 7_000);
      expect(after.status).toBe("displayed");
      expect(after.expiredVisible).toBe(false);
      expect(after.revision).toBe(before.revision);
      expect(after.iframeCount).toBe(1);
      expect(after.fragment).toBe("");

      // Mutation proof: disable the sessionStorage re-attach branch by
      // clearing the persisted session before the next refresh. The
      // shell must now report the typed expired state instead of a
      // silent empty canvas.
      const cleared = (await target.session.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          window.sessionStorage.removeItem('facet:gallery-session');
          return window.sessionStorage.getItem('facet:gallery-session') === null;
        })()`,
      })) as { result?: { value?: boolean } };
      expect(cleared.result?.value).toBe(true);
      await target.session.send("Page.navigate", {
        url: `${baseUrl}${galleryPath}`,
      });
      const expired = await readShellState(target.session, 7_000);
      expect(expired.status).toBe("session expired");
      expect(expired.expiredVisible).toBe(true);
      expect(expired.iframeCount).toBe(0);
    } finally {
      await target?.close();
      await service.stop();
      rmSync(envDir, { recursive: true, force: true });
    }
  },
  90_000,
);

if (!liveGateEnabled) {
  console.warn(
    "SKIP gallery-refresh.test.ts: set FACET_LIVE_GALLERY=1 to run the live browser gate",
  );
}
