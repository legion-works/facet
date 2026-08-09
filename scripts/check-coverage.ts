import { appendFileSync, readFileSync } from "node:fs";

export interface CoverageSummary {
  readonly lines: number;
  readonly functions: number;
}

export interface FileCoverageSummary extends CoverageSummary {
  readonly path: string;
}

export interface CoverageReport {
  readonly aggregate: CoverageSummary;
  readonly files: readonly FileCoverageSummary[];
}

export interface CoverageThresholds {
  readonly aggregate: CoverageSummary;
  readonly perFile: CoverageSummary;
}

export interface CoverageThresholdOverrides {
  readonly aggregate?: Partial<CoverageSummary>;
  readonly perFile?: Partial<CoverageSummary>;
}

export const COVERAGE_THRESHOLDS: CoverageThresholds = {
  aggregate: { lines: 90, functions: 90 },
  perFile: { lines: 70, functions: 65 },
};

interface FileCoverageObservation {
  readonly linesHit: number;
  readonly linesFound: number;
  readonly functionsHit: number;
  readonly functionsFound: number;
}

function percentage(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

function parseNumber(record: string, prefix: string): number {
  const line = record.split("\n").find((entry) => entry.startsWith(prefix));
  return line === undefined ? 0 : Number(line.slice(prefix.length));
}

export function mergeLcov(texts: readonly string[]): CoverageReport {
  const observations = new Map<string, FileCoverageObservation[]>();
  for (const text of texts) {
    for (const record of text.split("end_of_record")) {
      const source = record
        .split("\n")
        .find((line) => line.startsWith("SF:"))
        ?.slice(3);
      if (source === undefined || source.length === 0) continue;
      const lines = record.split("\n").filter((line) => line.startsWith("DA:"));
      const observation: FileCoverageObservation = {
        linesHit: lines.filter((line) => Number(line.slice(3).split(",")[1]) > 0).length,
        linesFound: lines.length,
        functionsHit: parseNumber(record, "FNH:"),
        functionsFound: parseNumber(record, "FNF:"),
      };
      observations.set(source, [...(observations.get(source) ?? []), observation]);
    }
  }

  let linesHit = 0;
  let linesFound = 0;
  let functionsHit = 0;
  let functionsFound = 0;
  const files = [...observations.entries()]
    .map(([path, fileObservations]): FileCoverageSummary => {
      // Bun's executable-line set changes between isolated processes, so LCOV
      // records are not additive. The strongest complete tier is conservative:
      // disjoint partial runs cannot manufacture coverage that no tier proved.
      const bestLines = fileObservations.toSorted(
        (left, right) =>
          percentage(right.linesHit, right.linesFound) - percentage(left.linesHit, left.linesFound),
      )[0]!;
      const bestFunctions = fileObservations.toSorted(
        (left, right) =>
          percentage(right.functionsHit, right.functionsFound) -
          percentage(left.functionsHit, left.functionsFound),
      )[0]!;
      linesHit += bestLines.linesHit;
      linesFound += bestLines.linesFound;
      functionsHit += bestFunctions.functionsHit;
      functionsFound += bestFunctions.functionsFound;
      return {
        path,
        lines: percentage(bestLines.linesHit, bestLines.linesFound),
        functions: percentage(bestFunctions.functionsHit, bestFunctions.functionsFound),
      };
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));

  return {
    aggregate: {
      lines: percentage(linesHit, linesFound),
      functions: percentage(functionsHit, functionsFound),
    },
    files,
  };
}

function resolveThresholds(overrides: CoverageThresholdOverrides): CoverageThresholds {
  return {
    aggregate: { ...COVERAGE_THRESHOLDS.aggregate, ...overrides.aggregate },
    perFile: { ...COVERAGE_THRESHOLDS.perFile, ...overrides.perFile },
  };
}

function formatMetric(name: keyof CoverageSummary, actual: number, required: number): string {
  return `${name} ${actual.toFixed(2)}%${actual < required ? " <" : " ≥"} ${required.toFixed(2)}%`;
}

function reportLines(report: CoverageReport, thresholds: CoverageThresholds): string[] {
  const aggregateFailed =
    report.aggregate.lines < thresholds.aggregate.lines ||
    report.aggregate.functions < thresholds.aggregate.functions;
  const offenders = report.files.filter(
    (file) =>
      file.lines < thresholds.perFile.lines || file.functions < thresholds.perFile.functions,
  );
  return [
    `${aggregateFailed ? "✗" : "✓"} aggregate coverage · lines ${report.aggregate.lines.toFixed(2)}% · functions ${report.aggregate.functions.toFixed(2)}% · required ${thresholds.aggregate.lines.toFixed(2)}%`,
    `${offenders.length === 0 ? "✓" : "✗"} per-file coverage · lines ≥ ${thresholds.perFile.lines.toFixed(2)}% · functions ≥ ${thresholds.perFile.functions.toFixed(2)}%`,
    ...offenders.map(
      (file) =>
        `  ${file.path} · ${formatMetric("lines", file.lines, thresholds.perFile.lines)} · ${formatMetric("functions", file.functions, thresholds.perFile.functions)}`,
    ),
  ];
}

function writeGithubSummary(lines: readonly string[]): void {
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (path === undefined) return;
  appendFileSync(path, `## Coverage\n\n${lines.join("\n\n")}\n`);
}

export function checkCoverage(
  texts: readonly string[],
  overrides: CoverageThresholdOverrides = {},
  log: (message: string) => void = console.log,
): CoverageReport {
  const thresholds = resolveThresholds(overrides);
  const report = mergeLcov(texts);
  const lines = reportLines(report, thresholds);
  log(lines.join("\n"));
  writeGithubSummary(lines);
  if (lines.some((line) => line.startsWith("✗"))) throw new Error(lines.join("\n"));
  return report;
}

if (import.meta.main) {
  try {
    const paths = process.argv.slice(2);
    checkCoverage(
      (paths.length === 0 ? ["coverage/lcov.info"] : paths).map((path) =>
        readFileSync(path, "utf8"),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
