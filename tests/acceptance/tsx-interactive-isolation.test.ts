import { expect, test } from "bun:test";
import { join } from "node:path";

import { FROZEN_CSP_TEMPLATE } from "../../src/shared/security/frozen-csp";
import { PuppeteerTier1Browser } from "../../src/validation/tier1/cdp-pipe";
import { resolveLauncher } from "../../src/validation/tier1/launcher";

const REPO_ROOT = join(import.meta.dir, "../..");
const CSP_NONCE = "n-tsx-isolation";
const HANDSHAKE_NONCE = "h-tsx-isolation";

function galleryBrowser(): PuppeteerTier1Browser {
  const launcher = resolveLauncher();
  return new PuppeteerTier1Browser({
    launcher: { ...launcher, executablePath: launcher.binaryPath },
  });
}

async function buildGallery(): Promise<void> {
  const child = Bun.spawn([process.execPath, "scripts/build-gallery.ts"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`gallery build failed: ${stderr}`);
}

test("interactive TSX rejects nested control-channel handshakes", async () => {
  await buildGallery();
  const hits: string[] = [];
  const sink = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      hits.push(new URL(request.url).pathname);
      return new Response("unexpected network");
    },
  });
  const sinkUrl = `http://127.0.0.1:${sink.port}/egress`;
  const source = [
    "const result = {};",
    "function attempt(name, action) { try { result[name] = { value: String(action()) }; } catch (error) { result[name] = { name: error && error.name }; } }",
    "attempt('parentDocument', () => window.parent.document.body.textContent);",
    "attempt('bootstrapGlobal', () => window.parent.__facetBootstrapReady);",
    "attempt('controlPort', () => window.parent.__facetControlPort);",
    "attempt('localStorage', () => localStorage.getItem('facet'));",
    `fetch(${JSON.stringify(sinkUrl)}).then(() => { result.network = { reached: true }; }).catch((error) => { result.network = { name: error && error.name }; });`,
    "const csp = document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content ?? '';",
    "const nestedNonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? null;",
    "const nonceIngress = new MessageChannel(); const nonceControl = new MessageChannel(); const nonceForgeryEvents = [];",
    "const sourceIngress = new MessageChannel(); const sourceControl = new MessageChannel(); const sourceForgeryEvents = [];",
    "nonceControl.port1.onmessage = (event) => nonceForgeryEvents.push(event.data);",
    "sourceControl.port1.onmessage = (event) => sourceForgeryEvents.push(event.data);",
    "parent.postMessage({ facetHandshake: 'ports', nonce: nestedNonce }, '*', [nonceIngress.port2, nonceControl.port2]);",
    `parent.postMessage({ facetHandshake: 'ports', nonce: ${JSON.stringify(HANDSHAKE_NONCE)} }, '*', [sourceIngress.port2, sourceControl.port2]);`,
    "const mount = document.getElementById('facet-tsx-mount'); if (mount) mount.textContent = 'nested mount';",
    "setTimeout(() => parent.postMessage({ kind: 'tsx-inner-report', nestedNonce, nonceForgeryEvents, sourceForgeryEvents, result }, '*'), 350);",
  ].join("\n");
  const artifactBase64 = Buffer.from(source).toString("base64");
  const csp = FROZEN_CSP_TEMPLATE.replace("<BOOTSTRAP_NONCE>", CSP_NONCE);
  const parent = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith("/frame/")) {
        const asset = Bun.file(join(REPO_ROOT, "dist", "gallery", pathname));
        if (await asset.exists()) return new Response(asset);
        return new Response("not found", { status: 404 });
      }
      if (pathname === "/shell") {
        const shell = `<!doctype html><html><body><main id="artifact"></main>
<script id="bootstrap" type="module" nonce="${CSP_NONCE}" src="/frame/bootstrap/tsx.js"></script>
<script nonce="${CSP_NONCE}">
window.__tsxInnerReports=[];
window.addEventListener('message',function(event){if(event.data&&event.data.kind==='tsx-inner-report')window.__tsxInnerReports.push(event.data);});
</script></body></html>`;
        return new Response(shell, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": csp,
          },
        });
      }
      const host = `<!doctype html><html><body><iframe id="shell" src="/shell?nonce=${CSP_NONCE}&handshake=${HANDSHAKE_NONCE}"></iframe>
<script>
window.__tsxControlEvents=[];window.__tsxSecondControlEvents=[];
const shell=document.getElementById('shell');
shell.addEventListener('load',function(){
 const ingress=new MessageChannel();const control=new MessageChannel();
 control.port1.onmessage=function(event){
   window.__tsxControlEvents.push(event.data);
   if(event.data&&event.data.type==='boot-ready'){
     ingress.port1.postMessage({artifactType:'tsx',renderer:'svg',execution:'interactive',bytes:${JSON.stringify(artifactBase64)}});
     setTimeout(function(){
       const ignoredIngress=new MessageChannel();const ignoredControl=new MessageChannel();
       ignoredControl.port1.onmessage=function(second){window.__tsxSecondControlEvents.push(second.data);};
        shell.contentWindow.postMessage({facetHandshake:'ports',nonce:${JSON.stringify(HANDSHAKE_NONCE)}},'*',[ignoredIngress.port2,ignoredControl.port2]);
     },50);
   }
 };
 shell.contentWindow.postMessage({facetHandshake:'ports',nonce:${JSON.stringify(HANDSHAKE_NONCE)}},'*',[ingress.port2,control.port2]);
});
</script></body></html>`;
      return new Response(host, { headers: { "content-type": "text/html; charset=utf-8" } });
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
      throw new Error(`interactive TSX navigation failed: ${nav.errorText}`);
    }
    const probe = (await target.session.send("Runtime.evaluate", {
      returnByValue: true,
      awaitPromise: true,
      expression: `new Promise((resolve) => {
        const deadline = Date.now() + 7000;
        const wait = () => {
          const shell = document.getElementById('shell')?.contentWindow;
          const reports = shell?.__tsxInnerReports || [];
          const control = window.__tsxControlEvents || [];
          if (reports.length > 0 && control.some((event) => event.type === 'render-complete')) {
            const frame = shell.document.querySelector('#artifact > iframe');
            resolve({ reports, control, secondControl: window.__tsxSecondControlEvents || [], frame: frame && { sandbox: frame.getAttribute('sandbox'), referrerpolicy: frame.getAttribute('referrerpolicy'), allow: frame.getAttribute('allow'), srcdoc: frame.getAttribute('srcdoc') }, outerRoots: shell.document.querySelectorAll('[data-facet-renderer-root]').length });
            return;
          }
          if (Date.now() >= deadline) { resolve({ timedOut: true, control, reports }); return; }
          setTimeout(wait, 50);
        };
        wait();
      })`,
    })) as {
      result?: {
        value?: {
          timedOut?: boolean;
          reports?: readonly {
            nestedNonce?: string | null;
            nonceForgeryEvents?: readonly { type?: string }[];
            sourceForgeryEvents?: readonly { type?: string }[];
            result?: Record<string, { name?: string; value?: string; reached?: boolean }>;
          }[];
          control?: readonly { type?: string }[];
          secondControl?: readonly { type?: string }[];
          frame?: { sandbox?: string; referrerpolicy?: string; allow?: string; srcdoc?: string };
          outerRoots?: number;
        };
      };
    };
    const value = probe.result?.value;
    expect({
      timedOut: value?.timedOut,
      control: value?.control,
    }).toEqual({
      timedOut: undefined,
      control: expect.any(Array),
    });
    expect(value?.frame?.sandbox).toBe("allow-scripts");
    expect(value?.frame?.referrerpolicy).toBe("no-referrer");
    expect(value?.frame?.allow).toBe("");
    expect(value?.frame?.srcdoc).toContain("default-src 'none'");
    expect(value?.frame?.srcdoc).toContain("connect-src 'none'");
    expect(value?.outerRoots).toBe(0);
    expect(value?.reports).toHaveLength(1);
    const report = value?.reports?.[0];
    expect(report?.nonceForgeryEvents).toEqual([]);
    expect(report?.sourceForgeryEvents).toEqual([]);
    expect(report?.nestedNonce).toBe(CSP_NONCE);
    expect(report?.nestedNonce).not.toBe(HANDSHAKE_NONCE);
    expect(value?.control).toContainEqual({ type: "boot-ready" });
    expect(value?.control).toContainEqual(expect.objectContaining({ type: "render-complete" }));
    expect(value?.secondControl).toEqual([]);
    expect(report?.result?.parentDocument?.name).toBe("SecurityError");
    expect(report?.result?.bootstrapGlobal?.name).toBe("SecurityError");
    expect(report?.result?.controlPort?.name).toBe("SecurityError");
    expect(report?.result?.localStorage?.name).toBe("SecurityError");
    expect(report?.result?.network?.reached).not.toBe(true);
    expect(report?.result?.network?.name).toBe("TypeError");
    expect(hits).toEqual([]);
  } finally {
    await target?.close();
    parent.stop(true);
    sink.stop(true);
  }
}, 60_000);
