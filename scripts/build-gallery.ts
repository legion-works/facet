#!/usr/bin/env bun
/**
 * Build the gallery shell + type-specific frame bundles into static assets
 * the service can serve.
 *
 *   1. `dist/gallery/app.js` — the shell controller. Loaded as a
 *      `<script type="module">` in `index.html`.
 *   2. `dist/gallery/frame/runtime/<type>.js` — one trusted frame bundle
 *      per artifact type. The frame URL selects the bundle before any
 *      artifact bytes reach the renderer.
 *
 * The build target is `browser` and minify is OFF — we want the
 * emitted bundle to be human-readable so an audit can verify no
 * artifact bytes leak into it. The `dist/` directory is gitignored.
 */

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { frameBundlePlugins } from "../src/shared/build/frame-bundle-plugins";
import { ARTIFACT_TYPES } from "../src/shared/contracts/artifact-types";

const REPO_ROOT = import.meta.dir.replace(/\/scripts$/, "");
const OUT_DIR = join(REPO_ROOT, "dist", "gallery");
const FRAME_ENTRY_DIR = join(REPO_ROOT, "src", "gallery-web", "frame", "entries");
const FRAME_STYLE_DIR = join(REPO_ROOT, "src", "gallery-web", "frame", "styles");

async function buildEntry(entry: string, name: string, splitting = false): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: OUT_DIR,
    target: "browser",
    minify: false,
    splitting,
    naming: {
      entry: name,
      chunk: "frame/chunks/[name]-[hash].[ext]",
      asset: "frame/assets/[name].[ext]",
    },
    plugins: frameBundlePlugins(),
  });
  if (!result.success) {
    const messages = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Build failed for ${entry}:\n${messages}`);
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(join(OUT_DIR, "frame", "bootstrap.js"), { force: true });
  rmSync(join(OUT_DIR, "frame", "bootstrap"), { recursive: true, force: true });
  rmSync(join(OUT_DIR, "frame", "runtime"), { recursive: true, force: true });
  rmSync(join(OUT_DIR, "frame", "chunks"), { recursive: true, force: true });
  rmSync(join(OUT_DIR, "frame", "assets"), { recursive: true, force: true });
  rmSync(join(OUT_DIR, "frame", "frame.css"), { force: true });
  rmSync(join(OUT_DIR, "frame", "artifact.css"), { force: true });
  for (const artifactType of ARTIFACT_TYPES) {
    await buildEntry(
      join(FRAME_ENTRY_DIR, `${artifactType}.ts`),
      `frame/runtime/${artifactType}.[ext]`,
      true,
    );
  }
  mkdirSync(join(OUT_DIR, "frame"), { recursive: true });
  copyFileSync(join(FRAME_STYLE_DIR, "frame.css"), join(OUT_DIR, "frame", "frame.css"));
  copyFileSync(join(FRAME_STYLE_DIR, "artifact.css"), join(OUT_DIR, "frame", "artifact.css"));
  // The shell controller is bundled from index.html so the CSS imports
  // + app.ts are wired into a single bundle the service serves.
  const shellResult = await Bun.build({
    entrypoints: [join(REPO_ROOT, "src", "gallery-web", "index.html")],
    outdir: OUT_DIR,
    target: "browser",
    minify: false,
    naming: "[dir]/[name].[ext]",
  });
  if (!shellResult.success) {
    const messages = shellResult.logs.map((log) => log.message).join("\n");
    throw new Error(`Shell build failed:\n${messages}`);
  }
  process.stderr.write(`${JSON.stringify({ event: "gallery.built", outdir: OUT_DIR })}\n`);
}

if (import.meta.main) {
  await main();
}
