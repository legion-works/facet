import { readFileSync } from "node:fs";

export interface CoverageSummary {
  readonly lines: number;
  readonly functions: number;
}

function percentage(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

export function summarizeLcov(text: string): CoverageSummary {
  let linesHit = 0;
  let linesFound = 0;
  let functionsHit = 0;
  let functionsFound = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("LH:")) linesHit += Number(line.slice(3));
    else if (line.startsWith("LF:")) linesFound += Number(line.slice(3));
    else if (line.startsWith("FNH:")) functionsHit += Number(line.slice(4));
    else if (line.startsWith("FNF:")) functionsFound += Number(line.slice(4));
  }
  return {
    lines: percentage(linesHit, linesFound),
    functions: percentage(functionsHit, functionsFound),
  };
}

export function checkCoverage(text: string, threshold = 90): CoverageSummary {
  const summary = summarizeLcov(text);
  console.log(
    `aggregate coverage: lines=${summary.lines.toFixed(2)}% functions=${summary.functions.toFixed(2)}% threshold=${threshold.toFixed(2)}%`,
  );
  if (summary.lines < threshold || summary.functions < threshold) {
    throw new Error("aggregate coverage is below the configured threshold");
  }
  return summary;
}

if (import.meta.main) {
  try {
    checkCoverage(readFileSync("coverage/lcov.info", "utf8"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
