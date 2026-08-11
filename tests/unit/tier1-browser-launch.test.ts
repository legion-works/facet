import { expect, spyOn, test } from "bun:test";
import puppeteer from "puppeteer-core";

import { resolveLauncher } from "../../src/validation/tier1/launcher";
import { TIER1_NETWORK_NAMESPACE } from "../../src/validation/tier1/limits";
import { runTier1 } from "../../src/validation/tier1/runner";

test("retries a bad-file-descriptor browser spawn once and retains its typed error", async () => {
  const error = Object.assign(new Error("bad file descriptor, epoll_ctl"), { code: "EBADF" });
  const launch = spyOn(puppeteer, "launch").mockRejectedValue(error);
  try {
    await expect(
      runTier1({
        artifactType: "markdown",
        renderer: "svg",
        revisionSha: "0".repeat(64),
        source: new TextEncoder().encode("# browser retry") as Uint8Array<ArrayBuffer>,
        lexical: {
          rendererRootSvgCount: 0,
          mermaidNodeCount: 0,
          visibleSvgCount: 0,
          opaqueRegionCount: 0,
          externalImageCount: 0,
        },
        launcherVersion: resolveLauncher().pinnedVersion,
        networkNamespace: TIER1_NETWORK_NAMESPACE,
      }),
    ).rejects.toMatchObject({
      code: "tier1_protocol_error",
      message: expect.stringContaining("EBADF"),
    });
    expect(launch).toHaveBeenCalledTimes(2);
  } finally {
    launch.mockRestore();
  }
});
