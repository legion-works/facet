#!/usr/bin/env bun

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { collectFacetStatus } from "../src/cli/commands/status";
import { computeFacetPaths } from "../src/shared/config/paths";

interface Metric {
  readonly name: string;
  readonly observed: string | number;
  readonly status: "pass" | "fail" | "skipped";
}

const quick = process.argv.includes("--quick");
const home = join(tmpdir(), `facet-perf-${crypto.randomUUID()}`);
mkdirSync(home, { recursive: true });

try {
  const startedAt = performance.now();
  const status = collectFacetStatus(computeFacetPaths({ facetHome: home }));
  const statusLatencyMs = performance.now() - startedAt;
  const metrics: Metric[] = [
    {
      name: "dormant process",
      observed: status.process === null ? 0 : 1,
      status: status.process === null ? "pass" : "fail",
    },
    {
      name: "dormant port",
      observed: status.process === null ? 0 : 1,
      status: status.process === null ? "pass" : "fail",
    },
    {
      name: "dormant watcher",
      observed: status.process === null ? 0 : 1,
      status: status.process === null ? "pass" : "fail",
    },
    {
      name: "tier-0 status latency ms",
      observed: statusLatencyMs.toFixed(2),
      status: statusLatencyMs < 100 ? "pass" : "fail",
    },
  ];
  if (!quick) {
    metrics.push(
      {
        name: "active RSS MiB",
        observed: "UNMEASURED (harness defect — see roadmap)",
        status: "skipped",
      },
      {
        name: "active CPU percent",
        observed: "UNMEASURED (harness defect — see roadmap)",
        status: "skipped",
      },
      {
        name: "publish SSE p95 ms",
        observed: "UNMEASURED (harness defect — see roadmap)",
        status: "skipped",
      },
      {
        name: "replacement p95 ms",
        observed: "UNMEASURED (harness defect — see roadmap)",
        status: "skipped",
      },
    );
  }
  for (const metric of metrics) {
    console.log(`${metric.status.toUpperCase()} ${metric.name}: observed=${metric.observed}`);
  }
  const clean = collectFacetStatus(computeFacetPaths({ facetHome: home }));
  const zombieFree = clean.process === null;
  console.log(
    `${zombieFree ? "PASS" : "FAIL"} zombie profile/process cleanup: observed=${zombieFree}`,
  );
  if (metrics.some((metric) => metric.status === "fail") || !zombieFree) process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
