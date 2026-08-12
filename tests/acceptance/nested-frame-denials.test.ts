/**
 * This test stays separate because Bun 1.3.14 reuses a poisoned file
 * descriptor after a five-entry CDP-pipe child exits (oven-sh/bun#37230).
 * Keep one direct CDP-pipe spawn per process; remove this split when the pin
 * moves to Bun 1.4.0 or newer.
 */
import { expect, test } from "bun:test";

import { FROZEN_CSP_TEMPLATE } from "../../src/shared/security/frozen-csp";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import { resolveLauncher } from "../../src/validation/tier1/launcher";

const INNER_CHANNELS = [
  "fetch",
  "xhr",
  "websocket",
  "eventsource",
  "beacon",
  "script",
  "worker",
  "sharedWorker",
  "object",
  "media",
  "form",
  "parentDom",
  "controlPort",
] as const;

function galleryBrowser(): PuppeteerTier1Browser {
  const launcher = resolveLauncher();
  return new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
}

function innerFrameSrcdoc(nonce: string, sentinel: string): string {
  return `<!doctype html><html><body><script nonce="${nonce}">
(function () {
  const denials = {};
  const violations = [];
  document.addEventListener("securitypolicyviolation", function (event) {
    violations.push({
      effectiveDirective: event.effectiveDirective,
      blockedURI: event.blockedURI,
      disposition: event.disposition,
    });
  });
  function record(name, payload) { denials[name] = payload; }
  fetch(${JSON.stringify(sentinel + "/fetch")}).then(function () {
    record("fetch", { reached: true });
  }).catch(function (error) {
    record("fetch", { name: error && error.name, message: String(error && error.message || error) });
  });
  fetch("https://example.com/").then(function () {
    record("fetchHttps", { reached: true });
  }).catch(function (error) {
    record("fetchHttps", { name: error && error.name, message: String(error && error.message || error) });
  });
  try {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", ${JSON.stringify(sentinel + "/xhr")});
    xhr.onload = function () { record("xhr", { reached: true }); };
    xhr.onerror = function () { record("xhr", { name: "NetworkError", message: "xhr failed" }); };
    xhr.send();
  } catch (error) {
    record("xhr", { name: error && error.name, message: String(error && error.message || error) });
  }
  try {
    var ws = new WebSocket(${JSON.stringify(sentinel.replace("http", "ws") + "/ws")});
    ws.onopen = function () { record("websocket", { reached: true }); };
    ws.onerror = function () { record("websocket", { name: "SecurityError", message: "websocket failed" }); };
  } catch (error) {
    record("websocket", { name: error && error.name, message: String(error && error.message || error) });
  }
  try {
    var es = new EventSource(${JSON.stringify(sentinel + "/events")});
    es.onopen = function () { record("eventsource", { reached: true }); };
    es.onerror = function () { record("eventsource", { name: "SecurityError", message: "eventsource failed" }); };
  } catch (error) {
    record("eventsource", { name: error && error.name, message: String(error && error.message || error) });
  }
  try {
    var beacon = navigator.sendBeacon(${JSON.stringify(sentinel + "/beacon")}, "x");
    record("beacon", { accepted: beacon, message: beacon ? "sendBeacon accepted before CSP" : "sendBeacon returned false" });
  } catch (error) {
    record("beacon", { name: error && error.name, message: String(error && error.message || error) });
  }
  var script = document.createElement("script");
  script.src = ${JSON.stringify(sentinel + "/script.js")};
  script.onload = function () { record("script", { reached: true }); };
  script.onerror = function () { record("script", { name: "SecurityError", message: "external script blocked" }); };
  document.body.appendChild(script);
  try {
    var worker = new Worker(${JSON.stringify(sentinel + "/worker.js")});
    record("worker", { reached: true, started: typeof worker.postMessage === "function" });
  } catch (error) {
    record("worker", { name: error && error.name, message: String(error && error.message || error) });
  }
  try {
    var shared = new SharedWorker(${JSON.stringify(sentinel + "/shared.js")});
    record("sharedWorker", { reached: true });
    void shared;
  } catch (error) {
    record("sharedWorker", { name: error && error.name, message: String(error && error.message || error) });
  }
  var object = document.createElement("object");
  object.data = ${JSON.stringify(sentinel + "/object")};
  object.onload = function () { record("object", { reached: true }); };
  object.onerror = function () { record("object", { name: "SecurityError", message: "object blocked" }); };
  document.body.appendChild(object);
  var media = document.createElement("video");
  media.src = ${JSON.stringify(sentinel + "/media.mp4")};
  media.onloadeddata = function () { record("media", { reached: true }); };
  media.onerror = function () { record("media", { name: "SecurityError", message: "media blocked" }); };
  document.body.appendChild(media);
  try {
    var form = document.createElement("form");
    form.action = ${JSON.stringify(sentinel + "/form")};
    form.method = "POST";
    document.body.appendChild(form);
    form.submit();
    record("form", { submitted: true, href: String(location.href), message: "form.submit returned" });
  } catch (error) {
    record("form", { name: error && error.name, message: String(error && error.message || error) });
  }
  try {
    var parentText = window.parent.document.body && window.parent.document.body.textContent;
    record("parentDom", { reached: true, text: String(parentText || "").slice(0, 40) });
  } catch (error) {
    record("parentDom", { name: error && error.name, message: String(error && error.message || error) });
  }
  try {
    var control = window.parent.__facetControl;
    record("controlPort", control === undefined ? { reached: false } : { reached: true, control: control });
  } catch (error) {
    record("controlPort", { name: error && error.name, message: String(error && error.message || error) });
  }
  setTimeout(function () {
    parent.postMessage({ kind: "inner-denials", denials: denials, violations: violations }, "*");
  }, 900);
})();
</script></body></html>`;
}

