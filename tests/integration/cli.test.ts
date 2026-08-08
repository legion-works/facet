/**
 * CLI contract integration tests.
 *
 * The CLI is the SOLE product contract — adapters consume the JSON
 * envelope on stdout. These tests pin that contract:
 *
 *   - stdout carries ONE FacetEnvelope per call (JSON), nothing else.
 *   - diagnostics (errors, kill switch, help text) go to stderr.
 *   - the kill switch FACET=off is a clean no-op (exit 0, no spawn).
 *   - the first cold call lazily spawns the service; subsequent calls
 *     reuse the same lock + metadata record.
 *   - 20 concurrent cold callers share one spawn via the same wait —
 *     exactly one service starts, exactly one metadata record is
 *     written, exactly one process is observed.
 *   - contract-version mismatch on the metadata record surfaces as a
 *     typed error, never a silent connection attempt.
 *   - the reserved `export` verb returns the typed reserved envelope
 *     with a documented adapter-safe exit code.
 *   - source ingestion works from --file AND from stdin.
 *
 * Each test is bounded (<10s) and tears down any service it spawned
 * in `afterEach`. Tests inject `io` into `runCli` so stdin/stdout/
 * stderr/env are hermetic — no real process plumbing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FACET_SCHEMA_VERSION, FacetEnvelopeSchema } from "../../src/shared/contracts/envelope";

import { runCli, type CliIo, type CliExit, type CliTestHooks } from "../../src/cli/main";

const scratchRoot = join(tmpdir(), `facet-cli-test-${crypto.randomUUID()}`);

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
});

afterEach(() => {
  // Tear down any service the test spawned by scanning every home
  // directory under the scratch root and signalling the child. The
  // service's idle controller will close the port + release the
  // lock on its own; the signal is a best-effort nudge so the test
  // doesn't have to wait for the idle window. The scan happens
  // BEFORE `rmSync` because the lock file lives inside each home
  // and we need the pid to send the signal.
  if (existsSync(scratchRoot)) {
    let entries: string[];
    try {
      entries = readdirSync(scratchRoot);
    } catch {
      rmSync(scratchRoot, { recursive: true, force: true });
      return;
    }
    for (const entry of entries) {
      const lockPath = join(scratchRoot, entry, "run", "facet.lock");
      if (!existsSync(lockPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
        if (typeof meta.pid === "number" && meta.pid > 0) {
          try {
            process.kill(meta.pid, "SIGTERM");
          } catch {
            // already dead
          }
        }
      } catch {
        // ignore — lock was unparseable; nothing to kill.
      }
    }
  }
  rmSync(scratchRoot, { recursive: true, force: true });
});

interface TestIo extends CliIo {
  readonly stdoutBuf: { value: string };
  readonly stderrBuf: { value: string };
}

/**
 * Each test gets a fresh home directory under /tmp so paths are
 * isolated and lock contention is impossible. The env passed to runCli
 * points FACET_HOME at it.
 */
function makeEnv(label: string): { env: NodeJS.ProcessEnv; home: string } {
  const home = join(scratchRoot, `${label}-${crypto.randomUUID()}`);
  mkdirSync(home, { recursive: true });
  return {
    home,
    env: {
      ...process.env,
      FACET_HOME: home,
    },
  };
}

/**
 * Build a fully-injected io bag. `stdinText` is exposed via a tiny
 * stream that the CLI can read from. stdout/stderr are string buffers
 * the test asserts against.
 */
function makeIo(stdinText = ""): TestIo {
  const stdoutBuf = { value: "" };
  const stderrBuf = { value: "" };
  const stdin = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stdinText.length > 0) {
        controller.enqueue(new TextEncoder().encode(stdinText));
      }
      controller.close();
    },
  });
  return {
    stdin,
    stdout: {
      write(chunk) {
        stdoutBuf.value += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        return true;
      },
    },
    stderr: {
      write(chunk) {
        stderrBuf.value += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        return true;
      },
    },
    env: process.env,
    stdoutBuf,
    stderrBuf,
  };
}

/**
 * Round-trip the on-stdout string through the strict envelope
 * schema; cast the result to a narrow shape so the test can branch
 * on `ok` and read `data` / `error` without further casts.
 */
