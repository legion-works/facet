export type PerfPolicy = "ci" | "stable" | "record";
export type EnforcementScope = "always" | "stable" | "record-only";

export const PERF_BUDGETS = {
  rssAbsolute: { name: "service RSS absolute", limit: 80, mode: "at-most", scope: "always" },
  rssDelta: {
    name: "service RSS delta over Bun floor",
    limit: 30,
    mode: "at-most",
    scope: "always",
  },
  idleCpu: { name: "service CPU idle", limit: 0.5, mode: "less-than", scope: "always" },
  // Wall-clock latency dominated by the Tier 0 netns SUBPROCESS SPAWN (~150 ms
  // of it), which is precisely what a small shared runner is worst at: measured
  // 151-159 ms on a 16-core host and 439 ms on a 2-core hosted runner. Enforcing
  // it in CI would gate Facet on runner size, so it is stable-machine-enforced
  // and recorded in CI. Contrast `sseDelivery` below — 1.00 ms on BOTH hosts,
  // because it measures in-process notification with no spawn in the path.
  publishCommitted: {
    name: "publish → revision committed p95",
    limit: 200,
    mode: "at-most",
    scope: "stable",
  },
  sseDelivery: {
    name: "revision committed → SSE delivered p95",
    limit: 25,
    mode: "at-most",
    scope: "always",
  },
  publishVisible: {
    name: "publish → visible p95",
    limit: 300,
    mode: "less-than",
    scope: "record-only",
  },
  coldReadBack: { name: "cold read-back", limit: 1_500, mode: "less-than", scope: "stable" },
  browserExit: { name: "browser exit", limit: 100, mode: "at-most", scope: "stable" },
} as const;

export type PerfBudgetKey = keyof typeof PERF_BUDGETS;

export function enforcementForPolicy(scope: EnforcementScope, policy: PerfPolicy): boolean {
  if (policy === "record" || scope === "record-only") return false;
  return scope === "always" || policy === "stable";
}
