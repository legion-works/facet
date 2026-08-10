import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureService } from "../../src/cli/spawn-service";
import { startFacetService } from "../../src/service/server";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";

const scratch = join(tmpdir(), `facet-insecure-threading-${crypto.randomUUID()}`);
const children: Bun.Subprocess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  rmSync(scratch, { recursive: true, force: true });
});

function makeFixture(): { home: string; records: string; runner: string; tier1: string } {
  const home = join(scratch, crypto.randomUUID());
  mkdirSync(home, { recursive: true });
  const records = join(home, "records.jsonl");
  const runner = join(home, "tier0-runner.ts");
  const tier1 = join(home, "tier1-runner.ts");
  const source = (kind: string) => `
import { appendFileSync } from "node:fs";
const records = ${JSON.stringify(records)};
export function create${kind}Runner(level: number) {
  appendFileSync(records, JSON.stringify({ kind: ${JSON.stringify(kind)}, level }) + "\\n");
  return async () => ({ status: "ok", tier: ${kind === "Tier0" ? 0 : 1} });
}
export const run${kind} = async () => ({ status: "ok", tier: ${kind === "Tier0" ? 0 : 1} });
`;
  writeFileSync(runner, source("Tier0"));
  writeFileSync(tier1, source("Tier1"));
  return { home, records, runner, tier1 };
}

function normalizeReadyStream(stderr: string): string {
  return stderr
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      for (const key of ["timestamp", "pid", "port", "url"]) delete parsed[key];
      return JSON.stringify(parsed);
    })
    .join("\n");
}

