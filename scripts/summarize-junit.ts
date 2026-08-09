import { appendFileSync, readFileSync } from "node:fs";

export interface JunitSummary {
  readonly tests: number;
  readonly passed: number;
  readonly failures: number;
  readonly skipped: number;
  readonly failingTests: readonly string[];
}

function attribute(text: string, name: string): string | undefined {
  return text.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function decodeXml(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function parseJunit(xml: string): JunitSummary {
  const root = xml.match(/<testsuites\b([^>]*)>/)?.[1];
  if (root === undefined) throw new Error("JUnit report has no testsuites root");
  const tests = Number(attribute(root, "tests") ?? 0);
  const failures = Number(attribute(root, "failures") ?? 0);
  const skipped = Number(attribute(root, "skipped") ?? 0);
  const failingTests: string[] = [];
  const cases = xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g);
  for (const match of cases) {
    if (!match[2]?.includes("<failure")) continue;
    const attributes = match[1] ?? "";
    const name = decodeXml(attribute(attributes, "name") ?? "unnamed test");
    const suite = decodeXml(attribute(attributes, "classname") ?? "unknown suite");
    const file = attribute(attributes, "file");
    const line = attribute(attributes, "line");
    const location = file === undefined ? "" : ` (${file}${line === undefined ? "" : `:${line}`})`;
    failingTests.push(`${suite} › ${name}${location}`);
  }
  return { tests, passed: tests - failures - skipped, failures, skipped, failingTests };
}

export function formatJunitSummary(label: string, summary: JunitSummary): string {
  const verdict = summary.failures === 0 ? "✓" : "✗";
  const lines = [
    `## ${label} tests`,
    "",
    `${verdict} ${summary.passed} passed · ${summary.skipped} skipped · ${summary.failures} failed`,
  ];
  if (summary.failingTests.length > 0) {
    lines.push("", "Failures:", ...summary.failingTests.map((name) => `- ${name}`));
  }
  return `${lines.join("\n")}\n`;
}

function writeSummary(label: string, summary: JunitSummary): void {
  const output = formatJunitSummary(label, summary);
  console.log(output.trimEnd());
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (path !== undefined) appendFileSync(path, output);
}

if (import.meta.main) {
  const [path, label = "test"] = process.argv.slice(2);
  if (path === undefined)
    throw new Error("usage: bun scripts/summarize-junit.ts <report.xml> [label]");
  try {
    writeSummary(label, parseJunit(readFileSync(path, "utf8")));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output = `## ${label} tests\n\n✗ Results unavailable · ${message}\n`;
    console.error(message);
    const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
    if (summaryPath !== undefined) appendFileSync(summaryPath, output);
  }
}
