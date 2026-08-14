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

test("real browser resolves direct mounts and selects renderer-owned nested frames", async () => {
  const artifact = '<!doctype html><p id="artifact">renderer-owned document</p>';
  const outer = `<!doctype html><body>
    <main data-facet-renderer-root="true">outer-frame fake root</main>
    <iframe id="sibling-decoy" srcdoc="${srcdoc("<!doctype html><p>decoy</p>")}"></iframe>
    <iframe id="artifact-frame" data-facet-tsx-frame="true" srcdoc="${srcdoc(artifact)}"></iframe>
  </body>`;
  const host = `<!doctype html><body>
    <main data-facet-renderer-root="true">parent-host fake root</main>
    <iframe id="outer" srcdoc="${srcdoc(outer)}"></iframe>
  </body>`;
  const direct = `<!doctype html><body>
    <main id="facet-tsx-mount" data-facet-renderer-root="true">direct renderer-owned document</main>
  </body>`;
  const directHost = `<!doctype html><body>
    <iframe id="outer" srcdoc="${srcdoc(direct)}"></iframe>
  </body>`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new Response(new URL(request.url).pathname === "/direct" ? directHost : host, {
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
    expect(artifactFrame.frameId).not.toBe(outerFrame.frameId);
    expect(artifactFrame.url).toBe("about:srcdoc");
    const isolated = await createIsolatedWorld(target.session, artifactFrame.frameId);
    const rendered = (await target.session.send("Runtime.evaluate", {
      expression: "document.body.textContent",
      contextId: isolated.executionContextId,
      returnByValue: true,
    })) as { result?: { value?: string } };
    expect(rendered.result?.value).toContain("renderer-owned document");

    await target.session.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/direct` });
    await Bun.sleep(100);
    const directOuterFrame = await resolveSrcdocChildFrame(target.session);
    const directArtifactFrame = await resolveNestedArtifactFrame(target.session, directOuterFrame);
    expect(directArtifactFrame).toEqual(directOuterFrame);
    const directIsolated = await createIsolatedWorld(target.session, directArtifactFrame.frameId);
    const directRendered = (await target.session.send("Runtime.evaluate", {
      expression: "document.body.textContent",
      contextId: directIsolated.executionContextId,
      returnByValue: true,
    })) as { result?: { value?: string } };
    expect(directRendered.result?.value).toContain("direct renderer-owned document");
  } finally {
    await target?.close();
    server.stop(true);
  }
}, 90_000);
