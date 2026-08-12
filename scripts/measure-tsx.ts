#!/usr/bin/env bun
/**
 * Compiler comparison harness for the TSX arc.
 *
 * Per Task 1 of the plan, this script produces the table that decides between
 * Option A (Bun.build) and Option B (esbuild). It runs the SAME static and
 * interactive TSX inputs through each candidate 20 warm times across THREE
 * fresh worker processes and records:
 *
 *   - the byte hash of the produced JS bundle (one per run);
 *   - cold p50 / p95 wall-clock (the first compile in a process);
 *   - warm p50 / p95 wall-clock (subsequent compiles in the same process);
 *   - output size (bytes);
 *   - the set of module specifiers that actually resolved during the build;
 *   - any diagnostics emitted by the bundler.
 *
 * Determinism is the load-bearing premise: same source MUST compile to the
 * same bytes across runs within a process AND across fresh process lifetimes,
 * or revision hashing and every downstream comparison break.
 *
 * Usage:
 *   bun scripts/measure-tsx.ts                # one-shot, single process
 *   bun scripts/measure-tsx.ts --phase warm   # only the warm-in-one-process phase
 *   bun scripts/measure-tsx.ts --phase fresh  # only the three-fresh-processes phase
 *
 * The script emits JSON to stdout and a human-readable table to stderr.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  STATIC_SOURCE_PATH,
  INTERACTIVE_SOURCE_PATH,
  EMPTY_SOURCE_PATH,
} from "./measure-tsx-fixtures";

/**
 * Optional esbuild dependency — only present when the A-vs-B decision is
 * still open. Once Option A is locked in, esbuild is removed from
 * package.json and this probe degrades to a no-op so the historical
 * measurement script still loads cleanly for future audits.
 */
type EsbuildLike = {
  build: (options: Record<string, unknown>) => Promise<{
    metafile?: { inputs?: Record<string, unknown> };
    outputFiles?: { text: string }[];
    warnings?: { text: string }[];
  }>;
};

const ESBUILD_ENABLED = await probeEsbuild();

async function probeEsbuild(): Promise<boolean> {
  try {
    // Use an indirect specifier so TypeScript cannot statically resolve the
    // optional dependency and a missing esbuild install does not break typecheck.
    const moduleName = "esbuild";
    const mod = (await import(moduleName)) as { build?: unknown };
    return typeof mod.build === "function";
  } catch {
    return false;
  }
}

interface RunRecord {
  readonly candidate: "bun" | "esbuild";
  readonly source: "static" | "interactive" | "empty";
  readonly runIndex: number;
  readonly cold: boolean;
  readonly durationMs: number;
  readonly outputBytes: number;
  readonly sha256: string;
  readonly resolvedModules: readonly string[];
  readonly diagnostics: readonly string[];
}

interface PhaseResult {
  readonly candidate: "bun" | "esbuild";
  readonly source: "static" | "interactive" | "empty";
  readonly coldMs: number;
  readonly coldP50: number;
  readonly coldP95: number;
  readonly warmMs: readonly number[];
  readonly warmP50: number;
  readonly warmP95: number;
  readonly outputBytes: number;
  readonly sha256: string;
  readonly resolvedModules: readonly string[];
  readonly diagnostics: readonly string[];
  readonly allHashesIdentical: boolean;
  readonly distinctHashes: readonly string[];
}

const WARM_COUNT = 20;

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  // nearest-rank — matches the perf-gate convention in scripts/perf-gate.ts.
  const rank = Math.max(1, Math.ceil(sorted.length * fraction));
  const index = Math.min(sorted.length, rank) - 1;
  return sorted[index] ?? 0;
}

function summarize(samples: readonly number[]): {
  readonly sorted: readonly number[];
  readonly p50: number;
  readonly p95: number;
} {
  const sorted = [...samples].toSorted((a, b) => a - b);
  return { sorted, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface BunBuildOutput {
  readonly contents: string;
  readonly resolved: readonly string[];
  readonly diagnostics: readonly string[];
}

/**
 * Compile one TSX source through Bun.build with deterministic-friendly options:
 *   - one output file (splitting=false) so no chunk hash appears in the path;
 *   - in-memory contents (no temp files);
 *   - explicit entry path so Bun does not synthesize a virtual name;
 *   - named exports preserved (no minification or tree-shaking noise).
 *
 * `metafile.inputs` keys are the resolved modules. They include absolute
 * filesystem paths, so we surface the basename of each plus the substring
 * after `/node_modules/` to show what actually came from the vendored set.
 */
async function compileViaBun(source: string, entry: string): Promise<BunBuildOutput> {
  // Bun.build over an inline source path works because Bun treats the literal
  // as a virtual file. `entrypoints` accepts the inline name and Bun resolves
  // imports against the current working directory and node_modules.
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: false,
    splitting: false,
    metafile: true,
    naming: "[dir]/[name].[ext]",
    sourcemap: "none",
    external: [],
    throw: false,
  });
  const diagnostics = result.logs.map((log) => log.message);
  if (!result.success || result.outputs.length === 0) {
    return { contents: "", resolved: [], diagnostics };
  }
  const output = result.outputs[0]!;
  const contents = new TextDecoder().decode(await output.arrayBuffer());
  const inputKeys = Object.keys(result.metafile?.inputs ?? {});
  return {
    contents,
    resolved: inputKeys,
    diagnostics,
  };
}

