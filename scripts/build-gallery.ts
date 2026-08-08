#!/usr/bin/env bun
/**
 * Build the gallery shell + frame bundle into static assets the service
 * can serve. Two build outputs:
 *
 *   1. `dist/gallery/app.js` — the shell controller. Loaded as a
 *      `<script type="module">` in `index.html`.
 *   2. `dist/gallery/frame/bootstrap.js` — the trusted frame bundle.
 *      Embedded into the srcdoc under a per-frame nonce by `app.ts`
 *      at runtime (the nonce is FRESH per frame, not per build).
 *
 * The build target is `browser` and minify is OFF — we want the
 * emitted bundle to be human-readable so an audit can verify no
 * artifact bytes leak into it. The `dist/` directory is gitignored.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = import.meta.dir.replace(/\/scripts$/, "");
const OUT_DIR = join(REPO_ROOT, "dist", "gallery");
const FRAME_BOOTSTRAP_ENTRY = join(REPO_ROOT, "src", "gallery-web", "frame", "bootstrap.ts");

async function buildEntry(entry: string, name: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: OUT_DIR,
    target: "browser",
    minify: false,
    naming: name,
  });
  if (!result.success) {
    const messages = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Build failed for ${entry}:\n${messages}`);
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await buildEntry(FRAME_BOOTSTRAP_ENTRY, "frame/[dir]/[name].[ext]");
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
