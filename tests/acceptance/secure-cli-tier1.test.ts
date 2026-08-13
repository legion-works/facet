import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FacetEnvelopeSchema } from "../../src/shared/contracts/envelope";

const homes: string[] = [];
const mermaidFixture = resolve(import.meta.dir, "../fixtures/mermaid-flowchart.md");
const forgedFixture = resolve(import.meta.dir, "../fixtures/hostile-monkeypatch.json");

afterEach(() => {
  for (const home of homes.splice(0)) {
    const lockPath = join(home, "run", "facet.lock");
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
        if (typeof lock.pid === "number") process.kill(lock.pid, "SIGTERM");
      } catch {
        // The detached service can win this cleanup race by releasing its lock first.
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
});

function secureEnv(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FACET_INSECURE;
  delete env.FACET_INSECURE_AUTO;
  return { ...env, ...overrides, FACET_HOME: home, FACET_INSECURE: "0" };
}

function successfulData(
  envelope: ReturnType<typeof FacetEnvelopeSchema.parse>,
): Record<string, unknown> {
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) throw new Error(`command failed: ${envelope.error.code}`);
  return envelope.data as Record<string, unknown>;
}

async function invoke(
  home: string,
  args: readonly string[],
  overrides: NodeJS.ProcessEnv = {},
): Promise<ReturnType<typeof FacetEnvelopeSchema.parse>> {
  const child = Bun.spawn(["nice", "-n", "19", process.execPath, "src/cli/main.ts", ...args], {
    cwd: resolve(import.meta.dir, "../.."),
    env: secureEnv(home, overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  return FacetEnvelopeSchema.parse(JSON.parse(stdout));
}

async function publishAndReadBack(
  home: string,
  fixturePath = mermaidFixture,
  artifactType: "markdown" | "mermaid" = "mermaid",
  overrides: NodeJS.ProcessEnv = {},
) {
  const created = await invoke(
    home,
    ["create", "--project-id", "secure-tier1", "--slug", "secure-cli", "--title", "Secure CLI"],
    overrides,
  );
  const artifact = successfulData(created).artifact as { id: string };

  const published = await invoke(
    home,
    ["publish", "--artifact-id", artifact.id, "--type", artifactType, "--file", fixturePath],
    overrides,
  );
  const revision = successfulData(published).revision as { sha256: string };

  return invoke(
    home,
    [
      "read-back",
      "--artifact-id",
      artifact.id,
      "--revision-sha",
      revision.sha256,
      "--tier",
      "visual",
    ],
    overrides,
  );
}

test("secure CLI boot records a typed Tier 1 launcher failure when the pinned shell is absent", async () => {
  const home = mkdtempSync(join(tmpdir(), "facet-secure-cli-tier1-missing-"));
  homes.push(home);

  const readBack = await publishAndReadBack(home, mermaidFixture, "mermaid", {
    FACET_TIER1_BROWSER_CACHE: join(home, "empty-browser-cache"),
  });

  expect(readBack).toMatchObject({
    ok: true,
    data: {
      command: "readBack",
      verdict: {
        tier: 1,
        status: "error",
        observed: {
          errorCount: 1,
          discriminativeErrors: [expect.objectContaining({ code: "tier1_launcher_missing" })],
        },
      },
    },
  });
}, 60_000);

test("secure CLI boot records a Tier 1 visual verdict through the detached service", async () => {
  const home = mkdtempSync(join(tmpdir(), "facet-secure-cli-tier1-"));
  homes.push(home);

  const readBack = await publishAndReadBack(home);

  // Removing the secure Tier 1 wiring makes this a revision_not_found response.
  expect(readBack).toMatchObject({
    ok: true,
    data: {
      command: "readBack",
      verdict: {
        tier: 1,
        status: "ok",
        observed: { rendererRootSvgCount: 1, graphCount: 1, errorCount: 0 },
      },
    },
  });
}, 180_000);

test("secure CLI distinguishes a Tier 1 verdict failure from an unavailable browser", async () => {
  const home = mkdtempSync(join(tmpdir(), "facet-secure-cli-tier1-forged-"));
  homes.push(home);

  const readBack = await publishAndReadBack(home, forgedFixture, "markdown");

  expect(readBack).toMatchObject({
    ok: true,
    data: {
      command: "readBack",
      verdict: {
        tier: 1,
        status: "tampered",
      },
    },
  });
}, 180_000);
