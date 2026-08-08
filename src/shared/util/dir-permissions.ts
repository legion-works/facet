/**
 * Owner-only directory creation.
 *
 * `mkdirSync(path, { mode: 0o700, recursive: true })` does NOT
 * guarantee a 0o700 directory chain: the mode is masked by the
 * process umask. Two failure modes matter:
 *
 *   - Non-overlapping umask (e.g. 0o022): the leaf directory lands at
 *     0o755 — group-readable. Secret-bearing screenshots leak.
 *   - Overlapping umask (e.g. 0o177): the leaf lands at 0o600 AND
 *     every intermediate directory created by `recursive: true` also
 *     loses the owner execute bit. A deeper nested mkdir cannot
 *     traverse the chain and fails with EACCES on the leaf.
 *
 * The canonical helper walks the path TOP-DOWN — from the shortest
 * ancestor to the leaf — mkdir-ing each missing segment and chmod-ing
 * it back to 0o700 before descending further. Each intermediate dir
 * gets the execute bit before the next mkdir needs to traverse it,
 * so the chain is traversable under any umask.
 *
 * Used by:
 *   - `src/service/store/evidence-retention.ts` for the evidence root
 *     and the per-run subdirectory
 *   - `src/validation/tier1/runner.ts` for the per-run evidence
 *     directory the runner captures screenshots / console summaries
 *     / protocol observations into
 *   - `src/service/security/token-store.ts` for the install-token
 *     directory
 *   - `src/service/lifecycle/process-lock.ts` for the process-lock
 *     directory
 *   - `src/service/server.ts` for the SQLite database directory
 *
 * The capability-scoped callers (service + validation) MUST go
 * through this helper so a fix lands in one place. A future
 * restrictive-umask environment cannot silently widen a secret-
 * bearing directory.
 */

import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Owner-only mode — the canonical secret-bearing layout. */
export const OWNER_ONLY_MODE = 0o700;

export function ensureOwnerOnlyDirectory(path: string): string {
  // Collect every ancestor (including `path`) that does NOT yet exist,
  // walking from the topmost ancestor down. We descend top-down so
  // each mkdir's parent already has the execute bit set.
  const missing: string[] = [];
  let cursor: string | null = path;
  while (cursor !== null && cursor.length > 0) {
    if (!existsSync(cursor)) {
      missing.push(cursor);
    }
    const parent: string = dirname(cursor);
    cursor = parent === cursor ? null : parent;
  }
  // `missing` is leaf-first; walk top-down via toReversed().
  for (const segment of missing.toReversed()) {
    mkdirSync(segment, { mode: OWNER_ONLY_MODE });
    try {
      chmodSync(segment, OWNER_ONLY_MODE);
    } catch {
      // best-effort chmod; ENOENT races with a concurrent teardown.
    }
  }
  // Best-effort parity sweep on any pre-existing directory along the
  // path (a previous service may have run under a different umask).
  cursor = path;
  while (cursor !== null && cursor.length > 0) {
    try {
      const stat = statSync(cursor);
      if ((stat.mode & 0o777) !== OWNER_ONLY_MODE) {
        try {
          chmodSync(cursor, OWNER_ONLY_MODE);
        } catch {
          // best-effort
        }
      }
    } catch {
      // ignore — best-effort parity sweep
    }
    const parent: string = dirname(cursor);
    cursor = parent === cursor ? null : parent;
  }
  return path;
}
