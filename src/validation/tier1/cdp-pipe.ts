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

import { buildBrowserArgs, resolveLauncher, type ResolvedLauncher } from "./launcher";
import {
  createEphemeralProfileDir,
  removeEphemeralProfileDir,
  type VerifierCdpSession,
  type VerifierTarget,
} from "./browser-process";

class PuppeteerCdpSessionAdapter implements VerifierCdpSession {
  constructor(private readonly inner: CDPSession) {}

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.inner.send(method as never, params as never)) as T;
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
    return Date.now();
  }

  async getFrameTree(): Promise<unknown> {
    return this.session.send("Page.getFrameTree");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.session.detach().catch(() => {});
    await this.page.close().catch(() => {});
    await this.browser.close().catch(() => {});
    removeEphemeralProfileDir(this.profileDir);
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
    const launcher = this.options.launcher ?? resolveLauncher();
    const profileDir = createEphemeralProfileDir();
    let browser: Browser | undefined;
    try {
      browser = await puppeteer.launch({
        executablePath: launcher.executablePath,
        pipe: true,
        headless: true,
        userDataDir: profileDir,
        args: buildBrowserArgs(profileDir) as string[],
      });
    } catch (error) {
      removeEphemeralProfileDir(profileDir);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`tier1: puppeteer launch failed: ${message}`, { cause: error });
    }
    let page: Page;
    try {
      page = await browser.newPage();
    } catch (error) {
      await browser.close().catch(() => {});
      removeEphemeralProfileDir(profileDir);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`tier1: failed to open page: ${message}`, { cause: error });
    }
    let session: CDPSession;
    try {
      session = await page.createCDPSession();
    } catch (error) {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      removeEphemeralProfileDir(profileDir);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`tier1: failed to open CDP session: ${message}`, { cause: error });
    }
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
      await browser.close();
      return { available: true, reason: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { available: false, reason: message };
    } finally {
      if (browser !== undefined) {
        try {
          await browser.close();
        } catch {
          // already closed
        }
      }
      removeEphemeralProfileDir(profileDir);
    }
  }
}
