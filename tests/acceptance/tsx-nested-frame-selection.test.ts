import { expect, test } from "bun:test";

import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import { resolveLauncher } from "../../src/validation/tier1/launcher";
import {
  createIsolatedWorld,
  resolveNestedArtifactFrame,
  resolveSrcdocChildFrame,
} from "../../src/validation/tier1/frame-target";

function waitForSrcdocChildFrame(
  session: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>>["session"],
): Promise<void> {
  return new Promise((resolve) => {
    session.on("Page.frameNavigated", (params: unknown) => {
      const frame = (
        params as {
          frame?: { parentId?: string; url?: string };
        }
      ).frame;
      if (frame?.parentId !== undefined && frame.url === "about:srcdoc") resolve();
    });
  });
}

test("real browser resolves direct TSX mounts to the artifact frame", async () => {
  const direct = `<!doctype html><body>
    <main id="facet-tsx-mount" data-facet-renderer-root="true">direct renderer-owned document</main>
  </body>`;
  const directHost = `<!doctype html><body><script>
    setTimeout(() => {
      const frame = document.createElement("iframe");
      frame.id = "outer";
      frame.srcdoc = ${JSON.stringify(direct)};
      document.body.append(frame);
    }, 500);
  </script></body>`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(directHost, {
        headers: { "content-type": "text/html" },
      }),
  });
  const launcher = resolveLauncher();
  const browser = new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
  let target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>> | undefined;
  try {
    target = await browser.launch();
    await target.session.send("Page.enable");
    const childAttached = waitForSrcdocChildFrame(target.session);
    await target.session.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await childAttached;

    const outerFrame = await resolveSrcdocChildFrame(target.session);
    const artifactFrame = await resolveNestedArtifactFrame(target.session, outerFrame);
    expect(artifactFrame).toEqual(outerFrame);
    const isolated = await createIsolatedWorld(target.session, artifactFrame.frameId);
    const rendered = (await target.session.send("Runtime.evaluate", {
      expression: "document.body.textContent",
      contextId: isolated.executionContextId,
      returnByValue: true,
    })) as { result?: { value?: string } };
    expect(rendered.result?.value).toContain("direct renderer-owned document");
  } finally {
    await target?.close();
    server.stop(true);
  }
}, 90_000);
