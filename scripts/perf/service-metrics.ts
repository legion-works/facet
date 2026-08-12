import { rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { FacetClient, publishArtifact } from "../../src/cli/client";
import { collectFacetStatus } from "../../src/cli/commands/status";
import { computeLexicalExpectations } from "../../src/service/lexical/expectations";
import { createTier0Runner } from "../../src/validation/tier0/runner";
import { summarize } from "./core";
import {
  sampleProcessCpuPercent,
  sampleProcessMemory,
  startBareBunFloor,
  stopBareBunFloor,
} from "./process";
import { startDetachedPerfService, stopDetachedProcess } from "./service";

const MEMORY_SAMPLE_COUNT = 5;
const SSE_WARMUP_COUNT = 3;
const SSE_SAMPLE_COUNT = 40;
const TIER0_SAMPLE_COUNT = 40;
const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30"><text x="5" y="20">perf</text></svg>',
);

export interface MemoryMeasurement {
  readonly sampleCount: number;
  readonly floorRssMiB: ReturnType<typeof summarize>;
  readonly floorPssMiB: ReturnType<typeof summarize>;
  readonly serviceRssMiB: ReturnType<typeof summarize>;
  readonly servicePssMiB: ReturnType<typeof summarize>;
  readonly deltaRssMiB: ReturnType<typeof summarize>;
  readonly readyRssMiB: number;
  readonly idle1sRssMiB: number;
  readonly postPublishRssMiB: number;
  readonly absoluteMaxRssMiB: number;
  readonly idleCpuPercentSamples: readonly number[];
}

function bytesToMiB(bytes: number | null): number {
  if (bytes === null) throw new Error("process memory sample is unavailable");
  return bytes / 1024 / 1024;
}

function serviceMemory(
  paths: Parameters<typeof collectFacetStatus>[0],
  expectedPid: number,
): {
  readonly rssMiB: number;
  readonly pssMiB: number;
} {
  const status = collectFacetStatus(paths);
  if (status.process === null || status.process.pid !== expectedPid) {
    throw new Error(`Facet service pid ${expectedPid} is not live during memory sampling`);
  }
  return {
    rssMiB: bytesToMiB(status.process.rssBytes),
    pssMiB: bytesToMiB(status.process.pssBytes),
  };
}

export async function measureMemoryAndCpu(
  sampleCount = MEMORY_SAMPLE_COUNT,
): Promise<MemoryMeasurement> {
  const floorRss: number[] = [];
  const floorPss: number[] = [];
  const serviceRss: number[] = [];
  const servicePss: number[] = [];
  const deltas: number[] = [];
  let readyRssMiB = 0;
  let idle1sRssMiB = 0;
  let postPublishRssMiB = 0;
  const idleCpuPercentSamples: number[] = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const floor = await startBareBunFloor();
    const service = await startDetachedPerfService({ idleTimeoutMs: 30_000 });
    try {
      const ready = serviceMemory(service.paths, service.pid);
      await Bun.sleep(1_000);
      const floorSample = sampleProcessMemory(floor.pid);
      const idle = serviceMemory(service.paths, service.pid);
      const floorRssMiB = bytesToMiB(floorSample.rssBytes);
      floorRss.push(floorRssMiB);
      floorPss.push(bytesToMiB(floorSample.pssBytes));
      serviceRss.push(idle.rssMiB);
      servicePss.push(idle.pssMiB);
      deltas.push(idle.rssMiB - floorRssMiB);

      idleCpuPercentSamples.push(await sampleProcessCpuPercent(service.pid, 5_000));
      if (index === 0) {
        readyRssMiB = ready.rssMiB;
        idle1sRssMiB = idle.rssMiB;
        const client = new FacetClient({
          baseUrl: service.baseUrl,
          installToken: service.installToken,
        });
        await publishArtifact(client, {
          artifactType: "svg",
          bytes: SVG_BYTES.buffer as ArrayBuffer,
          slug: `perf-memory-${crypto.randomUUID().slice(0, 8)}`,
        });
        postPublishRssMiB = serviceMemory(service.paths, service.pid).rssMiB;
      }
    } finally {
      await stopDetachedProcess(service.pid);
      rmSync(service.home, { recursive: true, force: true });
      await stopBareBunFloor(floor);
    }
  }

  return {
    sampleCount,
    floorRssMiB: summarize(floorRss),
    floorPssMiB: summarize(floorPss),
    serviceRssMiB: summarize(serviceRss),
    servicePssMiB: summarize(servicePss),
    deltaRssMiB: summarize(deltas),
    readyRssMiB,
    idle1sRssMiB,
    postPublishRssMiB,
    absoluteMaxRssMiB: Math.max(readyRssMiB, postPublishRssMiB, ...serviceRss),
    idleCpuPercentSamples,
  };
}

