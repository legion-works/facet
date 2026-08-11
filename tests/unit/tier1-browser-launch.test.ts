import { expect, spyOn, test } from "bun:test";
import puppeteer from "puppeteer-core";

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

test("promotes a bad-file-descriptor browser spawn to a typed transport wedge", async () => {
  const error = Object.assign(new Error("bad file descriptor, epoll_ctl"), { code: "EBADF" });
  const launch = spyOn(puppeteer, "launch").mockRejectedValue(error);
  try {
    try {
      await new PuppeteerTier1Browser({ launcher }).launch();
      throw new Error("expected browser launch to fail");
    } catch (received) {
      expect(received).toBeInstanceOf(Tier1TransportWedgeError);
      expect(received).toHaveProperty("message", expect.stringContaining("EBADF"));
    }
  } finally {
    launch.mockRestore();
  }
});

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
