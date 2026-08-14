import { expect, test } from "bun:test";

import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import { resolveLauncher } from "../../src/validation/tier1/launcher";
import {
  createIsolatedWorld,
  resolveNestedArtifactFrame,
  resolveSrcdocChildFrame,
} from "../../src/validation/tier1/frame-target";

function srcdoc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

test("real browser resolves direct TSX mounts to the artifact frame", async () => {
  const direct = `<!doctype html><body>
    <main id="facet-tsx-mount" data-facet-renderer-root="true">direct renderer-owned document</main>
  </body>`;
  const directHost = `<!doctype html><body>
    <iframe id="outer" srcdoc="${srcdoc(direct)}"></iframe>
  </body>`;
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
    await target.session.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await Bun.sleep(100);

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
