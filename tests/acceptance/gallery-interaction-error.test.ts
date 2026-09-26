import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient, publishArtifact } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { createTier0RunnerForTests } from "../../src/validation/tier0/runner";
import { artifactWorld, galleryBrowser } from "../helpers/gallery-live";

const source = `import React from "react";
export default function Interaction() {
  return <main><button id="safe" onClick={() => { document.body.dataset.safe = "yes"; }}>Safe</button><button id="throw" onClick={() => { throw new Error("ack handler exploded"); }}>Throw</button></main>;
}`;

test("gallery signals post-render interaction errors without changing the stored verdict and resets on swaps", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-interaction-"));
  const runner = createTier0RunnerForTests(0, {});
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-interaction" }),
    tier0Runner: runner,
  });
  const browser = galleryBrowser();
  let target: Awaited<ReturnType<typeof browser.launch>> | undefined;
  try {
    const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
    const published = await publishArtifact(client, {
      artifactType: "tsx",
      execution: "interactive",
      bytes: new TextEncoder().encode(source).buffer as ArrayBuffer,
      slug: "gallery-interaction",
    });
    const opened = await client.sendCommand({
      command: "open",
      requestId: crypto.randomUUID(),
      artifactId: published.artifactId,
      revisionSha: published.revisionSha,
    });
    if (!opened.ok || opened.data.command !== "open") throw new Error("gallery open failed");
    target = await browser.launch();
    await target.session.send("Page.enable");
    await target.session.send("Page.navigate", { url: opened.data.frameUrl });
    const shell = async (expression: string): Promise<unknown> => {
      const reply = (await target!.session.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: { text: string } };
      if (reply.exceptionDetails !== undefined) throw new Error(reply.exceptionDetails.text);
      return reply.result?.value;
    };
    const settle = (predicate: string): Promise<unknown> =>
      shell(
        `new Promise((resolve, reject) => { const deadline = Date.now() + 7000; const check = () => { if (${predicate}) resolve({status: document.querySelector('#facet-status-line')?.textContent, marker: document.querySelector('#facet-verdict')?.dataset.interactionError ?? null}); else if (Date.now() > deadline) reject(new Error('gallery interaction state timed out: ' + JSON.stringify({status: document.querySelector('#facet-status-line')?.textContent, badge: document.querySelector('#facet-verdict')?.outerHTML, frameError: document.querySelector('iframe')?.contentDocument?.querySelector('[data-facet-error]')?.textContent, frameCount: document.querySelectorAll('iframe').length}))); else setTimeout(check, 25); }; check(); })`,
      );
    await settle("document.querySelector('#facet-status-line')?.textContent === 'displayed'");
    const world = await artifactWorld(target);
    await target.session.send("Runtime.evaluate", {
      contextId: world,
      expression: "document.getElementById('safe')?.click()",
    });
    expect(
      await shell("document.querySelector('#facet-verdict')?.dataset.interactionError ?? null"),
    ).toBeNull();
    await target.session.send("Runtime.evaluate", {
      contextId: world,
      expression: "document.getElementById('throw')?.click()",
    });
    const failed = await settle(
      "document.querySelector('#facet-verdict')?.dataset.interactionError === 'true'",
    );
    expect(failed).toEqual({
      status: "displayed · runtime error during interaction",
      marker: "true",
    });
    expect(
      await shell(`(() => {
        const region = document.getElementById('facet-status-line');
        return { live: region?.getAttribute('aria-live'), role: region?.getAttribute('role'), text: region?.textContent };
      })()`),
    ).toEqual({
      live: "polite",
      role: "status",
      text: "displayed · runtime error during interaction",
    });
    expect(await shell("document.querySelector('#facet-verdict')?.dataset.status")).toBe("ok");
    await shell(
      "window.__interactionFrameBefore = document.querySelector('#facet-canvas iframe'); true",
    );
    const frameSrcBefore = await shell("window.__interactionFrameBefore.getAttribute('src')");
    await shell("document.getElementById('facet-theme-toggle')?.click()");
    const themed = await settle(
      "document.querySelector('#facet-theme-toggle')?.dataset.themeMode === 'dark' && document.querySelector('#facet-canvas iframe')?.contentDocument?.documentElement.dataset.theme === 'night'",
    );
    // The interaction error remains real while the frame that threw is still displayed.
    expect(
      await shell(
        "document.querySelector('#facet-canvas iframe') === window.__interactionFrameBefore",
      ),
    ).toBe(true);
    expect(await shell("document.querySelector('#facet-canvas iframe')?.getAttribute('src')")).toBe(
      frameSrcBefore,
    );
    expect(themed).toEqual({
      status: "displayed · runtime error during interaction",
      marker: "true",
    });
    const revised = await client.sendCommand({
      command: "publish",
      requestId: crypto.randomUUID(),
      artifactId: published.artifactId,
      artifactType: "tsx",
      renderer: "svg",
      execution: "interactive",
      bytes: btoa(source.replace("ack handler exploded", "ack handler exploded again")),
    });
    expect(revised.ok).toBe(true);
    await settle(
      "document.querySelector('#facet-status-line')?.textContent === 'displayed' && document.querySelector('#facet-revision')?.textContent?.startsWith('" +
        (revised.ok && revised.data.command === "publish"
          ? revised.data.revision.sha256.slice(0, 12)
          : "missing") +
        "')",
    );
    expect(
      await shell("document.querySelector('#facet-verdict')?.dataset.interactionError ?? null"),
    ).toBeNull();
  } finally {
    await target?.close();
    await service.stop();
    runner.close?.();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 90_000);
