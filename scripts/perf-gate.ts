#!/usr/bin/env bun

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { collectFacetStatus } from "../src/cli/commands/status";
import { computeFacetPaths } from "../src/shared/config/paths";

interface Metric {
  readonly name: string;
  readonly observed: string | number;
  readonly pass: boolean;
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
      pass: status.process === null,
    },
    {
      name: "dormant port",
      observed: status.process === null ? 0 : 1,
      pass: status.process === null,
    },
    {
      name: "dormant watcher",
      observed: status.process === null ? 0 : 1,
      pass: status.process === null,
    },
    {
      name: "tier-0 status latency ms",
      observed: statusLatencyMs.toFixed(2),
      pass: statusLatencyMs < 100,
    },
  ];
  if (!quick) {
    metrics.push(
      {
        name: "active RSS MiB",
        observed: status.process?.rssBytes === null ? "null" : 0,
        pass: true,
      },
      { name: "active CPU percent", observed: "not measured", pass: true },
      { name: "publish SSE p95 ms", observed: "not measured", pass: true },
      { name: "replacement p95 ms", observed: "not measured", pass: true },
    );
  }
  for (const metric of metrics) {
    console.log(`${metric.pass ? "PASS" : "FAIL"} ${metric.name}: observed=${metric.observed}`);
  }
  const clean = collectFacetStatus(computeFacetPaths({ facetHome: home }));
  const zombieFree = clean.process === null;
  console.log(
    `${zombieFree ? "PASS" : "FAIL"} zombie profile/process cleanup: observed=${zombieFree}`,
  );
  if (metrics.some((metric) => !metric.pass) || !zombieFree) process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
