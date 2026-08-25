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

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { frameBundlePlugins } from "../src/shared/build/frame-bundle-plugins";
import { ARTIFACT_TYPES } from "../src/shared/contracts/artifact-types";
import { resolveGalleryRoot } from "../src/shared/config/paths";

const REPO_ROOT = import.meta.dir.replace(/\/scripts$/, "");
const FRAME_ENTRY_DIR = join(REPO_ROOT, "src", "gallery-web", "frame", "entries");
const FRAME_STYLE_DIR = join(REPO_ROOT, "src", "gallery-web", "frame", "styles");
const GALLERY_INPUTS = [
  join(REPO_ROOT, "scripts", "build-gallery.ts"),
  join(REPO_ROOT, "src", "gallery-web"),
  join(REPO_ROOT, "src", "shared", "build", "frame-bundle-plugins.ts"),
  join(REPO_ROOT, "src", "shared", "contracts", "artifact-types.ts"),
];

function latestMtime(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.mtimeMs;
  return Math.max(
    stats.mtimeMs,
    ...readdirSync(path).map((entry) => latestMtime(join(path, entry))),
  );
}

function galleryNeedsBuild(outDir: string): boolean {
  const outputPath = join(outDir, "index.html");
  try {
    return GALLERY_INPUTS.some((input) => latestMtime(input) > statSync(outputPath).mtimeMs);
  } catch {
    return true;
  }
}

/**
 * All frame entries build in ONE `Bun.build` call, not one call per
 * artifact type. Splitting still applies (plain markdown must not pay
 * Mermaid's multi-megabyte load + parse cost when it has no fence),
 * but a shared dependency — Mermaid, reached from BOTH the `mermaid`
 * and `markdown` entries — now gets ONE tree-shaking pass and ONE set
 * of lazy diagram-type chunks instead of two independently rebuilt,
 * NOT-byte-identical copies. Two separate `Bun.build` invocations per
 * entry produced two divergent tree-shakes of Mermaid's lazy-loaded
 * flowchart renderer; the copy reached through `markdown`'s dynamic
 * `import("./mermaid")` silently dropped every flowchart label while
 * the copy reached through `mermaid`'s own top-level entry did not
 * (`nodes 6 · errors 0 · ok` either way — no gate saw it). One shared
 * build graph means one shared chunk, so there is nothing left to
 * diverge.
 */
async function buildFrameEntries(entries: string[], outDir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: entries,
    outdir: outDir,
    target: "browser",
    minify: false,
    splitting: true,
    naming: {
      entry: "frame/runtime/[name].[ext]",
      chunk: "frame/chunks/[name]-[hash].[ext]",
      asset: "frame/assets/[name].[ext]",
    },
    plugins: frameBundlePlugins(),
  });
  if (!result.success) {
    const messages = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Frame entry build failed:\n${messages}`);
  }
}

async function main(): Promise<void> {
  const outDir = resolveGalleryRoot(REPO_ROOT);
  if (process.argv.includes("--if-stale") && !galleryNeedsBuild(outDir)) {
    process.stderr.write(`${JSON.stringify({ event: "gallery.current", outdir: outDir })}\n`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  rmSync(join(outDir, "frame", "bootstrap.js"), { force: true });
  rmSync(join(outDir, "frame", "bootstrap"), { recursive: true, force: true });
  rmSync(join(outDir, "frame", "runtime"), { recursive: true, force: true });
  rmSync(join(outDir, "frame", "chunks"), { recursive: true, force: true });
  rmSync(join(outDir, "frame", "assets"), { recursive: true, force: true });
  rmSync(join(outDir, "frame", "frame.css"), { force: true });
  rmSync(join(outDir, "frame", "artifact.css"), { force: true });
  await buildFrameEntries(
    ARTIFACT_TYPES.map((artifactType) => join(FRAME_ENTRY_DIR, `${artifactType}.ts`)),
    outDir,
  );
  mkdirSync(join(outDir, "frame"), { recursive: true });
  copyFileSync(join(FRAME_STYLE_DIR, "frame.css"), join(outDir, "frame", "frame.css"));
  copyFileSync(join(FRAME_STYLE_DIR, "artifact.css"), join(outDir, "frame", "artifact.css"));
  // The shell controller is bundled from index.html so the CSS imports
  // + app.ts are wired into a single bundle the service serves.
  const shellResult = await Bun.build({
    entrypoints: [join(REPO_ROOT, "src", "gallery-web", "index.html")],
    outdir: outDir,
    target: "browser",
    minify: false,
    naming: "[dir]/[name].[ext]",
  });
  if (!shellResult.success) {
    const messages = shellResult.logs.map((log) => log.message).join("\n");
    throw new Error(`Shell build failed:\n${messages}`);
  }
  process.stderr.write(`${JSON.stringify({ event: "gallery.built", outdir: outDir })}\n`);
}

if (import.meta.main) {
  await main();
}
