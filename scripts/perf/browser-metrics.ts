import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { FacetClient } from "../../src/cli/client";
import { computeLexicalExpectations } from "../../src/service/lexical/expectations";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import { resolveLauncher } from "../../src/validation/tier1/launcher";
import { TIER1_NETWORK_NAMESPACE, TIER1_PINNED_VERSION } from "../../src/validation/tier1/limits";
import { runTier1 } from "../../src/validation/tier1/runner";
import {
  armGalleryStageInstrumentation,
  installGalleryStageInstrumentation,
  readGalleryStageInstrumentation,
  type GalleryStageTimestamps,
} from "./gallery-stages";
import { snapshotTier1Leaks, waitForTier1Cleanup } from "./process";
import { startDetachedPerfService, stopDetachedProcess } from "./service";
import { SseEvents } from "./service-metrics";

const COLD_SAMPLE_COUNT = 5;
const EXIT_SAMPLE_COUNT = 20;
const VISIBLE_SAMPLE_COUNT = 20;

interface ArtifactRef {
  readonly artifactId: string;
  readonly revisionSha: string;
}

export interface PublishVisibleStageSample {
  readonly totalMs: number;
  readonly committedMs: number;
  readonly sseDeliveredMs: number;
  readonly publishResponseMs: number;
  readonly sseHandledMs: number;
  readonly frameBuiltMs: number;
  readonly bootstrapLoadedMs: number;
  readonly bootReadyMs: number;
  readonly renderCompleteMs: number;
  readonly visibleMs: number;
  readonly frameLoadAndParseMs: number;
}

function svgBytes(sentinel: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 30"><text x="5" y="20">${sentinel}</text></svg>`,
    ),
  ) as Uint8Array<ArrayBuffer>;
}

function sha256(bytes: Uint8Array<ArrayBuffer>): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createArtifact(client: FacetClient, slug: string): Promise<string> {
  const response = await client.sendCommand({
    command: "create",
    requestId: crypto.randomUUID(),
    projectId: "/facet",
    slug,
    title: slug,
  });
  if (!response.ok || response.data.command !== "create") throw new Error("create failed");
  return response.data.artifact.id;
}

