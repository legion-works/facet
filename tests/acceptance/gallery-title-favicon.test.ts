import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FacetClient } from "../../src/cli/client";
import type { Tier0Input, Tier0Result, Tier0Runner } from "../../src/shared/contracts/validation";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { galleryBrowser, settleTopDocument } from "../helpers/gallery-live";

const browser = galleryBrowser();

function changingTier0Runner(): Tier0Runner {
  let calls = 0;
  return async (input: Tier0Input): Promise<Tier0Result> => {
    calls += 1;
    return {
      tier: 0,
      status: calls === 1 ? "ok" : "timeout",
      artifactId: "",
      revisionSha: input.revisionSha,
      expected: input.lexical,
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        externalImageCount: input.lexical.externalImageCount,
        errorCount: 0,
      },
    };
  };
}

async function publishRevision(client: FacetClient, artifactId: string, source: string) {
  const response = await client.sendCommand({
    command: "publish",
    requestId: crypto.randomUUID(),
    artifactId,
    artifactType: "markdown",
    renderer: "svg",
    bytes: btoa(source),
  });
  if (!response.ok || response.data.command !== "publish") throw new Error("publish failed");
  return response.data.revision.sha256;
}

test("gallery swaps title and favicon live when a revision arrives over SSE", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-title-favicon-"));
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-title-favicon" }),
    tier0Runner: changingTier0Runner(),
  });
  let target: Awaited<ReturnType<typeof browser.launch>> | undefined;
  try {
    const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
    const created = await client.sendCommand({
      command: "create",
      requestId: crypto.randomUUID(),
      projectId: "/facet",
      slug: "gallery-title-favicon",
      title: "Operations ledger",
    });
    if (!created.ok || created.data.command !== "create") throw new Error("create failed");
    const artifactId = created.data.artifact.id;
    const firstSha = await publishRevision(client, artifactId, "# first\n\nThe initial revision.");
    const opened = await client.sendCommand({
      command: "open",
      requestId: crypto.randomUUID(),
      artifactId,
      revisionSha: firstSha,
    });
    if (!opened.ok || opened.data.command !== "open") throw new Error("open failed");

    target = await browser.launch();
    const navigation = await target.session.send<{ errorText?: string }>("Page.navigate", {
      url: opened.data.frameUrl,
    });
    if (navigation.errorText !== undefined)
      throw new Error(`gallery navigation failed: ${navigation.errorText}`);
    const first = await settleTopDocument(target, firstSha);
    expect(first.status).toBe("displayed");
    expect(first.title).toBe("Operations ledger · facet");
    expect(first.artifactTitle).toBe("Operations ledger");
    expect(first.faviconHref.startsWith("data:image/png")).toBe(true);

    const secondSha = await publishRevision(client, artifactId, "# second\n\nThe live revision.");
    const second = await settleTopDocument(target, secondSha);
    expect(second.status).toBe("displayed");
    expect(second.revision).toContain(secondSha.slice(0, 12));
    expect(second.title).toBe("Operations ledger · facet");
    expect(second.artifactTitle).toBe("Operations ledger");
    expect(second.faviconHref.startsWith("data:image/png")).toBe(true);
    expect(second.faviconHref).not.toBe(first.faviconHref);
  } finally {
    await target?.close();
    await service.stop();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 60_000);
