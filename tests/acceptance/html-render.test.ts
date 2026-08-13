import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHarnessSrcdoc } from "../../src/validation/tier1/harness";
import { resolveLauncher } from "../../src/validation/tier1/launcher";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";

test("uses one frame-owned renderer root and applies vendored HTML styling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "facet-html-render-"));
  const launcher = resolveLauncher();
  const browser = new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
  let target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>> | undefined;
  try {
    const harness = await buildHarnessSrcdoc("html");
    const harnessPath = join(directory, "harness.html");
    await writeFile(harnessPath, harness.srcdoc);
    target = await browser.launch();
    await target.session.send("Page.navigate", { url: `file://${harnessPath}` });
    await target.session.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `new Promise((resolve) => {
        const wait = () => {
          if (window.facetHarnessLoaded === true) { resolve(undefined); return; }
          setTimeout(wait, 10);
        };
        wait();
      })`,
    });
    const source = [
      '<section data-facet-renderer-root="true" class="card bg-legion-paper p-4">',
      '<h1 class="text-xl">Report</h1><span class="badge">verified</span>',
      '<table class="table"><tbody><tr><td>row</td></tr></tbody></table>',
      '<p class="not-shipped">plain</p><script>window.injected=true</script>',
      "</section>",
    ].join("");
    const encoded = Buffer.from(source).toString("base64");
    await target.session.send("Runtime.evaluate", {
      expression:
        "(function(){" +
        "var ingress=new MessageChannel();var control=new MessageChannel();window.__events=[];" +
        "control.port1.onmessage=function(e){window.__events.push(e.data);};" +
        `window.postMessage({facetHandshake:'ports',nonce:${JSON.stringify(harness.nonce)}},'*',[ingress.port2,control.port2]);` +
        `setTimeout(function(){ingress.port1.postMessage({bytes:${JSON.stringify(encoded)},mode:'render',artifactType:'html',renderer:'svg'});},0);` +
        "})()",
    });
    const result = await target.session.send<{ result?: { value?: string } }>("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((resolve) => {
        const wait = () => {
          if ((window.__events || []).some((event) => event.type === "render-complete")) {
            const root = document.querySelector('.facet-html-root[data-facet-renderer-root="true"]');
            resolve(JSON.stringify({
              roots: document.querySelectorAll('.facet-html-root[data-facet-renderer-root="true"]').length,
              nestedMarker: root?.querySelector('[data-facet-renderer-root="true"]') !== null,
              title: root?.querySelector('h1')?.textContent,
              script: root?.querySelector('script') !== null,
              cardDisplay: root === null ? "" : getComputedStyle(root.querySelector('.card')).display,
              badgeDisplay: root === null ? "" : getComputedStyle(root.querySelector('.badge')).display,
              unknownColor: root === null ? "" : getComputedStyle(root.querySelector('.not-shipped')).color,
              baseColor: root === null ? "" : getComputedStyle(root).color,
              requests: performance.getEntriesByType('resource').map((entry) => entry.name),
            }));
            return;
          }
          setTimeout(wait, 10);
        };
        wait();
      })`,
    });
    const observed = JSON.parse(result.result?.value ?? "null") as {
      roots: number;
      nestedMarker: boolean;
      title: string;
      script: boolean;
      cardDisplay: string;
      badgeDisplay: string;
      unknownColor: string;
      baseColor: string;
      requests: readonly string[];
    };
    expect(observed.roots).toBe(1);
    expect(observed.nestedMarker).toBe(true);
    expect(observed.title).toBe("Report");
    expect(observed.script).toBe(false);
    expect(observed.cardDisplay).toBe("flex");
    expect(observed.badgeDisplay).toBe("flex");
    // A class outside the vendored vocabulary must inherit the root's colour —
    // proving the stylesheet shipped no rule for it. The literal value tracks the
    // vendored THEME (dark since d1a92c8), so compare against the root rather
    // than a hard-coded colour that silently encodes whichever theme shipped.
    expect(observed.unknownColor).toBe(observed.baseColor);
    expect(observed.requests.filter((request) => request.startsWith("http"))).toEqual([]);
  } finally {
    await target?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
