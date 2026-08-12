#!/usr/bin/env bun

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { FacetClient, publishArtifact } from "../src/cli/client";
import { isPidAlive } from "../src/shared/util/process";
import {
  measureBrowserExit,
  measureColdReadBack,
  measurePublishVisible,
  probeBrowserAvailability,
} from "./perf/browser-metrics";
import { assessLimit, nearestRankPercentile, summarize } from "./perf/core";
import {
  PERF_BUDGETS,
  enforcementForPolicy,
  type PerfBudgetKey,
  type PerfPolicy,
} from "./perf/budgets";
import { snapshotTier1Leaks, waitForTier1Cleanup } from "./perf/process";
import {
  measureMemoryAndCpu,
  measureTier0Spawn,
  measureTsxCompile,
  measureWarmSse,
} from "./perf/service-metrics";
import {
  inspectDormancy,
  listServiceChildPids,
  startDetachedPerfService,
  stopDetachedProcess,
  waitForDormancy,
} from "./perf/service";

type MetricStatus = "pass" | "fail" | "skipped" | "info";

interface Metric {
  readonly name: string;
  readonly observed: string;
  readonly status: MetricStatus;
  readonly enforced: boolean;
  readonly method: string;
}

const quick = process.argv.includes("--quick");
const requestedPolicies = [
  process.argv.includes("--ci") ? "ci" : null,
  process.argv.includes("--record-only") ? "record" : null,
].filter((value): value is PerfPolicy => value !== null);
if (requestedPolicies.length > 1) throw new Error("choose only one performance policy");
const policy: PerfPolicy = requestedPolicies[0] ?? (quick ? "ci" : "stable");
const jsonPath = process.env.FACET_PERF_JSON;
const metrics: Metric[] = [];
const measurements: Record<string, unknown> = {};

function fixed(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function addBudget(key: PerfBudgetKey, observed: number, unit: string, method: string): void {
  const budget = PERF_BUDGETS[key];
  metrics.push({
    name: budget.name,
    observed: `${fixed(observed)}${unit}`,
    status: assessLimit(observed, budget.limit, budget.mode),
    enforced: enforcementForPolicy(budget.scope, policy),
    method,
  });
}

async function measureDormancy(): Promise<void> {
  const service = await startDetachedPerfService({ idleTimeoutMs: 500 });
  try {
    const client = new FacetClient({
      baseUrl: service.baseUrl,
      installToken: service.installToken,
    });
    await publishArtifact(client, {
      artifactType: "markdown",
      bytes: new TextEncoder().encode("# perf dormancy\n").buffer as ArrayBuffer,
    });
    const workerPids = listServiceChildPids(service.pid);
    const active = await inspectDormancy(service);
    const dormant = await waitForDormancy(service, 5_000);
    const startedLive = !active.processExited && !active.portClosed && !active.lockRemoved;
    const survivingWorkerPids = workerPids.filter(isPidAlive);
    const cleaned =
      dormant.processExited &&
      dormant.portClosed &&
      dormant.lockRemoved &&
      dormant.workerProcesses === 0 &&
      survivingWorkerPids.length === 0;
    measurements.dormancy = {
      pid: service.pid,
      port: service.port,
      workerPids,
      survivingWorkerPids,
      active,
      dormant,
    };
    metrics.push({
      name: "service dormancy cleanup",
      observed: `startedLive=${startedLive} processExited=${dormant.processExited} portClosed=${dormant.portClosed} lockRemoved=${dormant.lockRemoved} workerProcesses=${dormant.workerProcesses} capturedWorkers=${workerPids.length} survivingWorkers=${survivingWorkerPids.length}`,
      status: startedLive && workerPids.length > 0 && cleaned ? "pass" : "fail",
      enforced: true,
      method:
        "one detached service, one publish, 500ms natural idle window; service PID, bound port, lock, and captured worker PIDs checked",
    });
  } finally {
    await stopDetachedProcess(service.pid);
    rmSync(service.home, { recursive: true, force: true });
  }
}

function metricLabel(metric: Metric): string {
  if (metric.status === "info") return "INFO";
  if (metric.status === "skipped") return "SKIPPED";
  if (metric.enforced) return metric.status === "pass" ? "PASS [ENFORCED]" : "FAIL [ENFORCED]";
  return metric.status === "pass" ? "MEASURED-MET [RECORDED]" : "MEASURED-NOT-MET [RECORDED]";
}

function printResults(): void {
  console.log(`POLICY ${policy}`);
  for (const metric of metrics) {
    console.log(
      `${metricLabel(metric)} ${metric.name}: observed=${metric.observed} · method=${metric.method}`,
    );
  }
}

function writeOutputs(): void {
  const payload = {
    policy,
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
      `Policy: **${policy}** · recorded metrics never license a passing gate`,
      "",
      ...metrics.map(
        (metric) =>
          `- **${metricLabel(metric)}** · ${metric.name} · ${metric.observed} · ${metric.method}`,
      ),
      "",
    ];
    writeFileSync(summaryPath, `${lines.join("\n")}\n`, { flag: "a" });
  }
}

