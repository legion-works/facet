import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { FacetClient, publishArtifact } from "../../src/cli/client";
import type { ArtifactType } from "../../src/shared/contracts/artifact-types";
import type { Renderer } from "../../src/shared/contracts/renderers";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import { createIsolatedWorld } from "../../src/validation/tier1/frame-target";
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
  options?: { readonly renderer?: Renderer; readonly slug?: string },
): Promise<void> {
  const published = await publishArtifact(client, {
    artifactType,
    bytes: new TextEncoder().encode(bytes).buffer as ArrayBuffer,
    slug: options?.slug ?? `gallery-geometry-${artifactType}`,
    ...(execution === undefined ? {} : { execution }),
    ...(options?.renderer === undefined ? {} : { renderer: options.renderer }),
  });
  const opened = await client.sendCommand({
    command: "open",
    requestId: crypto.randomUUID(),
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
  });
  if (!opened.ok || opened.data.command !== "open") throw new Error("gallery open command failed");
  await target.session.send("Page.enable");
  // Every bootstrap token mints a fresh `#bootstrap=<token>` fragment on
  // the SAME gallery pathname. Navigating straight from one gallery
  // fragment to another is a same-document navigation (`Page.
  // navigatedWithinDocument`, not `Page.frameNavigated`) when a caller
  // reuses one browser session across several `navigateToArtifact`
  // calls (the geometry gate's one-launch-per-file budget does exactly
  // this) — the frameNavigated listener below would then wait forever.
  // Forcing an intermediate `about:blank` guarantees the destination
  // navigation is always a fresh cross-document load.
  await target.session.send("Page.navigate", { url: "about:blank" });
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

/**
 * Emulate a fixed device viewport via CDP (the same mechanism the
 * Tier 1 verifier uses in `configureTier1Viewport` — see
 * `src/validation/tier1/runner.ts`). One override per case keeps every
 * geometry assertion tied to a deterministic, non-default-window size
 * instead of whatever headless Chrome's default happens to be.
 */
export async function setGalleryViewport(
  target: GalleryTarget,
  width: number,
  height: number,
): Promise<void> {
  await target.session.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

export interface ArtifactGeometry {
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly frameScrollLeft: number;
  readonly frameScrollTop: number;
  readonly iframeWidth: number;
  readonly iframeHeight: number;
  readonly columnCount: number | null;
  readonly canvasCount: number;
  /** Bounding box of the artifact's rendered root (first child of `#artifact`) — the zoom-in size probe. */
  readonly rootWidth: number;
  readonly rootHeight: number;
}

/**
 * Read the artifact's overflow geometry from inside its isolated
 * world (the `#artifact` scroll container the frame runtime owns —
 * see `installGalleryFrameApi` in `src/gallery-web/frame/runtime.ts`),
 * plus the shell-owned iframe's own box from the top document. The
 * pairing is the point: a squeeze regression collapses the artifact's
 * scrollWidth/Height toward the iframe's clientWidth/Height, while a
 * correctly-natural-sized artifact overflows it.
 */
export async function readArtifactGeometry(target: GalleryTarget): Promise<ArtifactGeometry> {
  const world = await artifactWorld(target);
  const inner = (await target.session.send("Runtime.evaluate", {
    contextId: world,
    returnByValue: true,
    expression: `(() => {
      const viewport = document.getElementById('artifact');
      const grid = document.querySelector('[data-facet-grid]');
      const columnCount = grid === null
        ? null
        : getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
      const rootRect = viewport?.firstElementChild?.getBoundingClientRect();
      return {
        scrollWidth: viewport?.scrollWidth ?? 0,
        scrollHeight: viewport?.scrollHeight ?? 0,
        clientWidth: viewport?.clientWidth ?? 0,
        clientHeight: viewport?.clientHeight ?? 0,
        frameScrollLeft: viewport?.scrollLeft ?? 0,
        frameScrollTop: viewport?.scrollTop ?? 0,
        columnCount,
        canvasCount: document.querySelectorAll('canvas').length,
        rootWidth: rootRect?.width ?? 0,
        rootHeight: rootRect?.height ?? 0,
      };
    })()`,
  })) as {
    result?: {
      value?: {
        scrollWidth: number;
        scrollHeight: number;
        clientWidth: number;
        clientHeight: number;
        frameScrollLeft: number;
        frameScrollTop: number;
        columnCount: number | null;
        canvasCount: number;
        rootWidth: number;
        rootHeight: number;
      };
    };
  };
  const innerValue = inner.result?.value;
  if (innerValue === undefined) throw new Error("gallery geometry: artifact world read failed");
  const outer = (await target.session.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const rect = document.querySelector('iframe')?.getBoundingClientRect();
      return { iframeWidth: rect?.width ?? 0, iframeHeight: rect?.height ?? 0 };
    })()`,
  })) as { result?: { value?: { iframeWidth: number; iframeHeight: number } } };
  const outerValue = outer.result?.value;
  if (outerValue === undefined) throw new Error("gallery geometry: iframe rect read failed");
  return { ...innerValue, ...outerValue };
}

/** Click a shell toolbar control (`#facet-zoom-in`, `#facet-zoom-reset`, ...) in the top document. */
export async function clickGalleryControl(target: GalleryTarget, elementId: string): Promise<void> {
  await target.session.send("Runtime.evaluate", {
    expression: `document.getElementById(${JSON.stringify(elementId)})?.click()`,
  });
}

/**
 * Dispatch a trusted CDP mouse-wheel event at the center of the
 * top-level iframe (the same coordinate space `Input.dispatchMouseEvent`
 * targets across frame boundaries). Unlike a synthetic
 * `new WheelEvent()` dispatched from JS, this is a real OS-level wheel
 * event: it both fires the frame's `wheel` listener AND performs
 * whatever native scroll/zoom the browser would do on an untouched
 * page — the two things the gesture-mode regression test needs to
 * distinguish (does OUR listener act, does the BROWSER'S own default
 * still happen).
 */
export async function dispatchGalleryWheel(
  target: GalleryTarget,
  deltaY: number,
  options?: { readonly ctrlKey?: boolean },
): Promise<void> {
  const rect = (await target.session.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const box = document.querySelector('iframe')?.getBoundingClientRect();
      return { x: (box?.left ?? 0) + (box?.width ?? 0) / 2, y: (box?.top ?? 0) + (box?.height ?? 0) / 2 };
    })()`,
  })) as { result?: { value?: { x: number; y: number } } };
  const point = rect.result?.value;
  if (point === undefined) throw new Error("gallery wheel: iframe rect read failed");
  // A wheel dispatch without a preceding hover hit-tests against
  // whatever CDP last considered "under the cursor" (often nothing),
  // and silently no-ops instead of scrolling the artifact.
  await target.session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await target.session.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY,
    // CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
    modifiers: options?.ctrlKey === true ? 2 : 0,
  });
  // The scroll (and any listener reaction) lands on the next rendered
  // frame, not synchronously with the CDP call's resolution.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/**
 * Capture a full-page PNG of the top document and write it to disk,
 * creating parent directories as needed. Mirrors the capture shape
 * `captureScreenshotWithFallback` uses in the Tier 1 runner, without
 * the oversized-payload fallback path — geometry-gate screenshots are
 * bounded by the fixed 1280x720 / 1920x1080 viewports.
 */
export async function captureGalleryScreenshot(target: GalleryTarget, path: string): Promise<void> {
  const shot = (await target.session.send("Page.captureScreenshot", {
    format: "png",
  })) as { data?: string };
  if (typeof shot.data !== "string" || shot.data.length === 0) {
    throw new Error(`gallery geometry: screenshot capture returned no data for ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(shot.data, "base64"));
}
