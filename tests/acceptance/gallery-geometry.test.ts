import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient, publishArtifact } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { createTier0RunnerForTests } from "../../src/validation/tier0/runner";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import {
  createIsolatedWorld,
  resolveNestedArtifactFrame,
} from "../../src/validation/tier1/frame-target";
import { resolveLauncher } from "../../src/validation/tier1/launcher";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";

function galleryBrowser(): PuppeteerTier1Browser {
  const launcher = resolveLauncher();
  return new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
}

const browser = galleryBrowser();
const liveGateEnabled = process.env.FACET_LIVE_GALLERY === "1";
const availability = liveGateEnabled
  ? await browser.probeAvailability()
  : { available: false, reason: "live gallery gate disabled" };

async function navigateToArtifact(
  target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>>,
  client: FacetClient,
  artifactType: "markdown" | "svg" | "tsx",
  bytes: string,
  execution?: "static" | "interactive",
): Promise<void> {
  const published = await publishArtifact(client, {
    artifactType,
    bytes: new TextEncoder().encode(bytes).buffer as ArrayBuffer,
    slug: `gallery-geometry-${artifactType}`,
    ...(execution === undefined ? {} : { execution }),
  });
  const opened = await client.sendCommand({
    command: "open",
    requestId: crypto.randomUUID(),
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
  });
  if (!opened.ok || opened.data.command !== "open") throw new Error("gallery open command failed");
  await target.session.send("Page.enable");
  const destination = new URL(opened.data.frameUrl);
  let settleNavigation: (() => void) | undefined;
  const navigationReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gallery shell navigation timed out")), 7_000);
    settleNavigation = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const onFrameNavigated = (event: unknown): void => {
    const frame = (event as { frame?: { parentId?: string; url?: string } }).frame;
    if (
      frame !== undefined &&
      frame.parentId === undefined &&
      frame.url?.startsWith(`${destination.origin}${destination.pathname}`)
    )
      settleNavigation?.();
  };
  target.session.on("Page.frameNavigated", onFrameNavigated);
  const navigation = (await target.session.send("Page.navigate", {
    url: opened.data.frameUrl,
  })) as {
    errorText?: string;
  };
  if (navigation.errorText !== undefined)
    throw new Error(`gallery navigation failed: ${navigation.errorText}`);
  try {
    await navigationReady;
  } finally {
    target.session.off("Page.frameNavigated", onFrameNavigated);
  }
  const displayed = (await target.session.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const deadline = Date.now() + 7000;
      const wait = () => {
        const status = document.querySelector('#facet-status-line')?.textContent ?? '';
        const frameSrc = document.querySelector('iframe')?.getAttribute('src') ?? '';
        if (status === 'displayed' && frameSrc.includes(${JSON.stringify(`type=${artifactType}`)})) {
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
  })) as { result?: { value?: { status: string; iframeCount: number } } };
  expect(displayed.result?.value).toEqual({ status: "displayed", iframeCount: 1 });
}

async function artifactFrame(
  target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>>,
): Promise<{ frameId: string; url: string }> {
  const tree = (await target.session.send("Page.getFrameTree")) as {
    frameTree: { childFrames?: readonly { frame: { id: string; url: string } }[] };
  };
  const frames = tree.frameTree.childFrames ?? [];
  const artifact = frames.find((child) => {
    try {
      return new URL(child.frame.url).pathname === "/gallery/frame";
    } catch {
      return false;
    }
  });
  if (artifact === undefined)
    throw new Error(
      `gallery did not expose its artifact frame to CDP: ${frames.map((child) => child.frame.url).join(", ")}`,
    );
  return { frameId: artifact.frame.id, url: artifact.frame.url };
}

async function artifactWorld(
  target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>>,
): Promise<number> {
  const artifact = await artifactFrame(target);
  return (await createIsolatedWorld(target.session, artifact.frameId)).executionContextId;
}

test.skipIf(!liveGateEnabled || !availability.available)(
  "gallery delivers interactive TSX execution and mounts component structure",
  async () => {
    const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-tsx-interactive-"));
    const tier0Runner = createTier0RunnerForTests(0, {});
    const service = await startFacetService({
      dbPath: join(envDir, "facet.sqlite"),
      installTokenPath: join(envDir, "install.token"),
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath: join(envDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-tsx-interactive" }),
      tier0Runner,
    });
    let target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>> | undefined;
    try {
      const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
      target = await browser.launch();
      await navigateToArtifact(
        target,
        client,
        "tsx",
        readFileSync(join(import.meta.dir, "../../templates/tsx-interactive-counter.tsx"), "utf8"),
        "interactive",
      );
      const outer = await artifactFrame(target);
      const nested = await resolveNestedArtifactFrame(target.session, outer);
      const nestedWorld = await createIsolatedWorld(target.session, nested.frameId);
      const rendered = (await target.session.send("Runtime.evaluate", {
        contextId: nestedWorld.executionContextId,
        returnByValue: true,
        expression: `({ heading: document.querySelector('h1')?.textContent ?? '', button: document.querySelector('button')?.textContent ?? '' })`,
      })) as { result?: { value?: { heading: string; button: string } } };
      expect(rendered.result?.value).toEqual({
        heading: "Interactive counter",
        button: "Increment",
      });
    } finally {
      await target?.close();
      await service.stop();
      tier0Runner.close?.();
      rmSync(envDir, { recursive: true, force: true });
    }
  },
  90_000,
);

test.skipIf(!liveGateEnabled || !availability.available)(
  "gallery frame geometry stacks markdown blocks vertically",
  async () => {
    const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-geometry-"));
    const service = await startFacetService({
      dbPath: join(envDir, "facet.sqlite"),
      installTokenPath: join(envDir, "install.token"),
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath: join(envDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-geometry" }),
      tier0Runner: stubTier0Runner,
    });
    let target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>> | undefined;
    try {
      const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
      target = await browser.launch();
      await navigateToArtifact(
        target,
        client,
        "markdown",
        "# Q3 ingest pipeline — status\n\nSummary of the current release.\n\n| Stage | State |\n| --- | --- |\n| Ingest | Ready |\n\n## Next\n\n- Publish\n- Verify",
      );
      const markdownWorld = await artifactWorld(target);
      const markdown = (await target.session.send("Runtime.evaluate", {
        contextId: markdownWorld,
        returnByValue: true,
        // CDP serializes DOMRect instances as {} because their geometry lives on the prototype.
        expression: `Array.from(document.querySelector('#artifact')?.children ?? []).map((block) => {
          const rect = block.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left };
        })`,
      })) as {
        result?: { value?: readonly { top: number; bottom: number; left: number }[] };
      };
      const blocks = markdown.result?.value ?? [];
      expect(blocks.length).toBeGreaterThanOrEqual(5);
      for (let index = 1; index < blocks.length; index += 1) {
        const previous = blocks[index - 1]!;
        const next = blocks[index]!;
        expect(next.top).toBeGreaterThanOrEqual(previous.bottom - 2);
        expect(Math.abs(next.left - blocks[0]!.left)).toBeLessThanOrEqual(2);
      }
    } finally {
      await target?.close();
      await service.stop();
      rmSync(envDir, { recursive: true, force: true });
    }
  },
  45_000,
);

if (!liveGateEnabled)
  console.warn(
    "SKIP gallery-geometry.test.ts: set FACET_LIVE_GALLERY=1 to run the live browser gate",
  );
else if (!availability.available)
  console.warn(
    `SKIP gallery-geometry.test.ts: pinned browser unavailable — ${availability.reason}`,
  );
