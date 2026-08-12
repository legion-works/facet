/**
 * CSP-only cases for the TSX interactive frame. Later tasks extend this
 * file; this task pins the D8 nested-srcdoc premise under the unchanged
 * frozen CSP.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FROZEN_CSP_TEMPLATE } from "../../src/shared/security/frozen-csp";
import { TIER1_PINNED_VERSION } from "../../src/shared/config/limits";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import { resolveLauncher } from "../../src/validation/tier1/launcher";
import { FROZEN_CSP_LITERAL } from "../helpers/frozen-csp-literal";

const NONCE = "n-d8-srcdoc-pin";

function galleryBrowser(): PuppeteerTier1Browser {
  const launcher = resolveLauncher();
  return new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
}

function probeDocument(csp: string, viaMeta: boolean): string {
  const meta = viaMeta ? `<meta http-equiv="Content-Security-Policy" content="${csp}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body>
<script nonce="${NONCE}">
window.__probe = null;
window.__violations = [];
document.addEventListener("securitypolicyviolation", function (event) {
  window.__violations.push({
    effectiveDirective: event.effectiveDirective,
    blockedURI: event.blockedURI,
    disposition: event.disposition,
  });
});
(function () {
  const messages = [];
  window.addEventListener("message", function (event) { messages.push(event.data); });
  const srcdoc = document.createElement("iframe");
  srcdoc.setAttribute("sandbox", "allow-scripts");
  srcdoc.setAttribute("referrerpolicy", "no-referrer");
  srcdoc.srcdoc = "<!doctype html><html><body><script nonce='${NONCE}'>parent.postMessage({kind:'nested-ready', href:String(location.href)},'*');<\\/script></body></html>";
  document.body.appendChild(srcdoc);
  const https = document.createElement("iframe");
  https.setAttribute("sandbox", "allow-scripts");
  https.src = "https://example.com/";
  document.body.appendChild(https);
  const sameOrigin = document.createElement("iframe");
  sameOrigin.setAttribute("sandbox", "allow-scripts");
  sameOrigin.src = "/same-origin";
  document.body.appendChild(sameOrigin);
  setTimeout(function () {
    window.__probe = {
      messages: messages,
      violations: window.__violations,
      iframeCount: document.querySelectorAll("iframe").length,
    };
  }, 800);
})();
</script></body></html>`;
}

function summarizeFrameTree(
  tree: unknown,
): readonly { url: string | undefined; origin: string | undefined }[] {
  const frames: { url: string | undefined; origin: string | undefined }[] = [];
  const walk = (node: {
    frame?: { url?: string; securityOrigin?: string };
    childFrames?: unknown[];
  }): void => {
    frames.push({ url: node.frame?.url, origin: node.frame?.securityOrigin });
    for (const child of node.childFrames ?? []) walk(child as never);
  };
  const root = tree as { frameTree?: Parameters<typeof walk>[0] };
  if (root.frameTree !== undefined) walk(root.frameTree);
  return frames;
}

async function runProbe(
  url: string,
  session: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
) {
  const nav = (await session.send("Page.navigate", { url })) as { errorText?: string };
  if (nav.errorText !== undefined && nav.errorText.length > 0) {
    throw new Error(`probe navigation failed: ${nav.errorText}`);
  }
  const evaluated = (await session.send("Runtime.evaluate", {
    returnByValue: true,
    awaitPromise: true,
    expression: `new Promise((resolve) => {
      const deadline = Date.now() + 7000;
      const wait = () => {
        if (window.__probe) { resolve(window.__probe); return; }
        if (Date.now() >= deadline) { resolve({ timedOut: true }); return; }
        setTimeout(wait, 50);
      };
      wait();
    })`,
  })) as {
    result?: {
      value?: {
        messages?: readonly { kind?: string; href?: string }[];
        violations?: readonly {
          effectiveDirective?: string;
          blockedURI?: string;
          disposition?: string;
        }[];
        iframeCount?: number;
        timedOut?: boolean;
      };
    };
    exceptionDetails?: unknown;
  };
  if (evaluated.exceptionDetails !== undefined) {
    throw new Error(`probe evaluate failed: ${JSON.stringify(evaluated.exceptionDetails)}`);
  }
  const frameTree = await session.send("Page.getFrameTree", {});
  return { value: evaluated.result?.value, frames: summarizeFrameTree(frameTree) };
}

// D8's nested srcdoc isolation depends on this pinned browser treating
// srcdoc as exempt from frame-src. A RED after a chrome-headless-shell
// pin bump means re-verify D8's mechanism, not that the test is flaky.
test(`the pinned browser ${TIER1_PINNED_VERSION} exempts srcdoc from frame-src (D8 depends on this)`, async () => {
  expect(FROZEN_CSP_TEMPLATE).toBe(FROZEN_CSP_LITERAL);
  expect(FROZEN_CSP_LITERAL).toContain("frame-src 'none'");
  const csp = FROZEN_CSP_TEMPLATE.replace("<BOOTSTRAP_NONCE>", NONCE);
  const browser = galleryBrowser();
  const directory = await mkdtemp(join(tmpdir(), "facet-d8-srcdoc-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/same-origin") return new Response("same-origin", { status: 200 });
      return new Response(probeDocument(csp, false), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": csp,
        },
      });
    },
  });
  let target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>> | undefined;
  try {
    target = await browser.launch();
    const http = await runProbe(`http://127.0.0.1:${server.port}/`, target.session);
    const filePath = join(directory, "harness.html");
    await writeFile(filePath, probeDocument(csp, true));
    const file = await runProbe(`file://${filePath}`, target.session);

    for (const [origin, result] of [
      ["http", http],
      ["file", file],
    ] as const) {
      expect(result.value?.timedOut, origin).toBeUndefined();
      expect(result.value?.iframeCount, origin).toBe(3);
      expect(result.value?.messages, origin).toContainEqual({
        kind: "nested-ready",
        href: "about:srcdoc",
      });
      expect(
        result.frames.some((frame) => frame.url === "about:srcdoc" && frame.origin === "://"),
        `${origin} child frame`,
      ).toBe(true);
      const frameSrc = (result.value?.violations ?? []).filter(
        (violation) => violation.effectiveDirective === "frame-src",
      );
      expect(
        frameSrc.some((violation) => violation.blockedURI === "https://example.com"),
        origin,
      ).toBe(true);
      expect(
        frameSrc.some((violation) =>
          origin === "http"
            ? violation.blockedURI?.includes("/same-origin") === true
            : violation.blockedURI === "file",
        ),
        `${origin} same-origin src=`,
      ).toBe(true);
      expect(
        frameSrc.every((violation) => violation.disposition === "enforce"),
        origin,
      ).toBe(true);
    }
  } finally {
    await target?.close();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