async function publishSvg(
  client: FacetClient,
  artifactId: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<ArtifactRef> {
  const response = await client.sendCommand({
    command: "publish",
    requestId: crypto.randomUUID(),
    artifactId,
    artifactType: "svg",
    renderer: "svg",
    bytes: Buffer.from(bytes).toString("base64"),
  });
  if (!response.ok || response.data.command !== "publish") throw new Error("publish failed");
  return { artifactId, revisionSha: response.data.revision.sha256 };
}

function assertNoTier1Leaks(
  leaked: Awaited<ReturnType<typeof waitForTier1Cleanup>>,
  stage: string,
): void {
  if (leaked.pids.length > 0 || leaked.profiles.length > 0) {
    throw new Error(
      `${stage} leaked Tier 1 resources: pids=${leaked.pids.join(",")} profiles=${leaked.profiles.join(",")}`,
    );
  }
}

export async function probeBrowserAvailability(): Promise<{
  readonly available: boolean;
  readonly reason: string | null;
}> {
  return new PuppeteerTier1Browser().probeAvailability();
}

function galleryBrowser(): PuppeteerTier1Browser {
  const launcher = resolveLauncher();
  return new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
}

export async function measureColdReadBack(): Promise<{
  readonly sampleCount: number;
  readonly samplesMs: readonly number[];
  readonly verdictStatuses: readonly string[];
  readonly discardedTransportWedges: number;
}> {
  const baseline = snapshotTier1Leaks();
  const service = await startDetachedPerfService({ idleTimeoutMs: 120_000 });
  try {
    const client = new FacetClient({
      baseUrl: service.baseUrl,
      installToken: service.installToken,
    });
    const artifactId = await createArtifact(client, `perf-cold-${crypto.randomUUID().slice(0, 8)}`);
    const samples: number[] = [];
    const verdictStatuses: string[] = [];
    let discardedTransportWedges = 0;
    let attempts = 0;
    while (samples.length < COLD_SAMPLE_COUNT) {
      attempts += 1;
      if (attempts > COLD_SAMPLE_COUNT + 2)
        throw new Error("cold read-back transport wedged repeatedly");
      assertNoTier1Leaks(await waitForTier1Cleanup(baseline, 2_000), "cold read-back preflight");
      const bytes = svgBytes(`cold-${attempts}`);
      const startedAt = performance.now();
      const published = await publishSvg(client, artifactId, bytes);
      const lexical = computeLexicalExpectations(bytes, "svg");
      const evidenceDir = join(service.home, "evidence", `cold-${attempts}`);
      mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
      let verdict: Awaited<ReturnType<typeof runTier1>>;
      try {
        verdict = await runTier1({
          revisionSha: published.revisionSha,
          artifactType: "svg",
          renderer: "svg",
          source: bytes,
          lexical: {
            rendererRootSvgCount: lexical.expectedRendererRoots,
            mermaidNodeCount: lexical.mermaidNodeCount,
            visibleSvgCount: 0,
            opaqueRegionCount: 0,
            externalImageCount: 0,
          },
          launcherVersion: TIER1_PINNED_VERSION,
          networkNamespace: TIER1_NETWORK_NAMESPACE,
          evidenceDir,
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("CDP transport wedged")) {
          discardedTransportWedges += 1;
          assertNoTier1Leaks(await waitForTier1Cleanup(baseline, 2_000), "cold wedge cleanup");
          continue;
        }
        throw error;
      }
      if (["timeout", "tampered", "error"].includes(verdict.status)) {
        throw new Error(`cold Tier 1 verdict was ${verdict.status}`);
      }
      verdictStatuses.push(verdict.status);
      samples.push(performance.now() - startedAt);
      assertNoTier1Leaks(await waitForTier1Cleanup(baseline, 2_000), "cold read-back");
    }
    return {
      sampleCount: COLD_SAMPLE_COUNT,
      samplesMs: samples,
      verdictStatuses,
      discardedTransportWedges,
    };
  } finally {
    await stopDetachedProcess(service.pid);
    rmSync(service.home, { recursive: true, force: true });
  }
}

export async function measureBrowserExit(): Promise<{
  readonly sampleCount: number;
  readonly samplesMs: readonly number[];
}> {
  const baseline = snapshotTier1Leaks();
  const browser = new PuppeteerTier1Browser();
  const samples: number[] = [];
  for (let index = 0; index < EXIT_SAMPLE_COUNT; index += 1) {
    const target = await browser.launch();
    const startedAt = performance.now();
    await target.close();
    assertNoTier1Leaks(await waitForTier1Cleanup(baseline, 2_000), "browser exit");
    samples.push(performance.now() - startedAt);
  }
  return { sampleCount: EXIT_SAMPLE_COUNT, samplesMs: samples };
}

async function waitForVisibleRevision(
  target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>>,
  revisionSha: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let observed: unknown = null;
  while (Date.now() < deadline) {
    const evaluation = await target.session.send<{
      result?: {
        value?: {
          readonly status: string;
          readonly revision: string;
          readonly visible: boolean;
          readonly frameCount: number;
          readonly url: string;
          readonly title: string;
          readonly body: string;
        };
      };
    }>("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const frame = document.querySelector('iframe');
        return {
          status: document.querySelector('#facet-status-line')?.textContent ?? '',
          revision: document.querySelector('#facet-revision')?.textContent ?? '',
          visible: frame instanceof HTMLIFrameElement && frame.style.visibility === 'visible',
          frameCount: document.querySelectorAll('iframe').length,
          url: document.URL,
          title: document.title,
          body: document.body?.textContent?.slice(0, 300) ?? '',
        };
      })()`,
    });
    observed = evaluation.result?.value ?? null;
    if (
      observed !== null &&
      typeof observed === "object" &&
      "status" in observed &&
      observed.status === "displayed" &&
      "revision" in observed &&
      observed.revision === revisionSha.slice(0, 12) &&
      "visible" in observed &&
      observed.visible === true &&
      "frameCount" in observed &&
      observed.frameCount === 1
    ) {
      return;
    }
    if (
      observed !== null &&
      typeof observed === "object" &&
      "status" in observed &&
      observed.status === "error"
    ) {
      throw new Error(`gallery entered error state: ${JSON.stringify(observed)}`);
    }
    await Bun.sleep(10);
  }
  throw new Error(`gallery visibility timeout: ${JSON.stringify(observed)}`);
}

async function waitForGalleryLive(
  target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const evaluation = await target.session.send<{ result?: { value?: string } }>(
      "Runtime.evaluate",
      {
        returnByValue: true,
        expression: "document.querySelector('#facet-live')?.dataset.state ?? ''",
      },
    );
    if (evaluation.result?.value === "live") return;
    await Bun.sleep(10);
  }
  throw new Error("gallery SSE connection did not become live");
}

function requiredStage(
  stages: GalleryStageTimestamps,
  key: keyof GalleryStageTimestamps,
  startedAtWall: number,
): number {
  const timestamp = stages[key];
  if (timestamp === null) {
    throw new Error(`gallery stage ${key} was not observed: ${JSON.stringify(stages)}`);
  }
  return timestamp - startedAtWall;
}

export async function measurePublishVisible(): Promise<{
  readonly sampleCount: number;
  readonly samplesMs: readonly number[];
  readonly stages: readonly PublishVisibleStageSample[];
}> {
  const baseline = snapshotTier1Leaks();
  const service = await startDetachedPerfService({ idleTimeoutMs: 120_000 });
  const browser = galleryBrowser();
  let target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>> | undefined;
  let observer: SseEvents | undefined;
  try {
    const client = new FacetClient({
      baseUrl: service.baseUrl,
      installToken: service.installToken,
    });
    const artifactId = await createArtifact(
      client,
      `perf-visible-${crypto.randomUUID().slice(0, 8)}`,
    );
    const initialBytes = svgBytes("visible-initial");
    const initial = await publishSvg(client, artifactId, initialBytes);
    const opened = await client.sendCommand({
      command: "open",
      requestId: crypto.randomUUID(),
      artifactId,
      revisionSha: initial.revisionSha,
    });
    if (!opened.ok || opened.data.command !== "open") throw new Error("open failed");
    const streamResponse = await fetch(`${service.baseUrl}/api/v1/stream`, {
      headers: {
        authorization: `Bearer ${service.installToken}`,
        host: `127.0.0.1:${service.port}`,
        "x-gallery-lease": opened.data.lease.leaseId,
        "x-gallery-artifact": artifactId,
      },
    });
    if (streamResponse.status !== 200 || streamResponse.body === null) {
      throw new Error("gallery observer SSE stream failed");
    }
    observer = new SseEvents(streamResponse.body);
    await observer.waitFor((event) => event.payload.type === "stream:open", 5_000);
    target = await browser.launch();
    await target.session.send("Page.navigate", { url: opened.data.frameUrl });
    await waitForVisibleRevision(target, initial.revisionSha);
    await waitForGalleryLive(target);
    await installGalleryStageInstrumentation(target);

    const samples: number[] = [];
    const stageSamples: PublishVisibleStageSample[] = [];
    for (let index = 0; index < VISIBLE_SAMPLE_COUNT; index += 1) {
      const sentinel = `visible-${index}`;
      const bytes = svgBytes(sentinel);
      const expectedSha = sha256(bytes);
      await armGalleryStageInstrumentation(target, expectedSha);
      const committed = observer.waitFor(
        (event) =>
          event.payload.type === "revision:committed" && event.payload.revisionSha === expectedSha,
        10_000,
      );
      const startedAt = performance.now();
      const startedAtWall = Date.now();
      const published = await publishSvg(client, artifactId, bytes);
      const responseAtWall = Date.now();
      if (published.revisionSha !== expectedSha)
        throw new Error("published revision hash mismatch");
      const event = await committed;
      await waitForVisibleRevision(target, published.revisionSha);
      const totalMs = performance.now() - startedAt;
      const stages = await readGalleryStageInstrumentation(target);
      const committedAtWall = Date.parse(String(event.payload.at));
      if (!Number.isFinite(committedAtWall))
        throw new Error("revision event commit time is invalid");
      const frameBuiltMs = requiredStage(stages, "frameBuiltAt", startedAtWall);
      const bootstrapLoadedMs = requiredStage(stages, "bootstrapLoadedAt", startedAtWall);
      samples.push(totalMs);
      stageSamples.push({
        totalMs,
        committedMs: committedAtWall - startedAtWall,
        sseDeliveredMs: event.receivedAtWall - startedAtWall,
        publishResponseMs: responseAtWall - startedAtWall,
        sseHandledMs: requiredStage(stages, "sseHandledAt", startedAtWall),
        frameBuiltMs,
        bootstrapLoadedMs,
        bootReadyMs: requiredStage(stages, "bootReadyAt", startedAtWall),
        renderCompleteMs: requiredStage(stages, "renderCompleteAt", startedAtWall),
        visibleMs: requiredStage(stages, "visibleAt", startedAtWall),
        frameLoadAndParseMs: bootstrapLoadedMs - frameBuiltMs,
      });
    }
    return { sampleCount: VISIBLE_SAMPLE_COUNT, samplesMs: samples, stages: stageSamples };
  } finally {
    await target?.close();
    await observer?.close();
    assertNoTier1Leaks(await waitForTier1Cleanup(baseline, 2_000), "publish visible");
    await stopDetachedProcess(service.pid);
    rmSync(service.home, { recursive: true, force: true });
  }
}
