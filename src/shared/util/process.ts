/**
 * Canonical OS-process helpers shared by every service layer that
 * needs to detect a live pid or read its monotonic start time
 * without taking responsibility for the full lock lifecycle. The
 * lock module (`service/lifecycle/process-lock`) and the Tier 1
 * verifier (`validation/tier1/browser-process`) both import from
 * here so a single bug fix lands in one place.
 */

import { readFileSync } from "node:fs";

/**
 * Probe whether `pid` is alive. Returns true when `process.kill(pid, 0)`
 * succeeds OR returns EPERM (the pid exists but the caller cannot
 * signal it — treat as alive so we never reclaim a foreign-pid lock
 * whose ownership we cannot independently prove). False for
 * non-positive / non-integer pids, for ESRCH (pid does not exist),
 * and for any other error code (conservative: the caller decides
 * whether a non-zero non-EPERM error is "dead" or "indeterminate";
 * in practice every other kill-0 failure on Linux is ESRCH).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Read the OS-recorded process start time (clock ticks since boot,
 * field 22 of /proc/<pid>/stat) for a live pid. Returns null when
 * the pid is unreadable (non-integer, non-positive, /proc entry
 * missing, or the start-time field is non-numeric).
 *
 * The Linux start-time field is monotonic and stable across the
 * lifetime of the process, which makes it a far stronger staleness
 * signal than wall-clock time — two pids with the same start-time
 * ticks are guaranteed to be the same process. Both
 * `service/lifecycle/process-lock` (lock metadata) and
 * `validation/tier1/browser-process` (browser pid record for orphan
 * cleanup) read this same field so a future orphan-cleanup hook can
 * cross-reference the two with byte-identical semantics.
 */
export function readPidStartTimeTicks(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    // /proc/<pid>/stat: "pid (comm) state ppid ..." — the comm field
    // can contain spaces or parens, so find the LAST `)` and parse
    // from there.
    const lastParen = text.lastIndexOf(")");
    if (lastParen < 0) return null;
    const after = text.slice(lastParen + 1).trimStart();
    const fields = after.split(/\s+/);
    // field index 21 (0-based after the comm close) is starttime.
    const startTime = Number(fields[21]);
    if (!Number.isFinite(startTime)) return null;
    return startTime;
  } catch {
    return null;
  }
}
