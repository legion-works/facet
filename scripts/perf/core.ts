export type LimitMode = "at-most" | "less-than";

export interface LeakSnapshot {
  readonly pids: ReadonlySet<number>;
  readonly profiles: ReadonlySet<string>;
}

export function nearestRankPercentile(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) throw new Error("percentile requires at least one sample");
  if (!(percentile > 0 && percentile <= 1)) throw new Error("percentile must be in (0, 1]");
  const ordered = samples.toSorted((left, right) => left - right);
  return ordered[Math.ceil(percentile * ordered.length) - 1]!;
}

export function summarize(samples: readonly number[]): {
  readonly min: number;
  readonly median: number;
  readonly max: number;
} {
  if (samples.length === 0) throw new Error("summary requires at least one sample");
  const ordered = samples.toSorted((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median =
    ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!;
  return { min: ordered[0]!, median, max: ordered[ordered.length - 1]! };
}

export function assessLimit(observed: number, limit: number, mode: LimitMode): "pass" | "fail" {
  return (mode === "at-most" ? observed <= limit : observed < limit) ? "pass" : "fail";
}

export function parseProcStatCpuTicks(text: string): number | null {
  const lastParen = text.lastIndexOf(")");
  if (lastParen < 0) return null;
  const fields = text
    .slice(lastParen + 1)
    .trim()
    .split(/\s+/);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  return Number.isFinite(userTicks) && Number.isFinite(systemTicks)
    ? userTicks + systemTicks
    : null;
}

export function diffLeakSnapshot(
  before: LeakSnapshot,
  after: LeakSnapshot,
): { readonly pids: readonly number[]; readonly profiles: readonly string[] } {
  return {
    pids: [...after.pids]
      .filter((pid) => !before.pids.has(pid))
      .toSorted((left, right) => left - right),
    profiles: [...after.profiles].filter((path) => !before.profiles.has(path)).toSorted(),
  };
}