export interface TimedSseEvent {
  readonly payload: Record<string, unknown>;
  readonly receivedAt: number;
  readonly receivedAtWall: number;
}

export class SseEvents {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #history: TimedSseEvent[] = [];
  readonly #waiters: Array<{
    readonly predicate: (event: TimedSseEvent) => boolean;
    readonly resolve: (event: TimedSseEvent) => void;
  }> = [];
  readonly #pump: Promise<void>;

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
    this.#pump = this.#read();
  }

  async #read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const next = await this.#reader.read();
      if (next.done || next.value === undefined) return;
      buffer += decoder.decode(next.value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
        if (!block.startsWith("data: ")) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(block.slice("data: ".length)) as Record<string, unknown>;
        } catch {
          continue;
        }
        const event = {
          payload,
          receivedAt: performance.now(),
          receivedAtWall: Date.now(),
        };
        this.#history.push(event);
        for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
          const waiter = this.#waiters[index]!;
          if (!waiter.predicate(event)) continue;
          this.#waiters.splice(index, 1);
          waiter.resolve(event);
        }
      }
    }
  }

  waitFor(predicate: (event: TimedSseEvent) => boolean, timeoutMs: number): Promise<TimedSseEvent> {
    const existing = this.#history.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter = {
        predicate,
        resolve: (event: TimedSseEvent) => {
          clearTimeout(timer);
          resolve(event);
        },
      };
      this.#waiters.push(waiter);
      timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error(`SSE event timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  async close(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined);
    await this.#pump.catch(() => undefined);
  }
}

async function publishRevision(
  client: FacetClient,
  artifactId: string,
  content: string,
): Promise<string> {
  const response = await client.sendCommand({
    command: "publish",
    requestId: crypto.randomUUID(),
    artifactId,
    artifactType: "markdown",
    renderer: "svg",
    bytes: Buffer.from(content).toString("base64"),
  });
  if (!response.ok || response.data.command !== "publish") throw new Error("publish failed");
  return response.data.revision.sha256;
}

export async function measureWarmSse(): Promise<{
  readonly warmupCount: number;
  readonly sampleCount: number;
  readonly samplesMs: readonly number[];
  readonly preEmitMs: readonly number[];
  readonly deliveryMs: readonly number[];
  readonly responseMs: readonly number[];
}> {
  const service = await startDetachedPerfService({ idleTimeoutMs: 120_000 });
  let events: SseEvents | undefined;
  try {
    const client = new FacetClient({
      baseUrl: service.baseUrl,
      installToken: service.installToken,
    });
    const initial = await publishArtifact(client, {
      artifactType: "markdown",
      bytes: new TextEncoder().encode("# warm SSE\n").buffer as ArrayBuffer,
      slug: `perf-sse-${crypto.randomUUID().slice(0, 8)}`,
    });
    const opened = await client.sendCommand({
      command: "open",
      requestId: crypto.randomUUID(),
      artifactId: initial.artifactId,
      revisionSha: initial.revisionSha,
    });
    if (!opened.ok || opened.data.command !== "open") throw new Error("open failed");
    const response = await fetch(`${service.baseUrl}/api/v1/stream`, {
      headers: {
        authorization: `Bearer ${service.installToken}`,
        host: `127.0.0.1:${service.port}`,
        "x-gallery-lease": opened.data.lease.leaseId,
        "x-gallery-artifact": initial.artifactId,
      },
    });
    if (response.status !== 200 || response.body === null) throw new Error("SSE stream failed");
    events = new SseEvents(response.body);
    await events.waitFor((event) => event.payload.type === "stream:open", 5_000);

    const samples: number[] = [];
    const preEmitMs: number[] = [];
    const deliveryMs: number[] = [];
    const responseMs: number[] = [];
    const total = SSE_WARMUP_COUNT + SSE_SAMPLE_COUNT;
    for (let index = 0; index < total; index += 1) {
      const revisionNumber = index + 2;
      const committed = events.waitFor(
        (event) =>
          event.payload.type === "revision:committed" &&
          event.payload.revisionNumber === revisionNumber,
        10_000,
      );
      const startedAt = performance.now();
      const startedAtWall = Date.now();
      const revisionSha = await publishRevision(
        client,
        initial.artifactId,
        `# warm SSE revision ${revisionNumber}\n`,
      );
      const responseAtWall = Date.now();
      const event = await committed;
      if (event.payload.revisionSha !== revisionSha)
        throw new Error("SSE revision identity mismatch");
      const committedAtWall = Date.parse(String(event.payload.at));
      if (!Number.isFinite(committedAtWall)) throw new Error("SSE event has no valid commit time");
      if (index >= SSE_WARMUP_COUNT) {
        samples.push(event.receivedAt - startedAt);
        preEmitMs.push(committedAtWall - startedAtWall);
        deliveryMs.push(event.receivedAtWall - committedAtWall);
        responseMs.push(responseAtWall - startedAtWall);
      }
    }
    return {
      warmupCount: SSE_WARMUP_COUNT,
      sampleCount: SSE_SAMPLE_COUNT,
      samplesMs: samples,
      preEmitMs,
      deliveryMs,
      responseMs,
    };
  } finally {
    await events?.close();
    await stopDetachedProcess(service.pid);
    rmSync(service.home, { recursive: true, force: true });
  }
}