async function boot(fixture: ReturnType<typeof makeFixture>, level?: string) {
  const args = [
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
    fixture.runner,
  ];
  if (level !== undefined) {
    args.push("--tier1-runner-path", fixture.tier1);
  }
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      FACET_HOME: fixture.home,
      ...(level === undefined ? {} : { FACET_INSECURE: level }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const stderr = await new Response(child.stderr).text();
  return { code: await child.exited, stderr };
}

describe("insecure level boot threading", () => {
  test("absent and zero preserve the secure boot envelope", async () => {
    const absent = makeFixture();
    const explicit = makeFixture();
    const absentResult = await boot(absent);
    const explicitResult = await boot(explicit, "0");
    if (absentResult.code !== 0) throw new Error(absentResult.stderr);
    if (explicitResult.code !== 0) throw new Error(explicitResult.stderr);
    expect(absentResult.code).toBe(0);
    expect(explicitResult.code).toBe(0);
    const normalisedAbsent = normalizeReadyStream(absentResult.stderr);
    const normalisedExplicit = normalizeReadyStream(explicitResult.stderr);
    expect(normalisedAbsent).toBe(normalisedExplicit);
    expect(normalisedAbsent).toContain('"event":"service.ready"');
    expect(absentResult.stderr).not.toContain("insecure");
    expect(explicitResult.stderr).not.toContain("insecure");
    expect(readFileSync(absent.records, "utf8")).toBe(readFileSync(explicit.records, "utf8"));
  });

  test.each(["1", "2", "3"])("passes level %s to both runner factories", async (level) => {
    const fixture = makeFixture();
    const result = await boot(fixture, level);
    if (result.code !== 0) throw new Error(result.stderr);
    expect(result.code).toBe(0);
    const records = readFileSync(fixture.records, "utf8");
    expect(records).toContain(`{"kind":"Tier0","level":${level}}`);
    expect(records).toContain(`{"kind":"Tier1","level":${level}}`);
  });

  test.each(["1", "2", "3"])(
    "emits an unsuppressible warning before ready at level %s",
    async (level) => {
      const fixture = makeFixture();
      const result = await boot(fixture, level);
      expect(result.code).toBe(0);
      const lines = result.stderr.trim().split("\n");
      expect(lines[0]).toBe(`WARN: FACET_INSECURE=${level} — manual insecure level ${level}`);
      const ready = JSON.parse(lines[1]!) as Record<string, unknown>;
      expect(ready).toMatchObject({
        event: "service.ready",
        insecureLevel: Number(level),
        insecureReason: `manual insecure level ${level}`,
      });
    },
  );

  test("insecure warning ignores plausible suppressor environment variables", async () => {
    const fixture = makeFixture();
    const args = [
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
      fixture.runner,
      "--tier1-runner-path",
      fixture.tier1,
    ];
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        FACET_HOME: fixture.home,
        FACET_INSECURE: "1",
        FACET_QUIET: "1",
        NO_COLOR: "1",
        CI: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toContain("WARN: FACET_INSECURE=1");
  });

  test.each(["4", "abc", "1.5"])(
    "rejects invalid FACET_INSECURE=%s before binding",
    async (level) => {
      const fixture = makeFixture();
      const result = await boot(fixture, level);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("FACET_INSECURE");
      expect(result.stderr).not.toContain('"event":"service.ready"');
      expect(existsSync(join(fixture.home, "facet.lock"))).toBe(false);
    },
  );

  test("secure CLI spawn argv excludes Tier 1 runner path", async () => {
    const fixture = makeFixture();
    let stderrMode: "ignore" | "inherit" | undefined;
    const argv: readonly string[] | undefined = await (async () => {
      let captured: readonly string[] | undefined;
      await ensureService(
        {
          env: { ...process.env, FACET_HOME: fixture.home, FACET_INSECURE: "0" },
          tier0RunnerPath: fixture.runner,
          tier1RunnerPath: fixture.tier1,
          idleTimeoutMs: 100,
          readyTimeoutMs: 5_000,
        },
        {
          onServiceSpawn: (args, stderr) => {
            captured = args;
            stderrMode = stderr;
          },
        },
      );
      return captured;
    })();
    expect(argv).toBeDefined();
    expect(argv).toContain("--tier0-runner-path");
    expect(argv).not.toContain("--tier1-runner-path");
    expect(stderrMode).toBe("ignore");
  });

  test("insecure CLI spawn inherits stderr so the boot warning reaches the operator", async () => {
    const fixture = makeFixture();
    let stderrMode: "ignore" | "inherit" | undefined;
    await ensureService(
      {
        env: { ...process.env, FACET_HOME: fixture.home, FACET_INSECURE: "1" },
        tier0RunnerPath: fixture.runner,
        tier1RunnerPath: fixture.tier1,
        idleTimeoutMs: 100,
        readyTimeoutMs: 5_000,
      },
      {
        onServiceSpawn: (_args, stderr) => {
          stderrMode = stderr;
        },
      },
    );
    expect(stderrMode).toBe("inherit");
  });

  test("level 0 remains secure if FACET_INSECURE changes before publish", async () => {
    const home = join(scratch, "direct-service");
    mkdirSync(home, { recursive: true });
    const old = process.env.FACET_INSECURE;
    const service = await startFacetService({
      dbPath: join(home, "facet.sqlite"),
      installTokenPath: join(home, "install.token"),
      promoteTokenPath: join(home, "promote.token"),
      lockPath: join(home, "facet.lock"),
      idleTimeoutMs: 500,
      insecureLevel: 0,
      tier0Runner: stubTier0Runner,
    });
    try {
      process.env.FACET_INSECURE = "3";
      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${service.installToken}`,
        host: `127.0.0.1:${service.port}`,
      };
      const create = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: "facet.v1",
          requestId: "r-c",
          ok: true,
          data: { requestId: "r-c", command: "create", projectId: "p", slug: "s", title: "S" },
        }),
      });
      const created = (await create.json()) as { data: { artifact: { id: string } } };
      const publish = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: "facet.v1",
          requestId: "r-p",
          ok: true,
          data: {
            requestId: "r-p",
            command: "publish",
            artifactId: created.data.artifact.id,
            artifactType: "markdown",
            bytes: "aGk=",
          },
        }),
      });
      const envelope = (await publish.json()) as Record<string, unknown>;
      expect(JSON.stringify(envelope)).not.toContain("insecure");
    } finally {
      if (old === undefined) delete process.env.FACET_INSECURE;
      else process.env.FACET_INSECURE = old;
      await service.stop();
    }
  });
});
