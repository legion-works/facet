/**
 * Owner-only directory creation.
 *
 * `mkdirSync(path, { mode: 0o700 })` does NOT guarantee a 0o700 directory
 * — the mode is masked by the process umask, so a hostile umask of
 * 0o022 leaves the directory at 0o755 (group-readable). The canonical
 * helper mkdirs, then stats, then chmods back to the requested mode
 * when the post-mkdir mode disagrees with the target.
 *
 * Used by:
 *   - `src/service/store/evidence-retention.ts` for the evidence root
 *     and the per-run subdirectory
 *   - `src/validation/tier1/runner.ts` for the per-run evidence
 *     directory the runner captures screenshots / console summaries
 *     / protocol observations into
 *
 * The capability-scoped callers (service + validation) MUST go
 * through this helper so a fix lands in one place. A future
 * restrictive-umask environment cannot silently widen a secret-
 * bearing directory.
 */

import { chmodSync, mkdirSync, statSync } from "node:fs";

/** Owner-only mode — the canonical secret-bearing layout. */
export const OWNER_ONLY_MODE = 0o700;

export function ensureOwnerOnlyDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: OWNER_ONLY_MODE });
  // mkdir's mode is masked by the process umask; chmod catches the
  // parity check so the canonical secret-bearing layout survives a
  // hostile umask (0o022, 0o077, etc.).
  try {
    const stat = statSync(path);
    if ((stat.mode & 0o777) !== OWNER_ONLY_MODE) {
      try {
        chmodSync(path, OWNER_ONLY_MODE);
      } catch {
        // best-effort chmod; ENOENT races with a concurrent teardown.
      }
    }
  } catch {
    // best-effort — mkdir succeeded; a stat failure here is recoverable.
  }
  return path;
}
