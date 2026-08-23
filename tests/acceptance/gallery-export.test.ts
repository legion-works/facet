import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FacetClient, readBack } from "../../src/cli/client";
import { ExportSidecarSchema } from "../../src/shared/contracts/commands/results";
import type { Tier1Input, Tier1Result, Tier1Runner } from "../../src/shared/contracts/validation";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import {
  configureBrowserDownloads,
  galleryBrowser,
  settleTopDocument,
  waitForBrowserDownload,
} from "../helpers/gallery-live";

const browser = galleryBrowser();
const SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#68d8e8"/></svg>`;
const SCREENSHOT = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80, 0, 0, 0, 0]);
const OBSERVED = {
  rendererRootSvgCount: 1,
  graphCount: 0,
  mermaidNodeCount: 0,
  visibleSvgCount: 1,
  opaqueRegionCount: 0,
  externalImageCount: 0,
  errorCount: 0,
};

function evidenceTier1(evidencePath: string): Tier1Runner {
  return async (input: Tier1Input): Promise<Tier1Result> => {
    const runDir = join(evidencePath, "stub", input.revisionSha, crypto.randomUUID());
    mkdirSync(runDir, { recursive: true });
    const screenshotPath = join(runDir, "screenshot.webp");
    writeFileSync(screenshotPath, SCREENSHOT);
    return {
      tier: 1,
      status: "ok",
      artifactId: input.artifactType,
      revisionSha: input.revisionSha,
      expected: input.lexical,
      observed: OBSERVED,
      screenshotPath,
      screenshotFormat: "webp",
      consolePath: null,
    };
  };
}

async function click(
  target: Awaited<ReturnType<typeof browser.launch>>,
  id: string,
): Promise<void> {
  await target.session.send("Runtime.evaluate", {
    expression: `document.getElementById(${JSON.stringify(id)})?.click()`,
  });
}

describe("gallery export", () => {
  test("gallery exports source, stored render, and schema-complete sidecar downloads", async () => {
    const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-export-"));
    const downloadPath = join(envDir, "downloads");
    mkdirSync(downloadPath, { recursive: true });
    const service = await startFacetService({
      dbPath: join(envDir, "facet.sqlite"),
      installTokenPath: join(envDir, "install.token"),
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath: join(envDir, "facet.lock"),
      evidencePath: join(envDir, "evidence"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-export" }),
      tier0Runner: async (input) => ({
        tier: 0,
        status: "ok",
        artifactId: "",
        revisionSha: input.revisionSha,
        expected: input.lexical,
        observed: OBSERVED,
      }),
      tier1Runner: evidenceTier1(join(envDir, "evidence")),
    });
    let target: Awaited<ReturnType<typeof browser.launch>> | undefined;
    try {
      const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
      const created = await client.sendCommand({
        command: "create",
        requestId: crypto.randomUUID(),
        projectId: "/facet",
        slug: "gallery-export",
        title: "Gallery export",
      });
      if (!created.ok || created.data.command !== "create") throw new Error("create failed");
      const artifactId = created.data.artifact.id;
      const published = await client.sendCommand({
        command: "publish",
        requestId: crypto.randomUUID(),
        artifactId,
        artifactType: "svg",
        renderer: "svg",
        bytes: btoa(SOURCE),
      });
      if (!published.ok || published.data.command !== "publish") throw new Error("publish failed");
      const revisionSha = published.data.revision.sha256;
      const verdict = await readBack(client, { artifactId, revisionSha, tier: 1 });
      expect(verdict.verdict.status).toBe("ok");
      const opened = await client.sendCommand({
        command: "open",
        requestId: crypto.randomUUID(),
        artifactId,
        revisionSha,
      });
      if (!opened.ok || opened.data.command !== "open") throw new Error("open failed");

      target = await browser.launch();
      await configureBrowserDownloads(target, downloadPath);
      const navigation = await target.session.send<{ errorText?: string }>("Page.navigate", {
        url: opened.data.frameUrl,
      });
      if (navigation.errorText !== undefined)
        throw new Error(`gallery navigation failed: ${navigation.errorText}`);
      const settled = await settleTopDocument(target, revisionSha);
      expect(settled.status).toBe("displayed");
      await click(target, "facet-export-toggle");

      const sourceDownload = await waitForBrowserDownload(target, downloadPath, () =>
        click(target!, "facet-export-source"),
      );
      expect(sourceDownload.suggestedFilename).toBe("gallery-export.svg");
      expect(Array.from(new Uint8Array(readFileSync(sourceDownload.path)))).toEqual(
        Array.from(new TextEncoder().encode(SOURCE)),
      );

      const renderDownload = await waitForBrowserDownload(target, downloadPath, () =>
        click(target!, "facet-export-render"),
      );
      expect(renderDownload.suggestedFilename).toBe("gallery-export.webp");
      expect(Array.from(new Uint8Array(readFileSync(renderDownload.path)))).toEqual(
        Array.from(SCREENSHOT),
      );

      const sidecarDownload = await waitForBrowserDownload(target, downloadPath, () =>
        click(target!, "facet-export-sidecar"),
      );
      expect(sidecarDownload.suggestedFilename).toBe("gallery-export.svg.facet.json");
      const sidecar = ExportSidecarSchema.parse(
        JSON.parse(readFileSync(sidecarDownload.path, "utf8")),
      );
      expect(Object.keys(sidecar).toSorted()).toEqual(
        [
          "artifactId",
          "slug",
          "revisionSha",
          "artifactType",
          "renderer",
          "verdict",
          "format",
          "exportedAt",
        ].toSorted(),
      );
      expect(sidecar.artifactId).toBe(artifactId);
      expect(sidecar.slug).toBe("gallery-export");
      expect(sidecar.revisionSha).toBe(revisionSha);
      expect(sidecar.verdict.status).toBe("ok");
    } finally {
      await target?.close();
      await service.stop();
      rmSync(envDir, { recursive: true, force: true });
    }
  }, 90_000);
});
