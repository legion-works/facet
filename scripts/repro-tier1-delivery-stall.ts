import { PuppeteerTier1Browser } from "../src/validation/tier1/cdp-pipe";

const FETCH_BUDGET_MS = 12_000;
const POST_RETURN_HEARTBEAT_MS = 250;
const POST_RETURN_HEARTBEAT_TICKS = 20;

function trace(message: string): void {
  process.stderr.write(`[tier1-delivery-repro] ${message}\n`);
}

function startPostReturnHeartbeat(attempt: number): void {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    trace(`post-return-heartbeat attempt=${attempt} tick=${ticks}`);
    if (ticks >= POST_RETURN_HEARTBEAT_TICKS) clearInterval(timer);
  }, POST_RETURN_HEARTBEAT_MS);
  timer.unref();
}

let handlerAttempt = 0;
const browser = new PuppeteerTier1Browser();
const body = JSON.stringify({ status: "tampered", padding: "x".repeat(1_220) });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(): Promise<Response> {
    handlerAttempt += 1;
    const attempt = handlerAttempt;
    trace(`handler:start attempt=${attempt}`);
    const target = await browser.launch();
    try {
      await target.session.send("Browser.getVersion");
    } finally {
      await target.close();
    }
    trace(`handler:return attempt=${attempt} bytes=${body.length}`);
    startPostReturnHeartbeat(attempt);
    return new Response(body, {
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
  },
});

async function request(attempt: number): Promise<boolean> {
  const startedAt = performance.now();
  trace(`client:fetch:start attempt=${attempt}`);
  try {
    const response = await fetch(`http://${server.hostname}:${server.port}/`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(FETCH_BUDGET_MS),
    });
    trace(
      `client:fetch:complete attempt=${attempt} status=${response.status} elapsedMs=${Math.round(performance.now() - startedAt)}`,
    );
    const text = await response.text();
    trace(`client:body:complete attempt=${attempt} bytes=${text.length}`);
    return response.status === 200 && text === body;
  } catch (error) {
    trace(
      `client:error attempt=${attempt} elapsedMs=${Math.round(performance.now() - startedAt)} error=${error instanceof Error ? `${error.name}:${error.message}` : String(error)}`,
    );
    return false;
  }
}

const outcomes: boolean[] = [];
try {
  outcomes.push(await request(1));
  await Bun.sleep(100);
  outcomes.push(await request(2));
} finally {
  server.stop(true);
}

trace(`outcomes=${outcomes.map((outcome) => (outcome ? "pass" : "fail")).join(",")}`);
if (outcomes.some((outcome) => !outcome)) process.exitCode = 1;
