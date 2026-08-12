import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHarnessSrcdoc } from "../../src/validation/tier1/harness";
import { resolveLauncher } from "../../src/validation/tier1/launcher";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";

test("Tier 1 harness CSP allows HTTPS images and blocks cleartext HTTP images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "facet-html-csp-"));
  const launcher = resolveLauncher();
  const browser = new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
  let target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>> | undefined;
  try {
    const harness = await buildHarnessSrcdoc("html");
    expect(harness.srcdoc).toContain("img-src data: https:");
    expect(harness.srcdoc).toContain("frame-src 'none'");
    const harnessPath = join(directory, "harness.html");
    await writeFile(harnessPath, harness.srcdoc);

    target = await browser.launch();
    await target.session.send("Page.navigate", { url: `file://${harnessPath}` });
    await target.session.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `new Promise((resolve) => {
        const waitForHarness = () => {
          if (document.body !== null && document.querySelector('meta[http-equiv="Content-Security-Policy"]') !== null) {
            resolve(undefined);
            return;
          }
          setTimeout(waitForHarness, 10);
        };
        waitForHarness();
      })`,
    });
    const result = await target.session.send<{
      result?: { value?: { afterHttps: readonly string[]; afterHttp: readonly string[] } };
      exceptionDetails?: unknown;
    }>("Runtime.evaluate", {
      returnByValue: true,
      awaitPromise: true,
      expression: `new Promise((resolve) => {
        const violations = [];
        document.addEventListener("securitypolicyviolation", (event) => {
          violations.push(event.effectiveDirective + ":" + event.blockedURI);
        });
        const https = new Image();
        https.onerror = () => {
          const afterHttps = [...violations];
          const http = new Image();
          http.onerror = () => resolve({ afterHttps, afterHttp: [...violations] });
          http.src = "http://127.0.0.1:1/blocked.png";
          document.body.appendChild(http);
        };
        https.src = "https://127.0.0.1:1/allowed.png";
        document.body.appendChild(https);
      })`,
    });

    expect(result.exceptionDetails).toBeUndefined();
    expect(result.result?.value?.afterHttps).toEqual([]);
    expect(result.result?.value?.afterHttp).toContain("img-src:http://127.0.0.1:1/blocked.png");
  } finally {
    await target?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

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
        "window.postMessage({facetHandshake:'ports',nonce:''},'*',[ingress.port2,control.port2]);" +
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
      requests: readonly string[];
    };
    expect(observed.roots).toBe(1);
    expect(observed.nestedMarker).toBe(true);
    expect(observed.title).toBe("Report");
    expect(observed.script).toBe(false);
    expect(observed.cardDisplay).toBe("flex");
    expect(observed.badgeDisplay).toBe("flex");
    expect(observed.unknownColor).toBe("rgb(0, 0, 0)");
    expect(observed.requests.filter((request) => request.startsWith("http"))).toEqual([]);
  } finally {
    await target?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