interface EsbuildOutput {
  readonly contents: string;
  readonly resolved: readonly string[];
  readonly diagnostics: readonly string[];
}

async function compileViaEsbuild(source: string, entry: string): Promise<EsbuildOutput> {
  // esbuild needs build() to expose a metafile AND resolve real modules
  // against node_modules. transform() is byte-only — no resolution graph.
  // We pass the fixture path as the entrypoint so the import resolution
  // path is the same one a real TSX compilation would take.
  void source;
  const esbuildModuleName = "esbuild";
  const esbuildMod = (await import(esbuildModuleName)) as unknown as EsbuildLike;
  const result = await esbuildMod.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "react",
    treeShaking: false,
    minify: false,
    sourcemap: false,
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  const inputKeys = Object.keys(result.metafile?.inputs ?? {});
  const outputs = result.outputFiles ?? [];
  const firstOutput = outputs[0];
  const contents = firstOutput === undefined ? "" : firstOutput.text;
  return {
    contents,
    resolved: inputKeys,
    diagnostics: (result.warnings ?? []).map((w) => w.text),
  };
}

async function runPhase(
  candidate: "bun" | "esbuild",
  sourceKey: "static" | "interactive" | "empty",
  sourceText: string,
  entryName: string,
): Promise<PhaseResult | null> {
  if (candidate === "esbuild" && !ESBUILD_ENABLED) {
    return null;
  }
  const records: RunRecord[] = [];
  let outputBytes = 0;
  let coldMs = 0;
  for (let index = 0; index <= WARM_COUNT; index += 1) {
    const isCold = index === 0;
    const start = performance.now();
    const output =
      candidate === "bun"
        ? await compileViaBun(sourceText, entryName)
        : await compileViaEsbuild(sourceText, entryName);
    const durationMs = performance.now() - start;
    const bytes = new TextEncoder().encode(output.contents);
    const sha = hash(bytes);
    outputBytes = bytes.byteLength;
    if (isCold) coldMs = durationMs;
    records.push({
      candidate,
      source: sourceKey,
      runIndex: index,
      cold: isCold,
      durationMs,
      outputBytes,
      sha256: sha,
      resolvedModules: output.resolved,
      diagnostics: output.diagnostics,
    });
  }
  const warm = summarize(records.filter((r) => !r.cold).map((r) => r.durationMs));
  const distinctHashes = [...new Set(records.map((r) => r.sha256))];
  const allHashesIdentical = distinctHashes.length === 1;
  const lastRecord = records[records.length - 1]!;
  return {
    candidate,
    source: sourceKey,
    coldMs,
    coldP50: coldMs, // single cold sample per process — treat as p50
    coldP95: coldMs,
    warmMs: warm.sorted,
    warmP50: warm.p50,
    warmP95: warm.p95,
    outputBytes,
    sha256: lastRecord.sha256,
    resolvedModules: lastRecord.resolvedModules,
    diagnostics: lastRecord.diagnostics,
    allHashesIdentical,
    distinctHashes,
  };
}

function asTableRow(result: PhaseResult): string {
  const cold = `${result.coldMs.toFixed(2)}`;
  const warm = `${result.warmP50.toFixed(2)}/${result.warmP95.toFixed(2)}`;
  const bytes = `${result.outputBytes}B`;
  const hashes = result.allHashesIdentical
    ? "identical"
    : `${result.distinctHashes.length} distinct`;
  const modules = result.resolvedModules.length === 0 ? "0" : `${result.resolvedModules.length}`;
  const diag = result.diagnostics.length === 0 ? "0" : `${result.diagnostics.length}`;
  return `${result.candidate.padEnd(7)} ${result.source.padEnd(11)} cold=${cold}ms warm=${warm}ms bytes=${bytes} hashes=${hashes} resolved=${modules} diag=${diag}`;
}

interface ProcessReport {
  readonly phaseLabel: string;
  readonly results: readonly PhaseResult[];
}