async function main(): Promise<void> {
  const leakBaseline = snapshotTier1Leaks();

  console.error("perf phase: memory-cpu");
  const memory = await measureMemoryAndCpu();
  measurements.memory = memory;
  addBudget(
    "rssAbsolute",
    memory.absoluteMaxRssMiB,
    " MiB",
    `max across ready, 1s idle, post-publish, and ${memory.sampleCount} independent 1s service samples; floor RSS min/median/max=${fixed(memory.floorRssMiB.min)}/${fixed(memory.floorRssMiB.median)}/${fixed(memory.floorRssMiB.max)} MiB`,
  );
  addBudget(
    "rssDelta",
    memory.deltaRssMiB.median,
    " MiB",
    `${memory.sampleCount} paired detached samples; delta min/median/max=${fixed(memory.deltaRssMiB.min)}/${fixed(memory.deltaRssMiB.median)}/${fixed(memory.deltaRssMiB.max)} MiB`,
  );
  addBudget(
    "idleCpu",
    nearestRankPercentile(memory.idleCpuPercentSamples, 0.95),
    "%",
    `nearest-rank p95 of ${memory.idleCpuPercentSamples.length} independent 5s /proc CPU-tick samples after 1s idle`,
  );
  metrics.push({
    name: "service RSS lifecycle",
    observed: `ready=${fixed(memory.readyRssMiB)} MiB 1sIdle=${fixed(memory.idle1sRssMiB)} MiB postPublish=${fixed(memory.postPublishRssMiB)} MiB; PSS median=${fixed(memory.servicePssMiB.median)} MiB`,
    status: "info",
    enforced: false,
    method: "informational lifecycle points; RSS gates above remain authoritative",
  });

  console.error("perf phase: dormancy");
  await measureDormancy();

  console.error("perf phase: sse");
  const sse = await measureWarmSse();
  const sseP95 = nearestRankPercentile(sse.samplesMs, 0.95);
  measurements.sse = sse;

  // Attribution, not a budget: publish emits the SSE event only AFTER Tier 0
  // validates the bytes, and Tier 0 runs in an egress-denied netns subprocess.
  // Reporting SSE latency without this number invites "the stream is slow"
  // when the honest reading is "we validate before we announce".
  console.error("perf phase: tier0-attribution");
  const tier0 = await measureTier0Spawn();
  const tier0P95 = nearestRankPercentile(tier0.warmSamplesMs, 0.95);
  measurements.tier0Spawn = tier0;
  metrics.push({
    name: "tier-0 warm pooled p95 (attribution)",
    observed: `cold=${tier0.coldStartMs.toFixed(2)} ms warm=${tier0P95.toFixed(2)} ms`,
    status: "info",
    enforced: false,
    method: `cold start plus nearest-rank p95 of ${tier0.sampleCount} pooled calls after ${tier0.warmupCount} warmups \u2014 warm requests account for ${((tier0P95 / sseP95) * 100).toFixed(0)}% of warm SSE p95`,
  });
  addBudget(
    "publishCommitted",
    nearestRankPercentile(sse.preEmitMs, 0.95),
    " ms",
    `nearest-rank p95 of ${sse.sampleCount} validation-inclusive publishes after ${sse.warmupCount} warmups`,
  );
  addBudget(
    "sseDelivery",
    nearestRankPercentile(sse.deliveryMs, 0.95),
    " ms",
    `nearest-rank p95 from the revision event's commit timestamp to receipt on one warm stream (${sse.sampleCount} samples)`,
  );
  metrics.push({
    name: "combined publish → SSE p95 (attribution)",
    observed: `${fixed(sseP95)} ms`,
    status: "info",
    enforced: false,
    method: "not gated because validation cost would hide a stream-delivery regression",
  });

  console.error("perf phase: tsx-compile");
  const tsx = await measureTsxCompile();
  measurements.tsxCompile = tsx;
  metrics.push({
    name: "tsx compile warm p95 (record-only)",
    observed: `static=${fixed(tsx.staticWarmP95Ms)}ms interactive=${fixed(tsx.interactiveWarmP95Ms)}ms · cold static=${fixed(tsx.staticColdMs)}ms interactive=${fixed(tsx.interactiveColdMs)}ms · staticSha256=${tsx.staticSha256.slice(0, 12)}... interactiveSha256=${tsx.interactiveSha256.slice(0, 12)}... · static=${tsx.staticOutputBytes}B interactive=${tsx.interactiveOutputBytes}B`,
    status: "info",
    enforced: false,
    method: `${tsx.warmSampleCount} warm Bun.build calls per fixture after one cold each; SHA-256 of the first output seeds a determinism drift probe in future runs. Threshold intentionally record-only \u2014 the Task 1 commit decides from data, not from one hosted-runner sample.`,
  });

  // A required PR-path job must not be able to go red for a reason the author
  // could not have caused. In `ci` the browser budgets are RECORDED, never
  // enforced, so running them buys no enforcement — while the pinned runtime's
  // fd-reuse bug (oven-sh/bun#37230) wedges the CDP transport often enough to
  // fail the job on an unrelated change. Zero value, real false-red rate: skip
  // the browser phases entirely in CI and enforce them on the stable path,
  // which is the only place their budgets bind anyway.
  if (policy === "ci") {
    for (const name of [
      "publish \u2192 visible",
      "cold read-back",
      "browser exit",
      "zombie browser/profile cleanup",
    ] as const) {
      metrics.push({
        name,
        observed: "NOT RUN: browser budgets are stable-machine scope",
        status: "skipped",
        enforced: false,
        method:
          "ci policy runs host-invariant budgets only \u2014 run `perf-gate` locally to enforce these",
      });
    }
    printResults();
    writeOutputs();
    const ciFailed = metrics.some((metric) => metric.enforced && metric.status === "fail");
    process.exit(ciFailed ? 1 : 0);
  }

  console.error("perf phase: browser-probe");
  // The probe itself launches a browser, so on the pinned runtime it can die of
  // oven-sh/bun#37230 before any budget is printed — losing the four
  // browser-free phases that already completed. Measurements survive their
  // collector: a probe failure degrades to "browser budgets unmeasured", never
  // to "the run produced nothing".
  let availability: Awaited<ReturnType<typeof probeBrowserAvailability>>;
  try {
    availability = await probeBrowserAvailability();
  } catch (error) {
    availability = {
      available: false,
      reason: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  measurements.browserAvailability = availability;
  if (!availability.available) {
    const reason = availability.reason ?? "pinned browser unavailable";
    for (const name of ["publish → visible", "cold read-back", "browser exit"] as const) {
      metrics.push({
        name,
        observed: `SKIPPED: ${reason}`,
        status: "skipped",
        // Browser budgets are stable-machine scope; an unavailable browser is a
        // measurement gap, not a broken promise, so it must not fail the run
        // and silence the budgets that DID measure.
        enforced: false,
        method: "unmeasured",
      });
    }
  } else {
    try {
      console.error("perf phase: cold-readback");
      const cold = await measureColdReadBack();
      measurements.coldReadBack = cold;
      addBudget(
        "coldReadBack",
        Math.max(...cold.samplesMs),
        " ms",
        `max-of-${cold.sampleCount}; each sample publishes, then launches a fresh netns-wrapped Tier 1 browser over that immutable revision`,
      );

      // Chromium's pipe transport can inherit a just-closed launch race even
      // after the old PID/profile disappear; keep that teardown noise outside
      // the next metric instead of misclassifying it as gallery latency.
      await Bun.sleep(250);
      console.error("perf phase: publish-visible");
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
        "publishVisible",
        visibleP95,
        " ms",
        `nearest-rank p95 of ${visible.sampleCount}; median/p95/max=${fixed(visibleSummary.median)}/${fixed(visibleP95)}/${fixed(visibleSummary.max)} ms; exact revision, displayed state, and one visible opaque frame required`,
      );
      metrics.push({
        name: "publish → visible stage p95",
        observed: `commit=${fixed(stageP95.committedMs)}ms SSE=${fixed(stageP95.sseDeliveredMs)}ms handled=${fixed(stageP95.sseHandledMs)}ms frame=${fixed(stageP95.frameBuiltMs)}ms bootstrap=${fixed(stageP95.bootstrapLoadedMs)}ms bootReady=${fixed(stageP95.bootReadyMs)}ms render=${fixed(stageP95.renderCompleteMs)}ms visible=${fixed(stageP95.visibleMs)}ms frameLoad+parse=${fixed(stageP95.frameLoadAndParseMs)}ms`,
        status: "info",
        enforced: false,
        method: `${visible.sampleCount} instrumented replacements; wall-clock markers are injected into the real gallery without changing product code`,
      });

      await Bun.sleep(250);
      console.error("perf phase: browser-exit");
      const browserExit = await measureBrowserExit();
      measurements.browserExit = browserExit;
      addBudget(
        "browserExit",
        Math.max(...browserExit.samplesMs),
        " ms",
        `max-of-${browserExit.sampleCount}; fresh browser per sample, close includes PID and profile disappearance`,
      );
    } catch (error) {
      // A CDP transport wedge is a KNOWN defect of the pinned runtime
      // (oven-sh/bun#37230: killing a child spawned with stdio pipes beyond
      // fd 2 closes an fd belonging to an in-flight operation — exactly the
      // --remote-debugging-pipe shape). Verified on this host: the full
      // harness wedges 2/2 on Bun 1.3.14 and completes 1/1 clean on
      // 1.4.0-canary. Browser budgets are RECORDED, not enforced, so a wedge
      // must not take the ENFORCED browser-free budgets down with it — that
      // would make an upstream runtime bug look like a Facet regression.
      // Expect this branch to stop firing after the 1.4.0 bump; if it still
      // fires, we have a second, unknown problem.
      const detail = error instanceof Error ? error.message : String(error);
      const wedged = detail.includes("CDP transport wedged") || detail.includes("ECONNRESET");
      if (!wedged) throw error;
      for (const name of ["cold read-back", "publish \u2192 visible", "browser exit"] as const) {
        if (metrics.some((metric) => metric.name === name)) continue;
        metrics.push({
          name,
          observed: `UNMEASURED: transport wedged (oven-sh/bun#37230 on Bun 1.3.14)`,
          status: "skipped",
          enforced: false,
          method:
            "known upstream runtime defect \u2014 fixed on the 1.4.0 line; re-measure after the pin bump",
        });
      }
    }
  }

  const leaks = await waitForTier1Cleanup(leakBaseline, 2_000);
  measurements.cleanup = leaks;
  metrics.push({
    name: "zombie browser/profile cleanup",
    observed: `newPids=${leaks.pids.length} newProfiles=${leaks.profiles.length}`,
    status: leaks.pids.length === 0 && leaks.profiles.length === 0 ? "pass" : "fail",
    enforced: true,
    method: "baseline-diff after real cold-read, gallery, and browser-exit cycles",
  });

  printResults();
  writeOutputs();
  const failed = metrics.some((metric) => metric.enforced && metric.status === "fail");
  // An UNENFORCED skip must not fail the gate. Browser budgets are recorded,
  // not enforced, so a transport wedge from the known pinned-runtime defect
  // (oven-sh/bun#37230) would otherwise paint the perf job permanently red and
  // bury the enforced browser-free budgets that DID pass. An enforced skip
  // still fails: a budget we promised to enforce and then could not measure is
  // an unmet promise, not a pass.
  const skippedEnforced = metrics.some((metric) => metric.enforced && metric.status === "skipped");
  process.exit(skippedEnforced || failed ? 1 : 0);
}

await main().catch(async (error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`ERROR performance harness failed:\n${message}`);
  process.exit(1);
});