function parseStdoutEnvelope(text: string):
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, string | number | boolean | null> | undefined;
      };
    } {
  const parsed = FacetEnvelopeSchema.parse(JSON.parse(text));
  if (parsed.ok) {
    return { ok: true, data: parsed.data as Record<string, unknown> };
  }
  return { ok: false, error: parsed.error };
}

async function runOnce(args: string[], io: TestIo): Promise<CliExit> {
  return runCli(args, io);
}

describe("cli contract — surface", () => {
  test("--help prints usage including every verb, the stdin example, and the stdout-is-JSON line", async () => {
    const { env } = makeEnv("help");
    const io = makeIo();
    const exit = await runCli(["--help"], { ...io, env });
    expect(exit.code).toBe(0);
    expect(io.stdoutBuf.value).toContain("facet");
    expect(io.stdoutBuf.value).toContain("publish");
    expect(io.stdoutBuf.value).toContain("read-back");
    expect(io.stdoutBuf.value).toContain("status");
    expect(io.stdoutBuf.value).toContain("create");
    expect(io.stdoutBuf.value).toContain("list");
    expect(io.stdoutBuf.value).toContain("open");
    expect(io.stdoutBuf.value).toContain("promote");
    expect(io.stdoutBuf.value).toContain("instantiate");
    expect(io.stdoutBuf.value).toContain("pin");
    expect(io.stdoutBuf.value).toContain("stdout is");
  });

  test("--version prints version + contractVersion", async () => {
    const { env } = makeEnv("version");
    const io = makeIo();
    const exit = await runCli(["--version"], { ...io, env });
    expect(exit.code).toBe(0);
    expect(io.stdoutBuf.value).toContain(FACET_SCHEMA_VERSION);
    expect(io.stdoutBuf.value).toMatch(/facet \d+\.\d+\.\d+/);
  });

  test("--version --json returns the strict envelope (single line, parseable)", async () => {
    const { env } = makeEnv("version-json");
    const io = makeIo();
    const exit = await runCli(["--version", "--json"], { ...io, env });
    expect(exit.code).toBe(0);
    const env1 = parseStdoutEnvelope(io.stdoutBuf.value);
    expect(env1.ok).toBe(true);
    if (env1.ok) {
      const data = env1.data;
      expect(data["contractVersion"]).toBe(FACET_SCHEMA_VERSION);
      expect(typeof data["version"]).toBe("string");
    }
  });
});

