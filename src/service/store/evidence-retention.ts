/**
 * Evidence retention policy.
 *
 * One canonical knob (`EVIDENCE_LAST_N_PER_ARTIFACT`) governs how many
 * render_runs + their on-disk evidence files are kept per artifact.
 * The policy runs INSIDE the write path (`recordRenderRun` invokes
 * `enforceEvidenceRetention`) so a fresh publish can never leave the
 * state growing without bound.
 *
 * Retained-evidence carve-out: the `retained` column on `render_runs`
 * marks rows the policy must NOT delete (pinned/template revisions
 * — the call sites set the flag at the pin/template command site).
 * Cleanup walks oldest-first, skipping retained rows; the eviction
 * stops at N non-retained rows.
 *
 * On-disk evidence lives under the XDG-state evidence root (mode
 * 0700). Files referenced by `screenshot_path` and `console_path` are
 * unlinked alongside their row so a non-retained eviction leaves no
 * orphan pixels behind. Failures to unlink are best-effort — the row
 * is the authoritative state; a stale file under the 0700 root is
 * recoverable by the next orphan sweep.
 *
 * The umask-parity mkdir (mkdirSync + stat + chmodSync when the
 * post-mkdir mode disagrees with 0700) is delegated to the shared
 * `ensureOwnerOnlyDirectory` helper in `src/shared/util/dir-permissions.ts`
 * so the service and the validation runner share ONE canonical
 * implementation. A fix in one place lands in both.
 */

import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Database } from "bun:sqlite";

import { asStoreError } from "../../shared/errors/store-error";
import { ensureOwnerOnlyDirectory } from "../../shared/util/dir-permissions";

/**
 * Default retention depth per artifact. Tuned to bound the on-disk
 * evidence footprint while preserving enough recent runs to debug a
 * regression: every artifact keeps the last ten runs.
 */
export const EVIDENCE_LAST_N_PER_ARTIFACT = 10;

export interface EnforceRetentionOptions {
  readonly db: Database;
  readonly artifactId: string;
  readonly evidenceRoot: string;
  readonly limit?: number;
}

export function removeUnreferencedEvidence(
  db: Database,
  paths: readonly (string | null | undefined)[],
): void {
  const candidates = [...new Set(paths.filter((path): path is string => path != null))];
  if (candidates.length === 0) return;
  let hasCompiledPath = false;
  try {
    const pragma = db.query("PRAGMA table_info(render_runs)");
    if (typeof pragma.all === "function") {
      hasCompiledPath = (pragma.all() as Array<{ name: string }>).some(
        (column) => column.name === "compiled_path",
      );
    }
  } catch {
    hasCompiledPath = false;
  }
  const release = (): void => {
    for (const path of candidates) {
      const referenced = db
        .query(
          hasCompiledPath
            ? "SELECT 1 FROM render_runs WHERE screenshot_path = ? OR console_path = ? OR compiled_path = ? LIMIT 1"
            : "SELECT 1 FROM render_runs WHERE screenshot_path = ? OR console_path = ? LIMIT 1",
        )
        .get(...(hasCompiledPath ? [path, path, path] : [path, path]));
      if (referenced === null || referenced === undefined) unlinkEvidenceFiles(path, null);
    }
  };
  const transaction = (
    db as unknown as { transaction?: (fn: () => void) => { immediate: () => void } }
  ).transaction;
  if (transaction === undefined) release();
  else transaction.call(db, release).immediate();
}

interface RenderRunRow {
  readonly id: string;
  readonly screenshot_path: string | null;
  readonly console_path: string | null;
  readonly compiled_path: string | null;
  readonly retained: number;
}

/**
 * Enforce last-N retention for one artifact. Deletes the oldest
 * non-retained render_runs beyond `limit` AND unlinks their on-disk
 * evidence files. Retained rows are never deleted.
 *
 * Idempotent: a fresh database, or an artifact with fewer than `limit`
 * runs, is a no-op. Safe to call on every write — the query is
 * bounded and `rmSync` is best-effort.
 */
