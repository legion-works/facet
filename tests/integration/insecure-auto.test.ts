import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureService } from "../../src/cli/spawn-service";

const scratch = join(tmpdir(), `facet-insecure-auto-${crypto.randomUUID()}`);
const children: Bun.Subprocess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  rmSync(scratch, { recursive: true, force: true });
});

type Probe = { readonly available: boolean; readonly reason: string | null };

function makeFixture(): {
  home: string;
  records: string;
  tier0: string;
  tier1: string;
} {
  const home = join(scratch, crypto.randomUUID());
  mkdirSync(home, { recursive: true });
  const recordPath = join(home, "records.jsonl");
  const tier0 = join(home, "tier0-runner.ts");
  const tier1 = join(home, "tier1-runner.ts");
  const source = (kind: "Tier0" | "Tier1") => `
import { appendFileSync } from "node:fs";
const records = ${JSON.stringify(recordPath)};
const probe = (name: string) => {
  appendFileSync(records, JSON.stringify({ event: "probe", name }) + "\\n");
  const value = process.env[name] ?? "pass";
  return { available: value === "pass", reason: value === "pass" ? null : value };
};
export function probe${kind === "Tier0" ? "Tier0Isolation" : "Tier1Availability"}() {
  return probe(${JSON.stringify(kind === "Tier0" ? "FACET_TEST_T0_PROBE" : "FACET_TEST_T1_PROBE")});
}
export function create${kind}Runner(level: number) {
  appendFileSync(records, JSON.stringify({ event: "factory", kind: ${JSON.stringify(kind)}, level }) + "\\n");
  return async (input: any) => ${
    kind === "Tier0"
      ? `({
    tier: 0,
    status: "ok",
    revisionSha: input.revisionSha,
    expected: input.lexical,
    observed: { rendererRootSvgCount: 0, graphCount: 0, mermaidNodeCount: 0, visibleSvgCount: 0, opaqueRegionCount: 0, externalImageCount: 0, errorCount: 0 },
  })`
      : `({
    tier: 1,
    status: "ok",
    artifactId: "worker-placeholder",
    revisionSha: input.revisionSha,
    expected: input.lexical,
    observed: { rendererRootSvgCount: 0, graphCount: 0, mermaidNodeCount: 0, visibleSvgCount: 0, opaqueRegionCount: 0, externalImageCount: 0, errorCount: 0 },
    screenshotPath: null,
    consolePath: null,
  })`
  };
}
`;
  writeFileSync(tier0, source("Tier0"));
  writeFileSync(tier1, source("Tier1"));
  return { home, records: recordPath, tier0, tier1 };
}

async function boot(
  fixture: ReturnType<typeof makeFixture>,
  options: { floor: string; auto?: string; t0?: Probe; t1?: Probe },
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "src/service/main.ts",
      "--db-path",
      join(fixture.home, "facet.sqlite"),
      "--install-token-path",
      join(fixture.home, "install.token"),
      "--promote-token-path",
      join(fixture.home, "promote.token"),
      "--lock-path",
      join(fixture.home, "facet.lock"),
      "--idle-timeout-ms",
      "100",
      "--tier0-runner-path",
      fixture.tier0,
      "--tier1-runner-path",
      fixture.tier1,
    ],
    {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        FACET_HOME: fixture.home,
        FACET_INSECURE: options.floor,
        ...(options.auto === undefined ? {} : { FACET_INSECURE_AUTO: options.auto }),
        FACET_TEST_T0_PROBE:
          options.t0?.available === false ? (options.t0.reason ?? "t0 failed") : "pass",
        FACET_TEST_T1_PROBE:
          options.t1?.available === false ? (options.t1.reason ?? "t1 failed") : "pass",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  children.push(child);
  const stderr = await new Response(child.stderr).text();
  return { code: await child.exited, stderr };
}