test("denied capabilities still die inside a nested srcdoc under the frozen CSP", async () => {
  const nonce = "n-inner-egress";
  const csp = FROZEN_CSP_TEMPLATE.replace("<BOOTSTRAP_NONCE>", nonce);
  const hits: string[] = [];
  const sentinel = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      hits.push(`${request.method} ${url.pathname}`);
      return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
    },
  });
  const sentinelUrl = `http://127.0.0.1:${sentinel.port}`;
  const parent = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const srcdoc = JSON.stringify(innerFrameSrcdoc(nonce, sentinelUrl)).replaceAll(
        "<",
        "\\u003c",
      );
      const html = `<!doctype html><html><head></head><body>
<script nonce="${nonce}">
window.__facetControl = { port: "secret" };
window.__inner = null;
window.addEventListener("message", function (event) {
  if (event.data && event.data.kind === "inner-denials") window.__inner = event.data;
});
const iframe = document.createElement("iframe");
iframe.setAttribute("sandbox", "allow-scripts");
iframe.srcdoc = ${srcdoc};
document.body.appendChild(iframe);
</script></body></html>`;
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": csp,
        },
      });
    },
  });
  const browser = galleryBrowser();
  let target: Awaited<ReturnType<PuppeteerTier1Browser["launch"]>> | undefined;
  try {
    target = await browser.launch();
    const nav = (await target.session.send("Page.navigate", {
      url: `http://127.0.0.1:${parent.port}/`,
    })) as { errorText?: string };
    if (nav.errorText !== undefined && nav.errorText.length > 0) {
      throw new Error(`inner egress navigation failed: ${nav.errorText}`);
    }
    const evaluated = (await target.session.send("Runtime.evaluate", {
      returnByValue: true,
      awaitPromise: true,
      expression: `new Promise((resolve) => {
        const deadline = Date.now() + 7000;
        const wait = () => {
          if (window.__inner) { resolve(window.__inner); return; }
          if (Date.now() >= deadline) {
            resolve({
              timedOut: true,
              iframeCount: document.querySelectorAll('iframe').length,
              hasControl: window.__facetControl !== undefined,
            });
            return;
          }
          setTimeout(wait, 50);
        };
        wait();
      })`,
    })) as {
      result?: {
        value?: {
          timedOut?: boolean;
          denials?: Record<
            string,
            { reached?: boolean; name?: string; message?: string; href?: string }
          >;
          violations?: readonly {
            effectiveDirective?: string;
            blockedURI?: string;
            disposition?: string;
          }[];
        };
      };
    };
    const inner = evaluated.result?.value;
    expect(inner?.timedOut).toBeUndefined();
    expect(hits).toEqual([]);
    for (const channel of INNER_CHANNELS) {
      const denial = inner?.denials?.[channel];
      expect(denial, channel).toBeDefined();
      expect(denial?.reached, channel).not.toBe(true);
    }
    expect(inner?.denials?.fetch?.name).toBe("TypeError");
    expect(inner?.denials?.parentDom?.name).toBe("SecurityError");
    expect(inner?.denials?.controlPort?.name).toBe("SecurityError");
    expect(inner?.denials?.worker?.name).toBe("SecurityError");
    expect(inner?.denials?.sharedWorker?.name).toBe("SecurityError");
    expect(inner?.denials?.form?.href).toBe("about:srcdoc");
    const blocked = (directive: string, uri: string): boolean =>
      (inner?.violations ?? []).some(
        (item) =>
          item.effectiveDirective === directive &&
          item.blockedURI?.includes(uri) === true &&
          item.disposition === "enforce",
      );
    expect(blocked("connect-src", "https://example.com")).toBe(true);
    expect(blocked("connect-src", "/fetch")).toBe(true);
    expect(blocked("connect-src", "/xhr")).toBe(true);
    expect(blocked("connect-src", "/ws")).toBe(true);
    expect(blocked("connect-src", "/beacon")).toBe(true);
    expect(blocked("connect-src", "/events")).toBe(true);
    expect(blocked("script-src-elem", "/script.js")).toBe(true);
    expect(blocked("media-src", "/media.mp4")).toBe(true);
    expect(blocked("object-src", String(sentinel.port))).toBe(true);
  } finally {
    await target?.close();
    parent.stop(true);
    sentinel.stop(true);
  }
}, 30_000);
