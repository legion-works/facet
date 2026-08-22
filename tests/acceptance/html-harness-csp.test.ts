/**
 * This test stays separate to preserve direct CDP-pipe coverage for regressions
 * of the fd-reuse bug fixed in Bun 1.4.0 (oven-sh/bun#37230).
 */
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
