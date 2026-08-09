#!/usr/bin/env bun

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  measureBrowserExit,
  measureColdReadBack,
  measurePublishVisible,
  probeBrowserAvailability,
} from "./perf/browser-metrics";
import { assessLimit, nearestRankPercentile, summarize } from "./perf/core";
import { snapshotTier1Leaks, waitForTier1Cleanup } from "./perf/process";
import { measureMemoryAndCpu, measureTier0Spawn, measureWarmSse } from "./perf/service-metrics";
import {
  inspectDormancy,
  startDetachedPerfService,
  stopDetachedProcess,
  waitForDormancy,
} from "./perf/service";

type MetricStatus = "pass" | "fail" | "skipped" | "info";

interface Metric {
  readonly name: string;
  readonly observed: string;
  readonly status: MetricStatus;
  readonly method: string;
}

const recordOnly = process.argv.includes("--record-only");
const jsonPath = process.env.FACET_PERF_JSON;
const metrics: Metric[] = [];
const measurements: Record<string, unknown> = {};

function fixed(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function addBudget(
  name: string,
  observed: number,
  limit: number,
  mode: "at-most" | "less-than",
  unit: string,
  method: string,
): void {
  metrics.push({
    name,
    observed: `${fixed(observed)}${unit}`,
    status: assessLimit(observed, limit, mode),
    method,
  });
}

async function measureDormancy(): Promise<void> {
  const service = await startDetachedPerfService({ idleTimeoutMs: 500 });
  try {
    const active = await inspectDormancy(service);
    const dormant = await waitForDormancy(service, 5_000);
    const startedLive = !active.processExited && !active.portClosed && !active.lockRemoved;
    const cleaned = dormant.processExited && dormant.portClosed && dormant.lockRemoved;
    measurements.dormancy = { pid: service.pid, port: service.port, active, dormant };
    metrics.push({
      name: "service dormancy cleanup",
      observed: `startedLive=${startedLive} processExited=${dormant.processExited} portClosed=${dormant.portClosed} lockRemoved=${dormant.lockRemoved}`,
      status: startedLive && cleaned ? "pass" : "fail",
      method:
        "one detached service, 500ms natural idle window; PID, bound port, and live lock checked",
    });
  } finally {
    await stopDetachedProcess(service.pid);
    rmSync(service.home, { recursive: true, force: true });
  }
}

function printResults(): void {
  console.log(`MODE ${recordOnly ? "record-only" : "enforce"}`);
  for (const metric of metrics) {
    console.log(
      `${metric.status.toUpperCase()} ${metric.name}: observed=${metric.observed} · method=${metric.method}`,
    );
  }
}

function writeOutputs(): void {
  const payload = {
    mode: recordOnly ? "record-only" : "enforce",
    generatedAt: new Date().toISOString(),
    metrics,
    measurements,
  };
  if (jsonPath !== undefined) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined) {
    const lines = [
      "## Performance measurements",
      "",
      `Mode: **${recordOnly ? "record-only — threshold failures do not fail CI" : "enforced"}**`,
      "",
      ...metrics.map(
        (metric) =>
          `- ${metric.status === "pass" ? "✓" : metric.status === "fail" ? "✗" : metric.status === "info" ? "•" : "—"} **${metric.name}** · ${metric.observed} · ${metric.method}`,
      ),
      "",
    ];
    writeFileSync(summaryPath, `${lines.join("\n")}\n`, { flag: "a" });
  }
}

