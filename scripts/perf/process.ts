import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { isPidAlive } from "../../src/shared/util/process";
import { diffLeakSnapshot, parseProcStatCpuTicks, type LeakSnapshot } from "./core";

const BUN_PATH = process.env.FACET_PERF_BUN ?? process.execPath;

export interface BareBunFloor {
  readonly pid: number;
  readonly home: string;
}

function readKbMetric(text: string, key: string): number | null {
  const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
  return match?.[1] === undefined ? null : Number(match[1]) * 1024;
}

export function sampleProcessMemory(pid: number): {
  readonly rssBytes: number | null;
  readonly pssBytes: number | null;
} {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
  return { rssBytes: readKbMetric(status, "VmRSS"), pssBytes: readKbMetric(rollup, "Pss") };
}

function readCpuTicks(pid: number): number {
  const ticks = parseProcStatCpuTicks(readFileSync(`/proc/${pid}/stat`, "utf8"));
  if (ticks === null) throw new Error(`cannot read CPU ticks for pid ${pid}`);
  return ticks;
}

export async function sampleProcessCpuPercent(pid: number, sampleMs: number): Promise<number> {
  const tickRateResult = Bun.spawnSync(["getconf", "CLK_TCK"]);
  if (tickRateResult.exitCode !== 0) throw new Error("getconf CLK_TCK failed");
  const ticksPerSecond = Number(new TextDecoder().decode(tickRateResult.stdout).trim());
  if (!(ticksPerSecond > 0)) throw new Error("getconf CLK_TCK returned an invalid rate");
  const startTicks = readCpuTicks(pid);
  const startedAt = performance.now();
  await Bun.sleep(sampleMs);
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  return ((readCpuTicks(pid) - startTicks) / ticksPerSecond / elapsedSeconds) * 100;
}

export function snapshotTier1Leaks(): LeakSnapshot {
  const pids = new Set<number>();
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
      if (command.includes("chrome-headless-shell") || command.includes("facet-tier1-")) {
        pids.add(pid);
      }
    } catch {
      // A process may exit between directory enumeration and cmdline read.
    }
  }
  const profiles = new Set(
    readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("facet-tier1-"))
      .map((entry) => join(tmpdir(), entry.name)),
  );
  return { pids, profiles };
}

export async function waitForTier1Cleanup(
  baseline: LeakSnapshot,
  timeoutMs: number,
): Promise<ReturnType<typeof diffLeakSnapshot>> {
  const deadline = Date.now() + timeoutMs;
  let leaked = diffLeakSnapshot(baseline, snapshotTier1Leaks());
  while ((leaked.pids.length > 0 || leaked.profiles.length > 0) && Date.now() < deadline) {
    await Bun.sleep(25);
    leaked = diffLeakSnapshot(baseline, snapshotTier1Leaks());
  }
  return leaked;
}

export async function startBareBunFloor(): Promise<BareBunFloor> {
  const home = mkdtempSync(join(tmpdir(), "facet-bun-floor-"));
  const entrypoint = join(home, "server.ts");
  writeFileSync(
    entrypoint,
    `const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });\n` +
      `process.on("SIGTERM", () => { server.stop(true); process.exit(0); });\n`,
    { mode: 0o600 },
  );
  const child = spawn(BUN_PATH, [entrypoint], { detached: true, stdio: "ignore" });
  child.unref();
  if (child.pid === undefined) throw new Error("bare Bun floor did not produce a pid");
  return { pid: child.pid, home };
}

export async function stopProcess(pid: number): Promise<void> {
  if (!isPidAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  let deadline = Date.now() + 2_000;
  while (isPidAlive(pid) && Date.now() < deadline) await Bun.sleep(25);
  if (!isPidAlive(pid)) return;
  process.kill(pid, "SIGKILL");
  deadline = Date.now() + 2_000;
  while (isPidAlive(pid) && Date.now() < deadline) await Bun.sleep(25);
  if (isPidAlive(pid)) throw new Error(`process ${pid} survived SIGKILL`);
}

export async function stopBareBunFloor(floor: BareBunFloor): Promise<void> {
  try {
    await stopProcess(floor.pid);
  } finally {
    removeBareBunFloor(floor);
  }
}

export function removeBareBunFloor(floor: BareBunFloor): void {
  rmSync(floor.home, { recursive: true, force: true });
}