async function runOneProcess(phaseLabel: string): Promise<ProcessReport> {
  const staticSource = readFileSync(STATIC_SOURCE_PATH, "utf8");
  const interactiveSource = readFileSync(INTERACTIVE_SOURCE_PATH, "utf8");
  const emptySource = readFileSync(EMPTY_SOURCE_PATH, "utf8");
  const results: PhaseResult[] = [];
  for (const candidate of ["bun", "esbuild"] as const) {
    for (const target of [
      { key: "static", text: staticSource, entry: STATIC_SOURCE_PATH },
      { key: "interactive", text: interactiveSource, entry: INTERACTIVE_SOURCE_PATH },
      { key: "empty", text: emptySource, entry: EMPTY_SOURCE_PATH },
    ] as const) {
      const result = await runPhase(candidate, target.key, target.text, target.entry);
      if (result !== null) results.push(result);
    }
  }
  return { phaseLabel, results };
}

interface CrossProcessReport {
  readonly phaseLabel: string;
  readonly processResults: readonly ProcessReport[];
  readonly identicalAcrossProcesses: boolean;
  readonly distinctCrossProcessHashes: readonly string[];
  readonly crossProcessMismatches: readonly string[];
}

async function runFreshProcesses(count: number): Promise<CrossProcessReport> {
  // We can't restart OUR process, so we run three separate Bun subprocesses
  // — each with `--phase fresh` — and aggregate. The orchestrator decides
  // whether the source bytes are stable across process lifetimes.
  const subprocesses: ProcessReport[] = [];
  for (let i = 0; i < count; i += 1) {
    const label = `fresh-process-${i + 1}`;
    const proc = Bun.spawn({
      cmd: [process.execPath, "scripts/measure-tsx.ts", "--phase", "fresh", "--label", label],
      cwd: process.cwd(),
      env: { ...process.env, FACET_MEASURE_LABEL: label },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`measure-tsx subprocess exited ${exitCode}`);
    subprocesses.push(JSON.parse(stdout) as ProcessReport);
  }
  // Compare each (candidate, source) slot across the N subprocesses. Each
  // slot must hash to the same value in every process or we report a
  // mismatch keyed by slot.
  const slotHashes = new Map<string, Set<string>>();
  for (const report of subprocesses) {
    for (const result of report.results) {
      const key = `${result.candidate}/${result.source}`;
      const set = slotHashes.get(key) ?? new Set<string>();
      set.add(result.sha256);
      slotHashes.set(key, set);
    }
  }
  const mismatches: string[] = [];
  for (const [slot, hashes] of slotHashes) {
    if (hashes.size > 1) mismatches.push(`${slot}: ${[...hashes].join(", ")}`);
  }
  const allHashes = new Set<string>();
  for (const report of subprocesses) {
    for (const result of report.results) allHashes.add(result.sha256);
  }
  return {
    phaseLabel: `fresh-processes-${count}`,
    processResults: subprocesses,
    identicalAcrossProcesses: mismatches.length === 0,
    distinctCrossProcessHashes: [...allHashes],
    crossProcessMismatches: mismatches,
  };
}

function printTable(reports: readonly ProcessReport[]): void {
  console.error(
    "compiler  source      cold(ms)   warm p50/p95 (ms)        bytes   hashes   resolved   diag",
  );
  console.error(
    "--------  ----------- ---------- ------------------------ ------- -------- ---------- ----",
  );
  for (const report of reports) {
    for (const result of report.results) console.error(asTableRow(result));
    console.error("");
  }
}

async function main(): Promise<void> {
  const phase = process.argv.includes("--phase")
    ? (process.argv[process.argv.indexOf("--phase") + 1] ?? "all")
    : "all";

  if (phase === "fresh") {
    const label = process.env.FACET_MEASURE_LABEL ?? "fresh";
    const report = await runOneProcess(label);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  const warmReport = await runOneProcess("warm-in-one-process");
  const freshReport = await runFreshProcesses(3);

  process.stderr.write("=== WARM-IN-ONE-PROCESS ===\n");
  printTable(warmReport.results.length > 0 ? [warmReport] : []);
  process.stderr.write("\n=== FRESH-PROCESSES (3 lifetimes) ===\n");
  for (const sub of freshReport.processResults) {
    process.stderr.write(`-- ${sub.phaseLabel} --\n`);
    printTable([sub]);
  }
  process.stderr.write(
    `cross-process hashes identical: ${freshReport.identicalAcrossProcesses} (${freshReport.distinctCrossProcessHashes.length} distinct across all process lifetimes; mismatches=${freshReport.crossProcessMismatches.length})\n`,
  );
  for (const mismatch of freshReport.crossProcessMismatches) {
    process.stderr.write(`  CROSS-PROCESS MISMATCH: ${mismatch}\n`);
  }

  process.stdout.write(`${JSON.stringify({ warmReport, freshReport }, null, 2)}\n`);
}

await main();
