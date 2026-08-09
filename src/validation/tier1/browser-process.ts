/**
 * Browser-process lifecycle for the Tier 1 verifier.
 *
 * The interface intentionally exposes only what the verifier needs
 * (open a target, drive CDP, close) so a future raw-CDP impl can
 * replace the puppeteer-core adapter without changing any caller.
 *
 * The ephemeral user-data-dir (mode 0700, removed in `finally`)
 * makes the on-disk footprint zero between runs. The orphan
 * cleanup helper registers the (pid, startTime) so a parent that
 * crashes before the finally block can still reap the tmpdir.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetError } from "../../shared/errors/facet-error";

import { TIER1_USER_DATA_DIR_MODE } from "./limits";
import { resolveLauncher, type ResolvedLauncher } from "./launcher";

const TIER1_TRACE = process.env.FACET_TIER1_TRACE === "1";

/**
 * Minimal CDP session surface the verifier uses. Puppeteer-core's
 * `CDPSession` satisfies this shape; a raw-CDP impl can too.
 */
export interface VerifierCdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  detach(): Promise<void>;
}

export interface VerifierTarget {
  /** The browser-level CDP session (page-level for puppeteer-core). */
  readonly session: VerifierCdpSession;
  /**
   * Frame-tree snapshot — every CDP `Page` call that depends on the
   * frame tree reads from here so the verifier's "resolve child
   * frame" step has a stable input.
   */
  getFrameTree(): Promise<unknown>;
  /**
   * Tear down the browser. The implementation MUST close the CDP
   * session, signal the browser, reap the tmpdir, and remove any
   * orphan-cleanup registration.
   */
  close(): Promise<void>;
  /** Browser pid — the orphan cleanup key. */
  readonly pid: number;
  readonly startTime: number;
}

/**
 * Build a fresh ephemeral user-data directory under `os.tmpdir()`. The
 * returned path is mode 0700 (matches `TIER1_USER_DATA_DIR_MODE`); the
 * caller MUST `rm -rf` it (via the verifier's `finally` block).
 */
export function createEphemeralProfileDir(): string {
  const base = tmpdir();
  const dir = mkdtempSync(join(base, "facet-tier1-"));
  try {
    chmodSync(dir, TIER1_USER_DATA_DIR_MODE);
  } catch {
    // best-effort; chmod may fail under restrictive umask
  }
  return dir;
}

/** Remove the ephemeral profile directory; best-effort. */
export function removeEphemeralProfileDir(path: string): void {
  const startedAt = performance.now();
  if (TIER1_TRACE) process.stderr.write(`[tier1] browser-profile-remove:start path=${path}\n`);
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best-effort
  } finally {
    if (TIER1_TRACE) {
      process.stderr.write(
        `[tier1] browser-profile-remove:complete durationMs=${Math.round(performance.now() - startedAt)} path=${path}\n`,
      );
    }
  }
}

export async function closeAndRemoveEphemeralProfile(
  close: () => Promise<void>,
  profileDir: string,
  timeoutMs = 2_000,
): Promise<void> {
  try {
    await Promise.race([close(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  } finally {
    removeEphemeralProfileDir(profileDir);
  }
}

/**
 * Detect whether the launcher wrapper + pinned shell are reachable.
 * Bounded by a 2s timeout so a hung unshare does not freeze the
 * verifier; the verdict path runs this once per cold-start.
 */
export async function probeLauncherAvailability(
  overrides: { readonly version?: string } = {},
): Promise<{ available: boolean; reason: string | null }> {
  let launcher: ResolvedLauncher;
  try {
    launcher = resolveLauncher(
      overrides.version !== undefined ? { version: overrides.version } : {},
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, reason: message };
  }
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(launcher.executablePath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      resolve({ available: false, reason: "launcher probe timed out" });
    }, 2_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ available: true, reason: null });
        return;
      }
      resolve({ available: false, reason: `launcher exited with code ${code ?? "null"}` });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ available: false, reason: `launcher spawn failed: ${error.message}` });
    });
  });
}

void FacetError;