export async function measureTier0Spawn(): Promise<{
  readonly warmupCount: number;
  readonly sampleCount: number;
  readonly coldStartMs: number;
  readonly warmSamplesMs: readonly number[];
}> {
  const source = Uint8Array.from(
    new TextEncoder().encode("# Tier 0 perf\n"),
  ) as Uint8Array<ArrayBuffer>;
  const lexical = computeLexicalExpectations(source, "markdown");
  const revisionSha = createHash("sha256").update(source).digest("hex");
  const runner = createTier0Runner(0);
  const request = {
    revisionSha,
    artifactType: "markdown" as const,
    renderer: "svg" as const,
    source,
    lexical: {
      rendererRootSvgCount: lexical.expectedRendererRoots,
      mermaidNodeCount: lexical.mermaidNodeCount,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: 0,
    },
  };
  const coldStartedAt = performance.now();
  try {
    const cold = await runner(request);
    if (cold.status !== "ok") throw new Error(`Tier 0 cold verdict was ${cold.status}`);
    const coldStartMs = performance.now() - coldStartedAt;
    const warmSamplesMs: number[] = [];
    const total = SSE_WARMUP_COUNT + TIER0_SAMPLE_COUNT;
    for (let index = 0; index < total; index += 1) {
      const startedAt = performance.now();
      const result = await runner(request);
      if (result.status !== "ok") throw new Error(`Tier 0 warm verdict was ${result.status}`);
      if (index >= SSE_WARMUP_COUNT) warmSamplesMs.push(performance.now() - startedAt);
    }
    return {
      warmupCount: SSE_WARMUP_COUNT,
      sampleCount: TIER0_SAMPLE_COUNT,
      coldStartMs,
      warmSamplesMs,
    };
  } finally {
    runner.close?.();
  }
}