function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("opt-in insecure automatic fallback", () => {
  test.each([
    ["0", undefined, "pass", "fail", 0, undefined],
    ["0", "1", "pass", "fail", 1, /auto:/],
    ["0", "1", "fail", "pass", 2, /auto:/],
    ["1", "1", "pass", "pass", 1, /manual insecure level 1/],
    ["1", "1", "pass", "fail", 1, /manual insecure level 1/],
    ["1", "1", "fail", "pass", 2, /auto:/],
    ["2", "1", "pass", "pass", 2, /manual insecure level 2/],
    ["3", "1", "pass", "pass", 3, /manual insecure level 3/],
  ] as const)(
    "composes floor=%s auto=%s t0=%s t1=%s into level %s",
    async (floor, auto, t0, t1, expectedLevel, expectedReason) => {
      const fixture = makeFixture();
      const result = await boot(fixture, {
        floor,
        ...(auto === undefined ? {} : { auto }),
        t0: { available: t0 === "pass", reason: t0 === "pass" ? null : "t0 unavailable" },
        t1: { available: t1 === "pass", reason: t1 === "pass" ? null : "t1 unavailable" },
      });
      expect(result.code).toBe(0);
      const all = readRecords(fixture.records);
      const factory = all.find((entry) => entry.event === "factory" && entry.kind === "Tier0");
      expect(factory?.level).toBe(expectedLevel);
      const probes = all.filter((entry) => entry.event === "probe").map((entry) => entry.name);
      if (floor === "0" && auto === "1" && t0 === "fail")
        expect(probes).toEqual(["FACET_TEST_T0_PROBE"]);
      if (floor === "0" && auto === "1" && t0 === "pass")
        expect(probes).toEqual(["FACET_TEST_T0_PROBE", "FACET_TEST_T1_PROBE"]);
      if (auto !== "1") expect(probes).toEqual([]);
      if (floor === "1" && auto === "1") expect(probes).toEqual(["FACET_TEST_T0_PROBE"]);
      if (expectedReason !== undefined) {
        const warning = result.stderr.split("\n")[0];
        expect(warning).toMatch(expectedReason);
      }
    },
  );

  test.each(["0", "00", "true", "yes"])("FACET_INSECURE_AUTO=%s is off", async (auto) => {
    const fixture = makeFixture();
    const result = await boot(fixture, {
      floor: "0",
      auto,
      t0: { available: false, reason: "t0 unavailable" },
      t1: { available: false, reason: "t1 unavailable" },
    });
    expect(result.code).toBe(0);
    expect(readRecords(fixture.records).filter((entry) => entry.event === "probe")).toEqual([]);
    expect(result.stderr).not.toContain("WARN: FACET_INSECURE");
  });

  test("automatic fallback reason and level remain immutable during a live command", async () => {
    const fixture = makeFixture();
    const child = Bun.spawn(
      [
        process.execPath,
        "src/service/main.ts",
        "--db-path",
        join(fixture.home, "facet.sqlite"),
        "--install-token-path",
        join(fixture.home, "install.token"),
        "--promote-token-path",
        join(fixture.home, "promote.token"),
        "--lock-path",
        join(fixture.home, "facet.lock"),
        "--idle-timeout-ms",
        "5000",
        "--tier0-runner-path",
        fixture.tier0,
        "--tier1-runner-path",
        fixture.tier1,
      ],
      {
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          FACET_HOME: fixture.home,
          FACET_INSECURE: "0",
          FACET_INSECURE_AUTO: "1",
          FACET_TEST_T0_PROBE: "initial t0 failure",
          FACET_TEST_T1_PROBE: "pass",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    children.push(child);
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    let stderr = "";
    while (!stderr.includes("\n", stderr.indexOf("\n") + 1)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("service exited before ready");
      stderr += decoder.decode(chunk.value, { stream: true });
    }
    const lines = stderr.trim().split("\n");
    expect(lines[0]).toContain("WARN: FACET_INSECURE=2 — auto:initial t0 failure");
    const lock = JSON.parse(readFileSync(join(fixture.home, "facet.lock"), "utf8")) as {
      port: number;
    };
    const ready = { url: `http://127.0.0.1:${lock.port}` };
    const previousEnv = {
      insecure: process.env.FACET_INSECURE,
      auto: process.env.FACET_INSECURE_AUTO,
      probe: process.env.FACET_TEST_T0_PROBE,
    };
    process.env.FACET_INSECURE = "3";
    process.env.FACET_INSECURE_AUTO = "0";
    process.env.FACET_TEST_T0_PROBE = "pass";
    writeFileSync(fixture.tier0, readFileSync(fixture.tier0, "utf8").replace("initial", "mutated"));

    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${readFileSync(join(fixture.home, "install.token"), "utf8").trim()}`,
      host: new URL(ready.url).host,
    };
    const create = await fetch(`${ready.url}/api/v1/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: "facet.v1",
        requestId: "immutability-create",
        ok: true,
        data: {
          requestId: "immutability-create",
          command: "create",
          projectId: "p",
          slug: "immutability",
          title: "immutability",
        },
      }),
    });
    const created = (await create.json()) as { data: { artifact: { id: string } } };
    const publish = await fetch(`${ready.url}/api/v1/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: "facet.v1",
        requestId: "immutability-publish",
        ok: true,
        data: {
          requestId: "immutability-publish",
          command: "publish",
          artifactId: created.data.artifact.id,
          artifactType: "markdown",
          bytes: Buffer.from("hello", "utf8").toString("base64"),
        },
      }),
    });
    const envelope = JSON.stringify(await publish.json());
    expect(envelope).toContain('"level":2');
    expect(envelope).toContain("auto:initial t0 failure");
    expect(readRecords(fixture.records).filter((entry) => entry.event === "probe")).toHaveLength(1);
    if (previousEnv.insecure === undefined) delete process.env.FACET_INSECURE;
    else process.env.FACET_INSECURE = previousEnv.insecure;
    if (previousEnv.auto === undefined) delete process.env.FACET_INSECURE_AUTO;
    else process.env.FACET_INSECURE_AUTO = previousEnv.auto;
    if (previousEnv.probe === undefined) delete process.env.FACET_TEST_T0_PROBE;
    else process.env.FACET_TEST_T0_PROBE = previousEnv.probe;
  });

  test("CLI auto mode passes the Tier 1 module and inherits boot diagnostics", async () => {
    const fixture = makeFixture();
    let argv: readonly string[] | undefined;
    let stderr: "ignore" | "inherit" | undefined;
    await ensureService(
      {
        env: {
          ...process.env,
          FACET_HOME: fixture.home,
          FACET_INSECURE: "0",
          FACET_INSECURE_AUTO: "1",
          FACET_TEST_T0_PROBE: "pass",
          FACET_TEST_T1_PROBE: "pass",
        },
        tier0RunnerPath: fixture.tier0,
        tier1RunnerPath: fixture.tier1,
        idleTimeoutMs: 100,
        readyTimeoutMs: 5_000,
      },
      {
        onServiceSpawn: (args, mode) => {
          argv = args;
          stderr = mode;
        },
      },
    );
    expect(argv).toContain("--tier1-runner-path");
    expect(stderr).toBe("inherit");
  });
});
