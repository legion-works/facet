import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

import {
  PuppeteerTier1Browser,
  Tier1TransportWedgeError,
} from "../../src/validation/tier1/cdp-pipe";
import { createTier1RunnerForTests } from "../../src/validation/tier1/runner";

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
