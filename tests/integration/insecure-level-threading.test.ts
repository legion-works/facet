import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(absentResult.stderr.replace(/timestamp[^,]+,/, "timestamp:<volatile>,")).toContain(
      '"event":"service.ready"',
    );
    expect(explicitResult.stderr).not.toContain("insecure");
    expect(readFileSync(absent.records, "utf8")).toContain('"level":0');
    expect(readFileSync(explicit.records, "utf8")).toContain('"level":0');
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

  test.each(["4", "abc", "1.5"])(
    "rejects invalid FACET_INSECURE=%s before binding",
    async (level) => {
      const fixture = makeFixture();
      const result = await boot(fixture, level);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("FACET_INSECURE");
      expect(result.stderr).not.toContain('"event":"service.ready"');
    },
  );
});
