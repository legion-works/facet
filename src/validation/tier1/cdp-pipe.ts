/**
 * Puppeteer-core adapter for the Tier 1 verifier.
 *
 * The verifier never imports puppeteer-core directly — it goes
 * through `Tier1Browser` (declared in `browser-process.ts`) so a
 * future raw-CDP impl can replace this module without changing the
 * runner. This file is the ONLY place puppeteer-core appears.
 *
 * CDP transport: `--remote-debugging-pipe`. Puppeteer-core with
 * `pipe: true` spawns the browser with the pipe inherited from
 * the parent and exchanges a single JSON-encoded handshake on
 * stdin/stdout to discover the page target. The verifier then
 * opens a per-page CDPSession and uses it for the protocol probes.
 *
 * The pipe transport is REQUIRED inside the netns: loopback is
 * DOWN so a TCP CDP port cannot accept connections. The
 * `scripts/launch-netns.sh` wrapper execs unshare + the pinned
 * shell, inheriting the pipe through the chain.
 */

import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import type { ChildProcess } from "node:child_process";

import { buildBrowserArgs, resolveLauncher, type ResolvedLauncher } from "./launcher";
import { TIER1_CDP_CALL_WATCHDOG_MS } from "./limits";
import {
  closeAndRemoveEphemeralProfile,
  createEphemeralProfileDir,
  removeEphemeralProfileDir,
  type VerifierCdpSession,
  type VerifierTarget,
} from "./browser-process";
import { readPidStartTimeTicks } from "../../shared/util/process";

/**
 * Typed signal for a dead CDP pipe transport: the browser process is
 * alive but every protocol call pends forever (observed when a browser
 * is spawned immediately after another browser's teardown — the new
 * child's devtools pipe is torn down out from under it). The runner
 * retries once with a fresh browser; anything else would hang the
 * verification past every barrier deadline.
 */
export class Tier1TransportWedgeError extends Error {
  constructor(where: string) {
    super(`tier1: CDP transport wedged at ${where}`);
    this.name = "Tier1TransportWedgeError";
  }
}

const TIER1_TRACE = process.env.FACET_TIER1_TRACE === "1";

function traceLaunch(stage: string, startedAt: number): void {
  if (!TIER1_TRACE) return;
  process.stderr.write(`[tier1] +${Date.now() - startedAt}ms browser:${stage}\n`);
}

