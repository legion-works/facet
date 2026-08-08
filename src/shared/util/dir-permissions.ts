/**
 * Owner-only directory creation.
 *
 * The helper has THREE distinct semantics for THREE distinct segment
 * classes. A regression on any of them breaks either security (the
 * leaf not 0o700) or shared-tree surprise (a pre-existing ancestor
 * silently re-moded).
 *
 *   1. LEAF (the security target): ALWAYS 0o700. Created at 0o700 if
 *      missing; chmod'd to 0o700 if pre-existing at a wrong mode.
 *
 *   2. Intermediate ancestors the helper CREATES (didn't exist
 *      before this call): 0o700. The chmod-after-mkrid cycle beats
 *      an overlapping process umask (e.g. 0o177 strips the owner
 *      execute bit, breaking a deeper mkdir).
 *
 *   3. PRE-EXISTING intermediate ancestors (any dir that already
 *      existed before this call): UNTOUCHED. The helper must NEVER
 *      chmod a directory it did not create — silently re-moding a
 *      shared tree (e.g. ~/.local/state) would surprise every other
 *      app / backup sharing it.
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
 *   - `src/service/store/database.ts` for the SQLite database dir
 *
 * The capability-scoped callers (service + validation) MUST go
 * through this helper so a fix lands in one place.
 */

import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Owner-only mode — the canonical secret-bearing layout. */
export const OWNER_ONLY_MODE = 0o700;

export function ensureOwnerOnlyDirectory(path: string): string {
  // Walk leaf-up. The first existing ancestor stops the walk; it (and
  // every directory above it) is pre-existing and must NOT be touched.
  // If the leaf itself exists, mark it for the leaf-tighten pass.
  const missing: string[] = [];
  let cursor: string | null = path;
  let leafExists = false;
  while (cursor !== null && cursor.length > 0) {
    if (existsSync(cursor)) {
      if (cursor === path) leafExists = true;
      break;
    }
    missing.push(cursor);
    const parent: string = dirname(cursor);
    cursor = parent === cursor ? null : parent;
  }

  // Create missing ancestors top-down. Each newly-created segment
  // lands at 0o700 (chmod after mkdir beats an overlapping umask).
  // Pre-existing ancestors are not in `missing` — they're never
  // chmod'd by this loop.
  for (const segment of missing.toReversed()) {
    mkdirSync(segment, { mode: OWNER_ONLY_MODE });
    try {
      chmodSync(segment, OWNER_ONLY_MODE);
    } catch {
      // best-effort chmod; ENOENT races with a concurrent teardown.
    }
  }

  // LEAF enforcement. If the leaf was missing, the loop above just
  // created it at 0o700. If it pre-existed at a wrong mode, tighten it
  // now — the leaf is the security target and is always enforced.
  if (leafExists) {
    try {
      const stat = statSync(path);
      if ((stat.mode & 0o777) !== OWNER_ONLY_MODE) {
        try {
          chmodSync(path, OWNER_ONLY_MODE);
        } catch {
          // best-effort
        }
      }
    } catch {
      // ignore — best-effort leaf tightening
    }
  }

  return path;
}