async function main(): Promise<void> {
  const leakBaseline = snapshotTier1Leaks();

  const memory = await measureMemoryAndCpu();
  measurements.memory = memory;
  addBudget(
    "service RSS absolute",
    memory.absoluteMaxRssMiB,
    80,
    "at-most",
    " MiB",
    `max across ready, 1s idle, post-publish, and ${memory.sampleCount} independent 1s service samples; floor RSS min/median/max=${fixed(memory.floorRssMiB.min)}/${fixed(memory.floorRssMiB.median)}/${fixed(memory.floorRssMiB.max)} MiB`,
  );
  addBudget(
    "service RSS delta over Bun floor",
    memory.deltaRssMiB.median,
    30,
    "at-most",
    " MiB",
    `${memory.sampleCount} paired detached samples; delta min/median/max=${fixed(memory.deltaRssMiB.min)}/${fixed(memory.deltaRssMiB.median)}/${fixed(memory.deltaRssMiB.max)} MiB`,
  );
  addBudget(
    "service CPU idle",
    nearestRankPercentile(memory.idleCpuPercentSamples, 0.95),
    0.5,
    "less-than",
    "%",
    `nearest-rank p95 of ${memory.idleCpuPercentSamples.length} independent 5s /proc CPU-tick samples after 1s idle`,
  );
  metrics.push({
    name: "service RSS lifecycle",
    observed: `ready=${fixed(memory.readyRssMiB)} MiB 1sIdle=${fixed(memory.idle1sRssMiB)} MiB postPublish=${fixed(memory.postPublishRssMiB)} MiB; PSS median=${fixed(memory.servicePssMiB.median)} MiB`,
    status: "info",
    method: "informational lifecycle points; RSS gates above remain authoritative",
  });

  await measureDormancy();

  const sse = await measureWarmSse();
  const sseP95 = nearestRankPercentile(sse.samplesMs, 0.95);
  measurements.sse = sse;

  // Attribution, not a budget: publish emits the SSE event only AFTER Tier 0
  // validates the bytes, and Tier 0 runs in an egress-denied netns subprocess.
  // Reporting SSE latency without this number invites "the stream is slow"
  // when the honest reading is "we validate before we announce".
  const tier0 = await measureTier0Spawn();
  const tier0P95 = nearestRankPercentile(tier0.samplesMs, 0.95);
  measurements.tier0Spawn = tier0;
  metrics.push({
    name: "tier-0 netns spawn p95 (attribution)",
    observed: `${tier0P95.toFixed(2)} ms`,
    status: "skipped",
    method: `nearest-rank p95 of ${tier0.sampleCount} runTier0 calls after ${tier0.warmupCount} warmups \u2014 accounts for ${((tier0P95 / sseP95) * 100).toFixed(0)}% of warm SSE p95`,
  });
  addBudget(
    "warm SSE p95",
    sseP95,
    100,
    "at-most",
    " ms",
    `nearest-rank p95 of ${sse.sampleCount} sequential publishes after ${sse.warmupCount} warmups on one live stream`,
  );

  const availability = await probeBrowserAvailability();
  measurements.browserAvailability = availability;
  if (!availability.available) {
    const reason = availability.reason ?? "pinned browser unavailable";
    for (const name of ["publish → visible", "cold read-back", "browser exit"] as const) {
      metrics.push({
        name,
        observed: `SKIPPED: ${reason}`,
        status: "skipped",
        method: "unmeasured",
      });
    }
  } else {
    const cold = await measureColdReadBack();
    measurements.coldReadBack = cold;
    addBudget(
      "cold read-back",
      Math.max(...cold.samplesMs),
      3_000,
      "less-than",
      " ms",
      `max-of-${cold.sampleCount}; each sample publishes, then launches a fresh netns-wrapped Tier 1 browser over that immutable revision`,
    );

    const visible = await measurePublishVisible();
    measurements.publishVisible = visible;
    const visibleP95 = nearestRankPercentile(visible.samplesMs, 0.95);
    const visibleSummary = summarize(visible.samplesMs);
    const stageP95 = {
      committedMs: nearestRankPercentile(
        visible.stages.map((sample) => sample.committedMs),
        0.95,
      ),
      sseDeliveredMs: nearestRankPercentile(
        visible.stages.map((sample) => sample.sseDeliveredMs),
        0.95,
      ),
      sseHandledMs: nearestRankPercentile(
        visible.stages.map((sample) => sample.sseHandledMs),
        0.95,
      ),
      frameBuiltMs: nearestRankPercentile(
        visible.stages.map((sample) => sample.frameBuiltMs),
        0.95,
      ),
      bootstrapLoadedMs: nearestRankPercentile(
        visible.stages.map((sample) => sample.bootstrapLoadedMs),
        0.95,
      ),
      bootReadyMs: nearestRankPercentile(
        visible.stages.map((sample) => sample.bootReadyMs),
        0.95,
      ),
      renderCompleteMs: nearestRankPercentile(
        visible.stages.map((sample) => sample.renderCompleteMs),
        0.95,
      ),
      visibleMs: nearestRankPercentile(
        visible.stages.map((sample) => sample.visibleMs),
        0.95,
      ),
      frameLoadAndParseMs: nearestRankPercentile(
        visible.stages.map((sample) => sample.frameLoadAndParseMs),
        0.95,
      ),
    };
    measurements.publishVisibleStageP95 = stageP95;
    addBudget(
      "publish → visible",
      visibleP95,
      300,
      "less-than",
      " ms",
      `nearest-rank p95 of ${visible.sampleCount}; median/p95/max=${fixed(visibleSummary.median)}/${fixed(visibleP95)}/${fixed(visibleSummary.max)} ms; exact revision, displayed state, and one visible opaque frame required`,
    );
    metrics.push({
      name: "publish → visible stage p95",
      observed: `commit=${fixed(stageP95.committedMs)}ms SSE=${fixed(stageP95.sseDeliveredMs)}ms handled=${fixed(stageP95.sseHandledMs)}ms frame=${fixed(stageP95.frameBuiltMs)}ms bootstrap=${fixed(stageP95.bootstrapLoadedMs)}ms bootReady=${fixed(stageP95.bootReadyMs)}ms render=${fixed(stageP95.renderCompleteMs)}ms visible=${fixed(stageP95.visibleMs)}ms frameLoad+parse=${fixed(stageP95.frameLoadAndParseMs)}ms`,
      status: "info",
      method: `${visible.sampleCount} instrumented replacements; wall-clock markers are injected into the real gallery without changing product code`,
    });

    const browserExit = await measureBrowserExit();
    measurements.browserExit = browserExit;
    addBudget(
      "browser exit",
      Math.max(...browserExit.samplesMs),
      2_000,
      "at-most",
      " ms",
      `max-of-${browserExit.sampleCount}; fresh browser per sample, close includes PID and profile disappearance`,
    );
  }

  const leaks = await waitForTier1Cleanup(leakBaseline, 2_000);
  measurements.cleanup = leaks;
  metrics.push({
    name: "zombie browser/profile cleanup",
    observed: `newPids=${leaks.pids.length} newProfiles=${leaks.profiles.length}`,
    status: leaks.pids.length === 0 && leaks.profiles.length === 0 ? "pass" : "fail",
    method: "baseline-diff after real cold-read, gallery, and browser-exit cycles",
  });

  printResults();
  writeOutputs();
  const failed = metrics.some((metric) => metric.status === "fail");
  const skipped = metrics.some((metric) => metric.status === "skipped");
  process.exit(skipped || (failed && !recordOnly) ? 1 : 0);
}

await main().catch(async (error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`ERROR performance harness failed:\n${message}`);
  process.exit(1);
});