/**
 * TSX compile probe — records Bun.build's compile cost for the static and
 * interactive fixtures used in the Task 1 measurement, plus the SHA-256 of
 * the first output to surface a determinism drift immediately.
 *
 * This is RECORD-only for the first commit; the plan calls for a separate
 * measurement commit so the latency threshold is set from data, not from a
 * single hosted-runner sample.
 */
export interface TsxCompileMeasurement {
  readonly staticColdMs: number;
  readonly staticWarmSamplesMs: readonly number[];
  readonly staticWarmP50Ms: number;
  readonly staticWarmP95Ms: number;
  readonly staticOutputBytes: number;
  readonly staticSha256: string;
  readonly interactiveColdMs: number;
  readonly interactiveWarmSamplesMs: readonly number[];
  readonly interactiveWarmP50Ms: number;
  readonly interactiveWarmP95Ms: number;
  readonly interactiveOutputBytes: number;
  readonly interactiveSha256: string;
  readonly warmSampleCount: number;
}

const TSX_FIXTURES_DIR = join(import.meta.dir, "..", "..", "tests", "fixtures", "tsx");
const STATIC_FIXTURE = join(TSX_FIXTURES_DIR, "static-source.tsx");
const INTERACTIVE_FIXTURE = join(TSX_FIXTURES_DIR, "interactive-source.tsx");

async function compileFixture(entry: string): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: false,
    splitting: false,
    metafile: false,
    naming: "[dir]/[name].[ext]",
    sourcemap: "none",
    external: [],
    throw: false,
  });
  if (!result.success || result.outputs.length === 0) {
    throw new Error(
      `Bun.build failed for ${entry}: ${result.logs.map((log) => log.message).join("; ")}`,
    );
  }
  const firstOutput = result.outputs[0];
  if (firstOutput === undefined) {
    throw new Error(`Bun.build produced no outputs for ${entry}`);
  }
  return new Uint8Array(await firstOutput.arrayBuffer());
}

function percentileOf(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].toSorted((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(sorted.length * fraction));
  return sorted[Math.min(sorted.length, rank) - 1] ?? 0;
}

export async function measureTsxCompile(warmCount = 20): Promise<TsxCompileMeasurement> {
  const staticColdStart = performance.now();
  const staticFirst = await compileFixture(STATIC_FIXTURE);
  const staticColdMs = performance.now() - staticColdStart;

  const interactiveColdStart = performance.now();
  const interactiveFirst = await compileFixture(INTERACTIVE_FIXTURE);
  const interactiveColdMs = performance.now() - interactiveColdStart;

  const staticWarm: number[] = [];
  const interactiveWarm: number[] = [];
  for (let i = 0; i < warmCount; i += 1) {
    const startStatic = performance.now();
    await compileFixture(STATIC_FIXTURE);
    staticWarm.push(performance.now() - startStatic);
    const startInteractive = performance.now();
    await compileFixture(INTERACTIVE_FIXTURE);
    interactiveWarm.push(performance.now() - startInteractive);
  }

  return {
    staticColdMs,
    staticWarmSamplesMs: staticWarm,
    staticWarmP50Ms: percentileOf(staticWarm, 0.5),
    staticWarmP95Ms: percentileOf(staticWarm, 0.95),
    staticOutputBytes: staticFirst.byteLength,
    staticSha256: createHash("sha256").update(staticFirst).digest("hex"),
    interactiveColdMs,
    interactiveWarmSamplesMs: interactiveWarm,
    interactiveWarmP50Ms: percentileOf(interactiveWarm, 0.5),
    interactiveWarmP95Ms: percentileOf(interactiveWarm, 0.95),
    interactiveOutputBytes: interactiveFirst.byteLength,
    interactiveSha256: createHash("sha256").update(interactiveFirst).digest("hex"),
    warmSampleCount: warmCount,
  };
}
