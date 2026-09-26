import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

import {
  PuppeteerTier1Browser,
  Tier1TransportWedgeError,
} from "../../src/validation/tier1/cdp-pipe";
import { createTier1RunnerForTests } from "../../src/validation/tier1/runner";
import { readPidStartTimeTicks } from "../../src/shared/util/process";
import { TIER1_TEARDOWN_TIMEOUT_MS } from "../../src/validation/tier1/limits";

const launcher = {
  executablePath: "/bin/true",
  binaryPath: "/bin/true",
  pinnedVersion: "test",
};

const input = {
  artifactType: "markdown" as const,
  renderer: "svg" as const,
  revisionSha: "0".repeat(64),
  source: new TextEncoder().encode("# browser retry") as Uint8Array<ArrayBuffer>,
  lexical: {
    rendererRootSvgCount: 0,
    mermaidNodeCount: 0,
    visibleSvgCount: 0,
    opaqueRegionCount: 0,
    externalImageCount: 0,
  },
  launcherVersion: "test-only",
  networkNamespace: "test-only",
};

test("preserves a bad-file-descriptor browser spawn as a launch error", async () => {
  const error = Object.assign(new Error("bad file descriptor, epoll_ctl"), { code: "EBADF" });
  const launch = spyOn(puppeteer, "launch").mockRejectedValue(error);
  try {
    try {
      await new PuppeteerTier1Browser({ launcher }).launch();
      throw new Error("expected browser launch to fail");
    } catch (received) {
      expect(received).not.toBeInstanceOf(Tier1TransportWedgeError);
      expect(received).toHaveProperty(
        "message",
        expect.stringContaining("tier1: puppeteer launch failed: bad file descriptor"),
      );
    }
  } finally {
    launch.mockRestore();
  }
});

test("closes and removes the profile dir when puppeteer.launch settles after the watchdog gave up", async () => {
  let capturedProfileDir: string | undefined;
  let resolveLate: ((browser: Browser) => void) | undefined;
  const launch = spyOn(puppeteer, "launch").mockImplementation(((opts: {
    userDataDir?: string;
  }) => {
    capturedProfileDir = opts.userDataDir;
    return new Promise<Browser>((resolve) => {
      resolveLate = resolve;
    });
  }) as typeof puppeteer.launch);
  try {
    await expect(new PuppeteerTier1Browser({ launcher }).launch()).rejects.toBeInstanceOf(
      Tier1TransportWedgeError,
    );
    expect(capturedProfileDir).toBeDefined();
    // Abandon path: the watchdog's catch already removed the profile.
    expect(existsSync(capturedProfileDir!)).toBe(false);

    // Simulate the late Chromium process recreating/writing into the
    // same user-data directory after the abandon-path removal — this
    // is the actual failure mode the finding describes, not just an
    // in-process bookkeeping gap.
    mkdirSync(capturedProfileDir!, { recursive: true });
    writeFileSync(join(capturedProfileDir!, "SingletonLock"), "late-chromium");
    expect(existsSync(capturedProfileDir!)).toBe(true);

    let closed = false;
    resolveLate!({
      close: async () => {
        closed = true;
      },
    } as Browser);
    let remaining = existsSync(capturedProfileDir!);
    const deadline = Date.now() + 2_000;
    while (remaining && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
      remaining = existsSync(capturedProfileDir!);
    }
    expect(closed).toBe(true);
    // Late-resolution path: the recreated directory must be removed
    // again, not left stranded.
    expect(remaining).toBe(false);
  } finally {
    launch.mockRestore();
  }
}, 15_000);

test("retries a persistent launch wedge once and retains its typed error", async () => {
  let attempts = 0;
  const runner = createTier1RunnerForTests({
    createBrowser: () => ({
      launch: async () => {
        attempts += 1;
        throw new Tier1TransportWedgeError("launch EBADF: bad file descriptor");
      },
    }),
  });

  await expect(runner(input)).rejects.toMatchObject({
    code: "tier1_protocol_error",
    message: expect.stringContaining("EBADF"),
  });
  expect(attempts).toBe(2);
});

test("does not retry a transport wedge after teardown consumes the total budget", async () => {
  let launches = 0;
  let sends = 0;
  const runner = createTier1RunnerForTests({
    totalBudgetMs: 3_000,
    createBrowser: () => ({
      launch: async () => {
        launches += 1;
        return {
          pid: -1,
          startTime: 0,
          session: {
            send: async () => {
              sends += 1;
              throw new Tier1TransportWedgeError("Runtime.enable");
            },
            on: () => {},
            off: () => {},
            detach: async () => {},
          },
          getFrameTree: async () => ({}),
          close: async () => {
            await new Promise((resolve) => setTimeout(resolve, 3_200));
          },
        };
      },
    }),
  });

  await expect(runner(input)).rejects.toMatchObject({ code: "tier1_timeout" });
  expect(sends).toBe(1);
  expect(launches).toBe(1);
});

for (const closeStalls of [false, true]) {
  test(`total deadline kills a stalled browser and bounds teardown (close stalls: ${closeStalls})`, async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "facet-tier1-deadline-test-"));
    const browser = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<unknown>();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    let closeCalled = false;
    const budgetMs = 3_000;
    const runner = createTier1RunnerForTests({
      totalBudgetMs: budgetMs,
      createBrowser: () => ({
        launch: async () => ({
          pid: browser.pid,
          startTime: readPidStartTimeTicks(browser.pid)!,
          session: {
            send: async <T = unknown>(method: string) => {
              if (method === "Runtime.enable") {
                entered.resolve();
                return pending.promise as T;
              }
              return {} as T;
            },
            on: () => {},
            off: () => {},
            detach: async () => {},
          },
          getFrameTree: async () => ({}),
          close: async () => {
            closeCalled = true;
            await browser.exited;
            rmSync(profileDir, { recursive: true, force: true });
            if (closeStalls) await new Promise<void>(() => {});
          },
        }),
      }),
    });

    try {
      const startedAt = performance.now();
      const run = runner({ ...input, evidenceDir: profileDir });
      void run.catch(() => {});
      let enteredTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entered.promise,
          new Promise<never>((_, reject) => {
            enteredTimer = setTimeout(() => reject(new Error("CDP stall not reached")), 2_500);
          }),
        ]);
      } finally {
        if (enteredTimer !== undefined) clearTimeout(enteredTimer);
      }
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            run,
            new Promise<never>((_, reject) => {
              fallbackTimer = setTimeout(
                () => reject(new Error("aggregate deadline not enforced")),
                budgetMs + TIER1_TEARDOWN_TIMEOUT_MS + 1_500,
              );
            }),
          ]),
        ).rejects.toMatchObject({
          code: "tier1_timeout",
          message: expect.stringContaining(`${budgetMs}ms`),
        });
      } finally {
        if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      }
      expect(performance.now() - startedAt).toBeLessThan(
        budgetMs + (closeStalls ? TIER1_TEARDOWN_TIMEOUT_MS : 0) + 1_200,
      );
      expect(closeCalled).toBe(true);
      expect(await browser.exited).not.toBe(0);
      expect(existsSync(profileDir)).toBe(false);
      pending.reject(new Error("late CDP rejection"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      browser.kill("SIGKILL");
      await browser.exited;
      rmSync(profileDir, { recursive: true, force: true });
    }
  }, 10_000);
}
