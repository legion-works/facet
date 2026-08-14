import { expect } from "bun:test";

import { FacetClient, publishArtifact } from "../../src/cli/client";
import type { ArtifactType } from "../../src/shared/contracts/artifact-types";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import {
  createIsolatedWorld,
  resolveNestedArtifactFrame,
} from "../../src/validation/tier1/frame-target";
import { resolveLauncher } from "../../src/validation/tier1/launcher";

export type GalleryTarget = Awaited<ReturnType<PuppeteerTier1Browser["launch"]>>;

export function galleryBrowser(): PuppeteerTier1Browser {
  const launcher = resolveLauncher();
  return new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
}

export async function navigateToArtifact(
  target: GalleryTarget,
  client: FacetClient,
  artifactType: ArtifactType,
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

export async function artifactFrame(
  target: GalleryTarget,
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

export async function artifactWorld(target: GalleryTarget): Promise<number> {
  const artifact = await artifactFrame(target);
  return (await createIsolatedWorld(target.session, artifact.frameId)).executionContextId;
}

export async function nestedArtifactWorld(target: GalleryTarget): Promise<number> {
  const outer = await artifactFrame(target);
  const nested = await resolveNestedArtifactFrame(target.session, outer);
  return (await createIsolatedWorld(target.session, nested.frameId)).executionContextId;
}

export async function artifactBlockRects(
  target: GalleryTarget,
): Promise<readonly { top: number; bottom: number; left: number }[]> {
  const markdownWorld = await artifactWorld(target);
  const markdown = (await target.session.send("Runtime.evaluate", {
    contextId: markdownWorld,
    returnByValue: true,
    expression: `Array.from(document.querySelector('#artifact')?.children ?? []).map((block) => {
      const rect = block.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left };
    })`,
  })) as {
    result?: { value?: readonly { top: number; bottom: number; left: number }[] };
  };
  return markdown.result?.value ?? [];
}
