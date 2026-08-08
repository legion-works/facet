import { expect, test } from "bun:test";

import { PuppeteerTier1Browser } from "../src/validation/tier1/cdp-pipe";

const FETCH_BUDGET_MS = 12_000;
const POST_RETURN_HEARTBEAT_MS = 250;
const POST_RETURN_HEARTBEAT_TICKS = 20;
const SLOW_HANDLER_MS = 1_700;

type Scenario = "slow" | "browser";

function trace(message: string): void {
  process.stderr.write(`[tier1-delivery-repro] ${message}\n`);
}

function startPostReturnHeartbeat(scenario: Scenario, attempt: number): void {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    trace(`post-return-heartbeat scenario=${scenario} attempt=${attempt} tick=${ticks}`);
    if (ticks >= POST_RETURN_HEARTBEAT_TICKS) clearInterval(timer);
  }, POST_RETURN_HEARTBEAT_MS);
  timer.unref();
}

const body = JSON.stringify({ status: "tampered", padding: "x".repeat(1_220) });

async function runScenario(scenario: Scenario): Promise<{
  readonly remotePorts: readonly number[];
  readonly outcomes: readonly boolean[];
}> {
  let handlerAttempt = 0;
  const remotePorts: number[] = [];
  const browser = new PuppeteerTier1Browser();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      remotePorts.push(server.requestIP(request)?.port ?? -1);
      if (new URL(request.url).pathname === "/warmup") {
        trace(`handler:warmup scenario=${scenario} bytes=391 remotePort=${remotePorts.at(-1)}`);
        return new Response("x".repeat(391), {
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        });
      }
      handlerAttempt += 1;
      const attempt = handlerAttempt;
      trace(
        `handler:start scenario=${scenario} attempt=${attempt} remotePort=${remotePorts.at(-1)}`,
      );
      if (scenario === "slow") {
        await Bun.sleep(SLOW_HANDLER_MS);
      } else {
        const target = await browser.launch();
        try {
          await target.session.send("Browser.getVersion");
        } finally {
          await target.close();
        }
      }
      trace(`handler:return scenario=${scenario} attempt=${attempt} bytes=${body.length}`);
      startPostReturnHeartbeat(scenario, attempt);
      return new Response(body, {
        headers: { "cache-control": "no-store", "content-type": "application/json" },
      });
    },
  });

  const request = async (attempt: number): Promise<boolean> => {
    const startedAt = performance.now();
    trace(`client:fetch:start scenario=${scenario} attempt=${attempt}`);
    try {
      const response = await fetch(`http://${server.hostname}:${server.port}/tier1`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(FETCH_BUDGET_MS),
      });
      trace(
        `client:fetch:complete scenario=${scenario} attempt=${attempt} status=${response.status} elapsedMs=${Math.round(performance.now() - startedAt)}`,
      );
      const text = await response.text();
      trace(`client:body:complete scenario=${scenario} attempt=${attempt} bytes=${text.length}`);
      return response.status === 200 && text === body;
    } catch (error) {
      trace(
        `client:error scenario=${scenario} attempt=${attempt} elapsedMs=${Math.round(performance.now() - startedAt)} error=${error instanceof Error ? `${error.name}:${error.message}` : String(error)}`,
      );
      return false;
    }
  };

  const outcomes: boolean[] = [];
  try {
    trace(`client:warmup:start scenario=${scenario}`);
    const response = await fetch(`http://${server.hostname}:${server.port}/warmup`, {
      method: "POST",
      body: "{}",
    });
    const text = await response.text();
    trace(
      `client:warmup:complete scenario=${scenario} status=${response.status} bytes=${text.length}`,
    );
    expect(response.status).toBe(200);
    expect(text.length).toBe(391);
    outcomes.push(await request(1));
    await Bun.sleep(100);
    outcomes.push(await request(2));
  } finally {
    server.stop(true);
  }

  trace(
    `outcomes scenario=${scenario} values=${outcomes.map((outcome) => (outcome ? "pass" : "fail")).join(",")}`,
  );
  return { remotePorts, outcomes };
}

test("Bun delivers the first slow response on a warmed keep-alive connection", async () => {
  const result = await runScenario("slow");
  expect(result.remotePorts[0]).toBeGreaterThan(0);
  expect(result.remotePorts[1]).toBe(result.remotePorts[0]);
  expect(result.outcomes).toEqual([true, true]);
});

test("Bun delivers the first browser-backed response on a warmed keep-alive connection", async () => {
  const result = await runScenario("browser");
  expect(result.remotePorts[0]).toBeGreaterThan(0);
  expect(result.remotePorts[1]).toBe(result.remotePorts[0]);
  expect(result.outcomes).toEqual([true, true]);
});