async function waitForBrowserExit(child: ChildProcess | null, timeoutMs = 2_000): Promise<void> {
  if (child === null || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

async function closeBrowserAndRemoveProfile(browser: Browser, profileDir: string): Promise<void> {
  const child = browser.process();
  await closeAndRemoveEphemeralProfile(async () => {
    await browser.close().catch(() => {});
    await waitForBrowserExit(child);
  }, profileDir);
}

class PuppeteerCdpSessionAdapter implements VerifierCdpSession {
  constructor(private readonly inner: CDPSession) {}

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // Watchdog every call: a wedged pipe transport leaves the browser
    // alive but every send pending forever — the run would hang past
    // every barrier deadline because the deadline loops only advance
    // when a send resolves. A typed rejection lets the runner retry
    // with a fresh browser instead of hanging the verification.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.inner.send(method as never, params as never) as Promise<T>,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Tier1TransportWedgeError(method)),
            TIER1_CDP_CALL_WATCHDOG_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  on(event: string, listener: (params: unknown) => void): void {
    this.inner.on(event as never, listener as never);
  }

  off(event: string, listener: (params: unknown) => void): void {
    this.inner.off(event as never, listener as never);
  }

  async detach(): Promise<void> {
    try {
      await this.inner.detach();
    } catch {
      // session already torn down
    }
  }
}

class PuppeteerVerifierTarget implements VerifierTarget {
  private readonly browser: Browser;
  private readonly page: Page;
  readonly session: VerifierCdpSession;
  private readonly profileDir: string;
  private closed = false;

  constructor(browser: Browser, page: Page, session: CDPSession, profileDir: string) {
    this.browser = browser;
    this.page = page;
    this.session = new PuppeteerCdpSessionAdapter(session);
    this.profileDir = profileDir;
  }

  get pid(): number {
    const proc = this.browser.process();
    return proc?.pid ?? -1;
  }

  get startTime(): number {
    // Read the OS-recorded monotonic start time (field 22 of
    // /proc/<pid>/stat) so this record is byte-identical with the
    // canonical lock-metadata start time in
    // `service/lifecycle/process-lock.ts`. A future orphan-cleanup
    // hook that cross-references the two with `isPidAlive` and
    // start-time ticks will see the same value here as the lock
    // metadata recorded at the parent's startup. Falls back to
    // `Date.now()` only when the browser process is unreachable
    // (e.g. closed before probe); the runner treats the
    // (pid, startTime) pair as a best-effort identity key.
    const proc = this.browser.process();
    const pid = proc?.pid;
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return Date.now();
    return readPidStartTimeTicks(pid) ?? Date.now();
  }

  async getFrameTree(): Promise<unknown> {
    return this.session.send("Page.getFrameTree");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.browser.process();
    await closeAndRemoveEphemeralProfile(async () => {
      await this.session.detach().catch(() => {});
      await this.page.close().catch(() => {});
      await this.browser.close().catch(() => {});
      await waitForBrowserExit(child);
    }, this.profileDir);
  }
}

export interface PuppeteerTier1BrowserOptions {
  readonly launcher?: ResolvedLauncher;
  readonly logger?: (message: string) => void;
}

/**
 * Production Tier1Browser impl backed by puppeteer-core. Constructs
 * a fresh ephemeral profile under `os.tmpdir()` per launch, opens
 * the launcher's executable as the netns wrapper, and returns a
 * `VerifierTarget` the runner can drive.
 */
export class PuppeteerTier1Browser {
  constructor(private readonly options: PuppeteerTier1BrowserOptions = {}) {}

  async launch(): Promise<VerifierTarget> {
    const startedAt = Date.now();
    const launcher = this.options.launcher ?? resolveLauncher();
    traceLaunch("launcher-resolved", startedAt);
    const profileDir = createEphemeralProfileDir();
    traceLaunch("profile-created", startedAt);
    let browser: Browser | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gaveUp = false;
    try {
      const launchPromise = puppeteer.launch({
        executablePath: launcher.executablePath,
        pipe: true,
        headless: true,
        userDataDir: profileDir,
        // Bound the phases puppeteer's own timeout covers (spawn,
        // endpoint wait, initial page target).
        timeout: TIER1_CDP_CALL_WATCHDOG_MS,
        args: buildBrowserArgs(profileDir) as string[],
      });
      // A launch that outlives the watchdog is abandoned; should the
      // handshake settle late anyway, close the orphan immediately.
      void launchPromise.then(
        (late) => {
          if (gaveUp) void late.close().catch(() => {});
        },
        () => {},
      );
      // Separate watchdog around the WHOLE launch: with pipe transport
      // puppeteer's own timeout does not cover the spawn/handshake
      // phase, which can pend forever (observed: spawn after another
      // browser's teardown never produces a child process).
      browser = await Promise.race([
        launchPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            gaveUp = true;
            reject(new Tier1TransportWedgeError("launch handshake"));
          }, TIER1_CDP_CALL_WATCHDOG_MS);
        }),
      ]);
      traceLaunch("puppeteer-launch-complete", startedAt);
    } catch (error) {
      removeEphemeralProfileDir(profileDir);
      if (error instanceof Tier1TransportWedgeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Tier1TransportWedgeError(`launch: ${message}`);
      }
      throw new Error(`tier1: puppeteer launch failed: ${message}`, { cause: error });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    let page: Page;
    try {
      page = await browser.newPage();
      traceLaunch("page-created", startedAt);
    } catch (error) {
      await closeBrowserAndRemoveProfile(browser, profileDir);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`tier1: failed to open page: ${message}`, { cause: error });
    }
    let session: CDPSession;
    try {
      session = await page.createCDPSession();
      traceLaunch("cdp-session-created", startedAt);
    } catch (error) {
      await page.close().catch(() => {});
      await closeBrowserAndRemoveProfile(browser, profileDir);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`tier1: failed to open CDP session: ${message}`, { cause: error });
    }
    traceLaunch("ready", startedAt);
    return new PuppeteerVerifierTarget(browser, page, session, profileDir);
  }

  async probeAvailability(): Promise<{ available: boolean; reason: string | null }> {
    const launcher = this.options.launcher ?? resolveLauncher();
    let browser: Browser | undefined;
    const profileDir = createEphemeralProfileDir();
    try {
      browser = await puppeteer.launch({
        executablePath: launcher.executablePath,
        pipe: true,
        headless: true,
        userDataDir: profileDir,
        args: buildBrowserArgs(profileDir) as string[],
      });
      const page = await browser.newPage();
      await page.close();
      return { available: true, reason: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { available: false, reason: message };
    } finally {
      if (browser !== undefined) {
        await closeBrowserAndRemoveProfile(browser, profileDir);
      } else {
        removeEphemeralProfileDir(profileDir);
      }
    }
  }
}