describe("cli contract — kill switch", () => {
  test("FACET=off → exit 0, no envelope on stdout, no service spawned, no lock or metadata written", async () => {
    const { env, home } = makeEnv("off");
    env.FACET = "off";
    const io = makeIo();
    const exit = await runCli(["status", "--artifact-id", "x"], { ...io, env });
    expect(exit.code).toBe(0);
    // stdout is empty (no envelope — the kill switch is a no-op).
    expect(io.stdoutBuf.value).toBe("");
    // No service state was written to disk.
    const lockPath = join(home, "run", "facet.lock");
    const dbPath = join(home, "db", "facet.sqlite");
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("cli contract — lazy spawn", () => {
  test("cold call spawns the service; the second call reuses the same lock record", async () => {
    const { env, home } = makeEnv("lazy");
    const io = makeIo();
    // First call: cold. Must spawn, must work end-to-end.
    const first = await runCli(["list", "--project-id", "p"], { ...io, env });
    expect(first.code).toBe(0);
    const lockPath = join(home, "run", "facet.lock");
    expect(existsSync(lockPath)).toBe(true);
    const firstMeta = JSON.parse(readFileSync(lockPath, "utf8")) as {
      pid: number;
      startTime: number;
      port: number;
      contractVersion: string;
    };
    // Second call: same home, same lock, same service.
    const io2 = makeIo();
    const second = await runCli(["list", "--project-id", "p"], { ...io2, env });
    expect(second.code).toBe(0);
    const secondMeta = JSON.parse(readFileSync(lockPath, "utf8")) as {
      pid: number;
      startTime: number;
      port: number;
    };
    expect(secondMeta.pid).toBe(firstMeta.pid);
    expect(secondMeta.startTime).toBe(firstMeta.startTime);
    expect(secondMeta.port).toBe(firstMeta.port);
  });

  test("20 concurrent cold callers share ONE REAL spawn (counter proves it; non-vacuous proof in same test)", async () => {
    const { env, home } = makeEnv("concurrent");
    const N = 20;

    // 1. 20 concurrent cold callers via the normal inflight path.
    //    The onServiceSpawn hook fires on every real child_process.spawn;
    //    the in-process inflight map is what keeps the count at 1.
    const counter = { value: 0 };
    const hooks: CliTestHooks = {
      onServiceSpawn: () => {
        counter.value += 1;
      },
    };
    const ios = Array.from({ length: N }, () => makeIo());
    const exits = await Promise.all(
      ios.map((io) => runCli(["status", "--artifact-id", "does-not-exist"], { ...io, env }, hooks)),
    );
    // Every call completed; the artifact-not-found code lands in the
    // envelope body (adapter-safe), not as a crash exit code.
    for (const e of exits) {
      expect(e.code).toBe(0);
    }
    // The spawn counter is the meaningful assertion: exactly ONE
    // real spawn happened across the 20 concurrent callers. The
    // earlier lock-metadata-only assertion was vacuous — a
    // broken-inflight impl still produces one lock winner and
    // one metadata record, so the lock check could not detect it.
    expect(counter.value).toBe(1);

    // Tautological cross-check (the old, weaker assertion): the
    // lock record still shows a single owner.
    const lockPath = join(home, "run", "facet.lock");
    expect(existsSync(lockPath)).toBe(true);
    const meta = JSON.parse(readFileSync(lockPath, "utf8")) as {
      pid: number;
      startTime: number;
    };
    const pids = new Set(exits.map((e) => e.spawnedPid).filter((p): p is number => p !== null));
    expect(pids.size).toBe(1);
    const firstExited = exits[0];
    if (firstExited === undefined) throw new Error("no exits");
    const spawnedPid = firstExited.spawnedPid;
    if (spawnedPid === null) throw new Error("no spawnedPid");
    expect(spawnedPid).toBe(meta.pid);

    // 2. Non-vacuous proof: with the inflight map bypassed, the same
    //    20-call burst produces 20 spawns. The delta (1 vs 20) is
    //    what the concurrency test actually pins — removing the
    //    inflight path would make THIS assertion fail.
    const brokenCounter = { value: 0 };
    const brokenHooks: CliTestHooks = {
      onServiceSpawn: () => {
        brokenCounter.value += 1;
      },
      bypassInflight: true,
    };
    // Each caller uses its own home so the lock-precheck path does
    // not short-circuit (otherwise the broken impl would only spawn
    // once for the first caller and hit the precheck for the rest).
    const brokenHomes: { env: NodeJS.ProcessEnv; home: string }[] = [];
    for (let i = 0; i < N; i += 1) {
      const bhome = join(scratchRoot, `broken-${crypto.randomUUID()}`);
      mkdirSync(bhome, { recursive: true });
      brokenHomes.push({
        home: bhome,
        env: { ...process.env, FACET_HOME: bhome },
      });
    }
    const brokenIos = brokenHomes.map(() => makeIo());
    await Promise.all(
      brokenHomes.map((h, i) => {
        const io = brokenIos[i];
        if (io === undefined) throw new Error("missing io");
        return runCli(["list", "--project-id", "p"], { ...io, env: h.env }, brokenHooks);
      }),
    );
    // The broken path (bypassInflight + unique homes) produces 20
    // real spawns. The shared path above produced 1. The 20x delta
    // is the proof that the inflight map is doing its job.
    expect(brokenCounter.value).toBe(N);
  }, 60_000);
});

describe("cli contract — wire", () => {
  test("every v1 verb emits exactly ONE strict envelope on stdout", async () => {
    const { env } = makeEnv("verbs");
    // create
    const createIo = makeIo();
    const createExit = await runOnce(
      ["create", "--project-id", "p", "--slug", "s", "--title", "S"],
      { ...createIo, env },
    );
    expect(createExit.code).toBe(0);
    const createEnv = parseStdoutEnvelope(createIo.stdoutBuf.value);
    expect(createEnv.ok).toBe(true);
    if (!createEnv.ok) throw new Error("create must succeed");
    expect(createEnv.data["command"]).toBe("create");
    const artifact = createEnv.data["artifact"] as { id: string };
    const artifactId = artifact.id;

    // publish from --file
    const filePath = join(scratchRoot, "src.md");
    writeFileSync(filePath, "hello", "utf8");
    const publishIo = makeIo();
    const publishExit = await runOnce(
      ["publish", "--artifact-id", artifactId, "--type", "markdown", "--file", filePath],
      { ...publishIo, env },
    );
    expect(publishExit.code).toBe(0);
    const publishEnv = parseStdoutEnvelope(publishIo.stdoutBuf.value);
    expect(publishEnv.ok).toBe(true);
    if (!publishEnv.ok) throw new Error("publish must succeed");

    // publish from stdin (-)
    const stdinIo = makeIo("from-stdin");
    const stdinExit = await runOnce(
      ["publish", "--artifact-id", artifactId, "--type", "markdown", "--file", "-"],
      { ...stdinIo, env },
    );
    expect(stdinExit.code).toBe(0);
    const stdinEnv = parseStdoutEnvelope(stdinIo.stdoutBuf.value);
    expect(stdinEnv.ok).toBe(true);

    // list
    const listIo = makeIo();
    const listExit = await runOnce(["list", "--project-id", "p"], { ...listIo, env });
    expect(listExit.code).toBe(0);
    const listEnv = parseStdoutEnvelope(listIo.stdoutBuf.value);
    expect(listEnv.ok).toBe(true);
    if (listEnv.ok) expect(listEnv.data["command"]).toBe("list");

    // status
    const statusIo = makeIo();
    const statusExit = await runOnce(["status", "--artifact-id", artifactId], { ...statusIo, env });
    expect(statusExit.code).toBe(0);
    const statusEnv = parseStdoutEnvelope(statusIo.stdoutBuf.value);
    expect(statusEnv.ok).toBe(true);
    if (statusEnv.ok) {
      expect(statusEnv.data["command"]).toBe("status");
      expect((statusEnv.data["revisionCount"] as number) > 0).toBe(true);
    }

    // read-back Tier 0 (publish now records a Tier 0 render_run, so
    // read-back returns the verdict bound to (artifactId, revisionSha)).
    const rbIo = makeIo();
    const pubSha = (publishEnv.data["revision"] as { sha256: string }).sha256;
    const rbExit = await runOnce(
      ["read-back", "--artifact-id", artifactId, "--revision-sha", pubSha, "--tier", "0"],
      { ...rbIo, env },
    );
    expect(rbExit.code).toBe(0);
    const rbEnv = parseStdoutEnvelope(rbIo.stdoutBuf.value);
    expect(rbEnv.ok).toBe(true);

    // pin
    const pinIo = makeIo();
    const pubRevisionId = (publishEnv.data["revision"] as { id: string }).id;
    const pinExit = await runOnce(["pin", "--revision-id", pubRevisionId, "--pinned", "true"], {
      ...pinIo,
      env,
    });
    expect(pinExit.code).toBe(0);
    const pinEnv = parseStdoutEnvelope(pinIo.stdoutBuf.value);
    expect(pinEnv.ok).toBe(true);
    if (pinEnv.ok) {
      expect(pinEnv.data["command"]).toBe("pin");
      expect(pinEnv.data["pinned"]).toBe(true);
    }
  }, 30_000);

  test("publish with no source bytes surfaces a typed invalid_request envelope (not a crash)", async () => {
    const { env } = makeEnv("nosrc");
    const warmIo = makeIo();
    await runCli(["list", "--project-id", "warm"], { ...warmIo, env });
    const io = makeIo("");
    const exit = await runCli(["publish", "--artifact-id", "x", "--type", "markdown"], {
      ...io,
      env,
    });
    expect(exit.code).toBe(0);
    const env1 = parseStdoutEnvelope(io.stdoutBuf.value);
    expect(env1.ok).toBe(false);
    if (!env1.ok) expect(env1.error.code).toBe("invalid_request");
  }, 20_000);

  test("every per-verb builder surfaces a typed invalid_request on missing args (not invalid_envelope)", async () => {
    // Builders that throw on missing args must throw a FacetError
    // with code="invalid_request" so the main catch passes the
    // typed code through unchanged. A raw `new Error(...)` would
    // be wrapped by `FacetError.from()` into the generic
    // `invalid_envelope` code and break adapter-side branching.
    const { env } = makeEnv("builder-codes");
    const warmIo = makeIo();
    await runCli(["list", "--project-id", "warm"], { ...warmIo, env });

    const cases: { args: string[]; label: string }[] = [
      { args: ["status"], label: "status missing --artifact-id" },
      { args: ["list"], label: "list missing --project-id" },
      { args: ["create", "--project-id", "p", "--slug", "s"], label: "create missing --title" },
      { args: ["open", "--artifact-id", "x"], label: "open missing --revision-sha" },
      { args: ["pin", "--pinned", "true"], label: "pin missing --revision-id" },
      {
        args: ["promote", "--revision-id", "r", "--name", "n"],
        label: "promote missing --promoted-by",
      },
      {
        args: ["instantiate", "--name", "n", "--new-slug", "s"],
        label: "instantiate missing --promoted-by",
      },
      {
        args: ["read-back", "--artifact-id", "x", "--revision-sha", "not-a-sha"],
        label: "read-back malformed --revision-sha",
      },
    ];

    for (const tc of cases) {
      const io = makeIo();
      const exit = await runCli(tc.args, { ...io, env });
      // Typed error envelope; well-formed → exit 0 (envelope-first
      // policy), NOT 64 (which is reserved for pre-parse usage
      // errors the CLI cannot even envelope).
      expect(exit.code).toBe(0);
      const env1 = parseStdoutEnvelope(io.stdoutBuf.value);
      expect(env1.ok).toBe(false);
      if (!env1.ok) {
        // The builder threw a typed FacetError; the main catch
        // passed it through, preserving the `invalid_request` code
        // — NOT the generic `invalid_envelope` that a raw
        // `new Error(...)` would collapse to via FacetError.from().
        expect(env1.error.code).toBe("invalid_request");
      }
    }
  }, 60_000);
});

describe("cli contract — reserved + errors", () => {
  test("reserved `export` returns the reserved envelope and exits 0 (adapter-safe)", async () => {
    const { env } = makeEnv("export");
    const warmIo = makeIo();
    await runCli(["list", "--project-id", "warm"], { ...warmIo, env });
    const io = makeIo();
    const exit = await runCli(["export", "--format", "html"], { ...io, env });
    // Reserved verbs are NOT an error — the envelope carries
    // `accepted: false` so adapters can branch on the typed shape.
    expect(exit.code).toBe(0);
    const env1 = parseStdoutEnvelope(io.stdoutBuf.value);
    expect(env1.ok).toBe(true);
    if (env1.ok) {
      expect(env1.data["command"]).toBe("export");
      expect(env1.data["accepted"]).toBe(false);
      expect((env1.data["reason"] as string).length).toBeGreaterThan(0);
    }
  }, 20_000);

  test("unknown verb exits with a typed usage error envelope (adapter-safe)", async () => {
    const { env } = makeEnv("unknown");
    const io = makeIo();
    const exit = await runCli(["does-not-exist"], { ...io, env });
    // Typed usage error → exit 64 (EX_USAGE convention), envelope on stdout.
    expect(exit.code).toBe(64);
    const env1 = parseStdoutEnvelope(io.stdoutBuf.value);
    expect(env1.ok).toBe(false);
    if (!env1.ok) expect(env1.error.code).toBe("invalid_request");
  });

  test("contract-version mismatch on the metadata record surfaces as a typed error", async () => {
    const { env, home } = makeEnv("mismatch");
    // First, cold-start a real service so the install token + DB exist.
    const warmIo = makeIo();
    await runCli(["list", "--project-id", "p"], { ...warmIo, env });
    // Now forge a future-version lock record.
    const lockPath = join(home, "run", "facet.lock");
    const real = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    const forged = { ...real, contractVersion: "facet.v999" };
    writeFileSync(lockPath, JSON.stringify(forged), { mode: 0o600 });
    // The next CLI call must refuse to talk to the mismatched service.
    const io = makeIo();
    const exit = await runCli(["list", "--project-id", "p"], { ...io, env });
    // Typed error; the service is still owned by the same live pid
    // (we kept the pid/startTime/port intact), so we surface a typed
    // contract_version_mismatch without crashing.
    expect(exit.code).toBe(0);
    const env1 = parseStdoutEnvelope(io.stdoutBuf.value);
    expect(env1.ok).toBe(false);
    if (!env1.ok) {
      expect(env1.error.message.toLowerCase()).toContain("contract");
    }
  }, 30_000);
});
