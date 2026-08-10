#!/usr/bin/env bun

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HTML_STYLE_CLASSES } from "../src/shared/html/style-vocabulary";

const REPO_ROOT = import.meta.dir.replace(/\/scripts$/, "");
const SOURCE_PATH = join(REPO_ROOT, "src/gallery-web/frame/styles/html-source.css");
const OUTPUT_PATH = join(REPO_ROOT, "src/gallery-web/frame/styles/html-vendored.css");
const STYLES_DIR = join(REPO_ROOT, "src/gallery-web/frame/styles");
const TAILWIND_CLI = join(REPO_ROOT, "node_modules/@tailwindcss/cli/dist/index.mjs");

function cssSourceFor(corpusPath: string, css: string): string {
  return `${css}\n@source ${JSON.stringify(corpusPath)};\n`;
}

async function buildStyles(destination: string): Promise<void> {
  const directory = await mkdtemp(join(STYLES_DIR, ".facet-html-styles-"));
  try {
    const corpusPath = join(directory, "classes.html");
    const inputPath = join(directory, "input.css");
    await writeFile(corpusPath, `<main class="${HTML_STYLE_CLASSES.join(" ")}"></main>\n`);
    await writeFile(inputPath, cssSourceFor(corpusPath, await readFile(SOURCE_PATH, "utf8")));
    const child = Bun.spawn([process.execPath, TAILWIND_CLI, "-i", inputPath, "-o", destination], {
      cwd: REPO_ROOT,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(`Tailwind CSS build failed: ${stderr}`);
    const formatter = Bun.spawn(["oxfmt", destination], { cwd: REPO_ROOT, stderr: "pipe" });
    const [formatExitCode, formatStderr] = await Promise.all([
      formatter.exited,
      new Response(formatter.stderr).text(),
    ]);
    if (formatExitCode !== 0) throw new Error(`CSS formatting failed: ${formatStderr}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const directory = await mkdtemp(join(STYLES_DIR, ".facet-html-styles-check-"));
    try {
      const candidate = join(directory, "html-vendored.css");
      await buildStyles(candidate);
      const [actual, expected] = await Promise.all([readFile(candidate), readFile(OUTPUT_PATH)]);
      if (!actual.equals(expected))
        throw new Error("html-vendored.css is stale; run bun scripts/build-html-styles.ts");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return;
  }
  await buildStyles(OUTPUT_PATH);
}

await main();
