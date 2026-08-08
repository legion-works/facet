/**
 * Canonical OS-process helpers shared by every service layer that
 * needs to detect a live pid without taking responsibility for the
 * full lock lifecycle. The lock module (`service/lifecycle/process-lock`)
 * and the Tier 1 verifier (`validation/tier1/browser-process`) both
 * import from here so a single bug fix lands in one place.
 */

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