export function enforceEvidenceRetention(options: EnforceRetentionOptions): void {
  const limit = options.limit ?? EVIDENCE_LAST_N_PER_ARTIFACT;
  try {
    ensureEvidenceRoot(options.evidenceRoot);
    let hasCompiledPath = false;
    try {
      const pragma = options.db.query("PRAGMA table_info(render_runs)");
      if (typeof pragma.all === "function") {
        hasCompiledPath = (pragma.all() as Array<{ name: string }>).some(
          (column) => column.name === "compiled_path",
        );
      }
    } catch {
      hasCompiledPath = false;
    }
    const candidates = options.db
      .query(
        (hasCompiledPath
          ? "SELECT id, screenshot_path, console_path, compiled_path, retained "
          : "SELECT id, screenshot_path, console_path, retained ") +
          "FROM render_runs " +
          "WHERE revision_id IN (SELECT id FROM revisions WHERE artifact_id = ?) " +
          "AND retained = 0 " +
          "ORDER BY finished_at DESC",
      )
      .all(options.artifactId) as RenderRunRow[];
    const evictable = candidates.slice(limit);
    for (const row of evictable) {
      const evict = (): void => {
        options.db.query("DELETE FROM render_runs WHERE id = ?").run(row.id);
        removeUnreferencedEvidence(options.db, [
          row.screenshot_path,
          row.console_path,
          row.compiled_path,
        ]);
      };
      const transaction = (
        options.db as unknown as { transaction?: (fn: () => void) => { immediate: () => void } }
      ).transaction;
      if (transaction === undefined) evict();
      else transaction.call(options.db, evict).immediate();
    }
  } catch (error) {
    throw asStoreError(error);
  }
}

export interface EnsureEvidenceDirectoryOptions {
  readonly evidenceRoot: string;
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly runId: string;
}

export interface EvidenceSubpaths {
  readonly directory: string;
  readonly screenshotPath: string;
  readonly consolePath: string;
}

/**
 * Compute the canonical per-run evidence directory and ensure it
 * exists with mode 0700. Returns the deterministic paths callers
 * write to. The directory shape is:
 *
 *   <evidenceRoot>/<artifactId>/<revisionSha>/<runId>/
 *     screenshot.png
 *     console.txt
 *
 * Deterministic-by-content lets a future orphan sweep reconstruct
 * paths from the DB without a side index.
 */
export function ensureRunEvidenceDirectory(
  options: EnsureEvidenceDirectoryOptions,
): EvidenceSubpaths {
  const directory = join(
    options.evidenceRoot,
    options.artifactId,
    options.revisionSha,
    options.runId,
  );
  ensureOwnerOnlyDirectory(directory);
  return {
    directory,
    screenshotPath: join(directory, "screenshot.png"),
    consolePath: join(directory, "console.txt"),
  };
}

/**
 * Ensure the evidence directory exists with mode 0700. Idempotent —
 * a pre-existing directory is rechmodded so the canonical secret-
 * bearing layout survives every startup.
 */
export function ensureEvidenceRoot(directory: string): void {
  ensureOwnerOnlyDirectory(directory);
}

function unlinkEvidenceFiles(
  screenshotPath: string | null,
  consolePath: string | null,
  compiledPath: string | null = null,
): void {
  for (const path of [screenshotPath, consolePath, compiledPath]) {
    if (path === null) continue;
    unlinkIfExists(path);
    // Walk up parent directories that became empty after the unlink.
    let parent = dirname(path);
    while (parent.length > 1) {
      try {
        const stat = statSync(parent);
        if (!stat.isDirectory()) break;
        const entries = (require("node:fs") as typeof import("node:fs")).readdirSync(parent);
        if (entries.length > 0) break;
        rmSync(parent, { recursive: true, force: true });
      } catch {
        break;
      }
      parent = dirname(parent);
    }
  }
}

function unlinkIfExists(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    // best-effort — the row is authoritative, a stale file is recoverable
  }
}
