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
 *   - the `export` verb writes the artifact and mandatory sidecar locally
 *     while preserving the single JSON envelope on stdout.
 *   - source ingestion works from --file AND from stdin.
 *
 * Each test is bounded (<10s) and tears down any service it spawned
 * in `afterEach`. Tests inject `io` into `runCli` so stdin/stdout/
 * stderr/env are hermetic — no real process plumbing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FACET_SCHEMA_VERSION, FacetEnvelopeSchema } from "../../src/shared/contracts/envelope";
import { FacetError } from "../../src/shared/errors/facet-error";
import { ArtifactRepository } from "../../src/service/store/repository";
import { openDatabase } from "../../src/service/store/database";
import { runMigrations } from "../../src/service/store/migrations";

import {
  runCli,
  writeEnvelope,
  type CliIo,
  type CliExit,
  type CliTestHooks,
} from "../../src/cli/main";
import { buildPublishRequest } from "../../src/cli/commands/publish";
import { parseArgs } from "../../src/cli/parser";
import { printEnvelope } from "../../src/cli/output";

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

const SEEDED_OBSERVED = {
  rendererRootSvgCount: 1,
  graphCount: 0,
  mermaidNodeCount: 0,
  visibleSvgCount: 1,
  opaqueRegionCount: 0,
  externalImageCount: 0,
  errorCount: 0,
};

function seedRenderEvidence(
  home: string,
  screenshot: Uint8Array | null,
): {
  artifactId: string;
  revisionSha: string;
  screenshotPath: string | null;
} {
  const dbPath = join(home, "db", "facet.sqlite");
  const evidenceDir = join(home, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const db = openDatabase(dbPath);
  runMigrations(db);
  try {
    const repository = new ArtifactRepository(db, { evidenceRoot: evidenceDir });
    const project = repository.createProject({ projectRoot: "/facet" });
    const artifact = repository.createArtifact({
      projectId: project.id,
      slug: "seeded-render",
      title: "Seeded render",
    });
    const source = new Uint8Array([9, 8, 7, 6]);
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source,
    });
    const seededScreenshot = screenshot;
    const screenshotPath =
      seededScreenshot === null
        ? null
        : join(evidenceDir, "seeded", revision.sha256, "screenshot.png");
    if (screenshotPath !== null) {
      if (seededScreenshot === null) throw new Error("missing screenshot bytes");
      mkdirSync(join(evidenceDir, "seeded", revision.sha256), { recursive: true });
      writeFileSync(screenshotPath, seededScreenshot);
    }
    repository.recordRenderRun({
      revisionId: revision.id,
      tier: 1,
      status: "ok",
      expected: {},
      observed: SEEDED_OBSERVED,
      screenshotPath,
    });
    return { artifactId: artifact.id, revisionSha: revision.sha256, screenshotPath };
  } finally {
    db.close();
  }
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

async function runAdapter(
  adapter: string,
  args: string[],
  home: string,
  stdin = "",
): Promise<string> {
  const proc = Bun.spawn(["sh", adapter, ...args], {
    cwd: resolve(import.meta.dir, "../.."),
    env: { ...process.env, FACET_HOME: home },
    // The service child inherits stderr by design so insecure boot warnings
    // reach the operator. Keeping this adapter harness stderr ignored avoids
    // waiting for a detached child to close the test subprocess pipe.
    stdio: ["pipe", "pipe", "ignore"],
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (exitCode !== 0) {
    throw new Error(`adapter exited with code ${exitCode}`);
  }
  return stdout;
}

function normalizeAdapterValue(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeAdapterValue(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        normalizeAdapterValue(childValue, childKey),
      ]),
    );
  }
  if (
    key === "requestId" ||
    key === "id" ||
    key.endsWith("Id") ||
    key.endsWith("At") ||
    key.endsWith("Path") ||
    key === "timestamp"
  )
    return "<volatile>";
  return value;
}

function normalizeAdapterEnvelope(text: string): unknown {
  return normalizeAdapterValue(JSON.parse(text) as Record<string, unknown>);
}

describe("cli contract — surface", () => {
  test("export parser accepts positional id and keeps export --format distinct from meta --format", async () => {
    expect(parseArgs(["export", "artifact-1"])).toMatchObject({
      kind: "verb",
      verb: "export",
      args: { "artifact-id": "artifact-1" },
    });
    expect(
      parseArgs([
        "export",
        "artifact-1",
        "--revision",
        "a".repeat(64),
        "--format",
        "render",
        "--out",
        "out.png",
        "--force",
      ]),
    ).toMatchObject({
      kind: "verb",
      verb: "export",
      args: {
        "artifact-id": "artifact-1",
        revision: "a".repeat(64),
        format: "render",
        out: "out.png",
        force: true,
      },
    });
    expect(parseArgs(["export", "artifact-1", "--format", "invalid"]).kind).toBe("usage");
    expect(parseArgs(["export", "--format", "render"]).kind).toBe("usage");
    expect(parseArgs(["export", "artifact-1", "--no-sidecar"]).kind).toBe("usage");
    // `--format` is export-scoped (source|render); every other verb must
    // reject it with usage rather than silently dropping it. `withoutFormatFlags`
    // used to strip `--format <value>` before flag validation ran for any
    // non-export verb, so `list --format json` (or any typo'd value) ran
    // exactly as if the flag were absent.
    expect(parseArgs(["list", "--format", "json"]).kind).toBe("usage");
    expect(parseArgs(["publish", "--format", "typo"]).kind).toBe("usage");
    expect(parseArgs(["--version", "--format", "json"])).toEqual({
      kind: "version",
      format: "json",
    });
    expect(parseArgs(["--help", "--format", "text"])).toEqual({
      kind: "help",
      format: "text",
    });
  });

  test("meta --format json remains a version envelope", async () => {
    const { env } = makeEnv("version-meta-format");
    const io = makeIo();
    const exit = await runCli(["--version", "--format", "json"], { ...io, env });
    expect(exit.code).toBe(0);
    expect(parseStdoutEnvelope(io.stdoutBuf.value).ok).toBe(true);
  });

  test("export usage errors exit 64 before service startup", async () => {
    for (const [label, args] of [
      ["missing-id", ["export"]],
      ["unknown-format", ["export", "artifact-1", "--format", "bogus"]],
      ["no-sidecar", ["export", "artifact-1", "--no-sidecar"]],
    ] as const) {
      const { env, home } = makeEnv(`export-${label}`);
      const io = makeIo();
      const exit = await runCli(args, { ...io, env });
      expect(exit.code).toBe(64);
      expect(parseStdoutEnvelope(io.stdoutBuf.value).ok).toBe(false);
      expect(existsSync(join(home, "run", "facet.lock"))).toBe(false);
    }
  });

  test("--format on an ordinary verb is a usage error, exit 64, before service startup", async () => {
    const { env, home } = makeEnv("publish-format-typo");
    const io = makeIo();
    const exit = await runCli(["publish", "--format", "json"], { ...io, env });
    expect(exit.code).toBe(64);
    expect(parseStdoutEnvelope(io.stdoutBuf.value).ok).toBe(false);
    expect(existsSync(join(home, "run", "facet.lock"))).toBe(false);
  });

  test("publish parses --renderer canvas and builds a canvas request", () => {
    const parsed = parseArgs([
      "publish",
      "--artifact-id",
      "artifact-1",
      "--type",
      "chart",
      "--renderer",
      "canvas",
    ]);
    expect(parsed).toMatchObject({
      kind: "verb",
      verb: "publish",
      args: { renderer: "canvas" },
    });
    if (parsed.kind !== "verb") throw new Error("publish parser rejected canvas renderer");
    expect(
      buildPublishRequest(parsed.args, new TextEncoder().encode('{"mark":"bar"}')).renderer,
    ).toBe("canvas");
  });

  test("publish accepts --type html and builds the implemented type request", () => {
    const request = buildPublishRequest(
      { "artifact-id": "artifact-1", type: "html" },
      new TextEncoder().encode("<main>HTML</main>"),
    );
    expect(request.artifactType).toBe("html");
  });

  test("publish accepts --type tsx and defaults execution to static", () => {
    const request = buildPublishRequest(
      { "artifact-id": "artifact-1", type: "tsx" },
      new TextEncoder().encode("export default function App(){return null;}"),
    );
    expect(request.artifactType).toBe("tsx");
    expect(request.execution).toBe("static");
  });

  test("publish parses --execution interactive for tsx and reaches the request", () => {
    const parsed = parseArgs([
      "publish",
      "--artifact-id",
      "artifact-1",
      "--type",
      "tsx",
      "--execution",
      "interactive",
    ]);
    expect(parsed).toMatchObject({
      kind: "verb",
      verb: "publish",
      args: { type: "tsx", execution: "interactive" },
    });
    if (parsed.kind !== "verb") throw new Error("publish parser rejected --execution");
    const request = buildPublishRequest(
      parsed.args,
      new TextEncoder().encode("export default function App(){return null;}"),
    );
    expect(request.execution).toBe("interactive");
  });

  test("declares TSX execution mode through literal template argv", async () => {
    const { env } = makeEnv("tsx-declaration");
    const originalCwd = process.cwd();
    // Literal template paths are resolved from the caller's cwd, not the test file.
    process.chdir(resolve(import.meta.dir, "../.."));
    try {
      const createIo = makeIo();
      const createExit = await runCli(
        ["create", "--project-id", "p", "--slug", "tsx-declaration", "--title", "TSX declaration"],
        { ...createIo, env },
      );
      expect(createExit.code).toBe(0);
      const created = parseStdoutEnvelope(createIo.stdoutBuf.value);
      if (!created.ok) throw new Error("create must succeed");
      const artifactId = (created.data["artifact"] as { id: string }).id;

      const staticIo = makeIo();
      const staticExit = await runCli(
        [
          "publish",
          "--artifact-id",
          artifactId,
          "--type",
          "tsx",
          "--file",
          "templates/tsx-status-report.tsx",
        ],
        { ...staticIo, env },
      );
      expect(staticExit.code).toBe(0);
      const staticPublished = parseStdoutEnvelope(staticIo.stdoutBuf.value);
      if (!staticPublished.ok) throw new Error("static template publish must succeed");
      expect(staticPublished.data["revision"]).toMatchObject({ execution: "static" });
      const staticRevisionSha = (staticPublished.data["revision"] as { sha256: string }).sha256;
      const staticReadIo = makeIo();
      const staticReadExit = await runCli(
        [
          "read-back",
          "--artifact-id",
          artifactId,
          "--revision-sha",
          staticRevisionSha,
          "--tier",
          "0",
        ],
        { ...staticReadIo, env },
      );
      expect(staticReadExit.code).toBe(0);
      const staticRead = parseStdoutEnvelope(staticReadIo.stdoutBuf.value);
      if (!staticRead.ok) throw new Error("static template read-back must succeed");
      expect(staticRead.data["verdict"]).toMatchObject({
        status: "ok",
        execution: "static",
        observed: {
          errorCount: 0,
          html: { headingCount: 2, tableCount: 1 },
        },
      });

      const interactiveIo = makeIo();
      const interactiveExit = await runCli(
        [
          "publish",
          "--artifact-id",
          artifactId,
          "--type",
          "tsx",
          "--execution",
          "interactive",
          "--file",
          "templates/tsx-interactive-counter.tsx",
        ],
        { ...interactiveIo, env },
      );
      expect(interactiveExit.code).toBe(0);
      const interactivePublished = parseStdoutEnvelope(interactiveIo.stdoutBuf.value);
      if (!interactivePublished.ok) throw new Error("interactive template publish must succeed");
      expect(interactivePublished.data["revision"]).toMatchObject({ execution: "interactive" });
      const interactiveRevisionSha = (interactivePublished.data["revision"] as { sha256: string })
        .sha256;
      const interactiveReadIo = makeIo();
      const interactiveReadExit = await runCli(
        [
          "read-back",
          "--artifact-id",
          artifactId,
          "--revision-sha",
          interactiveRevisionSha,
          "--tier",
          "0",
        ],
        { ...interactiveReadIo, env },
      );
      expect(interactiveReadExit.code).toBe(0);
      const interactiveRead = parseStdoutEnvelope(interactiveReadIo.stdoutBuf.value);
      if (!interactiveRead.ok) throw new Error("interactive template read-back must succeed");
      expect(interactiveRead.data["verdict"]).toMatchObject({
        status: "ok",
        execution: "interactive",
        observed: {
          errorCount: 0,
        },
      });
      // The CLI integration tier has no Chromium surface. The acceptance
      // starter test proves the template's component-owned heading mounts.
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("publish rejects --execution interactive on non-tsx artifact types", () => {
    for (const type of ["markdown", "html"] as const) {
      expect(() =>
        buildPublishRequest(
          { "artifact-id": "artifact-1", type, execution: "interactive" },
          new TextEncoder().encode("hello"),
        ),
      ).toThrow(FacetError);
      try {
        buildPublishRequest(
          { "artifact-id": "artifact-1", type, execution: "interactive" },
          new TextEncoder().encode("hello"),
        );
      } catch (error) {
        expect((error as FacetError).code).toBe("invalid_request");
      }
    }
  });

  test("publish silently drops --execution static on non-tsx artifact types", () => {
    // `static` is the canonical default; carrying it on the wire for a
    // non-tsx type would force a byte-different contract for an
    // artifact type that does not honor the field. Drop it at the CLI
    // boundary so the wire request stays byte-identical to the
    // pre-tsx-arc shape.
    const request = buildPublishRequest(
      { "artifact-id": "artifact-1", type: "markdown", execution: "static" },
      new TextEncoder().encode("hello"),
    );
    expect(request.execution).toBeUndefined();
  });

  test("publish rejects an invalid renderer with typed invalid_request", () => {
    expect(() =>
      buildPublishRequest(
        { "artifact-id": "artifact-1", type: "chart", renderer: "webgl" },
        new TextEncoder().encode('{"mark":"bar"}'),
      ),
    ).toThrow(FacetError);
    try {
      buildPublishRequest(
        { "artifact-id": "artifact-1", type: "chart", renderer: "webgl" },
        new TextEncoder().encode('{"mark":"bar"}'),
      );
    } catch (error) {
      expect((error as FacetError).code).toBe("invalid_request");
    }
  });

  test("publish rejects an invalid --renderer value as a usage error before service startup", async () => {
    const { env } = makeEnv("renderer-usage");
    const io = makeIo('{"mark":"bar"}');
    const exit = await runCli(
      ["publish", "--artifact-id", "artifact-1", "--type", "chart", "--renderer", "webgl"],
      { ...io, env },
    );
    expect(exit.code).toBe(64);
    const envelope = parseStdoutEnvelope(io.stdoutBuf.value);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("invalid_request");
  });

  test("publish rejects --execution on a non-tsx type at the CLI surface", async () => {
    const { env } = makeEnv("execution-non-tsx");
    const io = makeIo("hello");
    const exit = await runCli(
      [
        "publish",
        "--artifact-id",
        "artifact-1",
        "--type",
        "markdown",
        "--execution",
        "interactive",
      ],
      { ...io, env },
    );
    expect(exit.code).toBe(0); // typed invalid_request is a well-formed envelope (exit 0)
    const envelope = parseStdoutEnvelope(io.stdoutBuf.value);
    if (envelope.ok) throw new Error("envelope unexpectedly ok");
    expect(envelope.error.code).toBe("invalid_request");
    expect(envelope.error.details).toEqual({ artifactType: "markdown", execution: "interactive" });
  });

  test("publish rejects --execution inferred with its allowed values before service startup", async () => {
    const { env } = makeEnv("execution-unknown");
    const io = makeIo("hello");
    const exit = await runCli(
      ["publish", "--artifact-id", "artifact-1", "--type", "tsx", "--execution", "inferred"],
      { ...io, env },
    );
    expect(exit.code).toBe(64);
    const envelope = parseStdoutEnvelope(io.stdoutBuf.value);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("invalid_request");
      expect(envelope.error.message).toContain("static, interactive");
      expect(envelope.error.details).toEqual({
        reason: "usage_error",
        flag: "--execution",
        allowedValues: "static, interactive",
      });
    }
  });

  test("publish without --type returns the typed allowed-type error", async () => {
    const { env } = makeEnv("type-omitted");
    const io = makeIo("hello");
    const exit = await runCli(["publish", "--artifact-id", "artifact-1"], { ...io, env });
    expect(exit.code).toBe(0);
    const envelope = parseStdoutEnvelope(io.stdoutBuf.value);
    if (envelope.ok) throw new Error("envelope unexpectedly ok");
    expect(envelope.error.code).toBe("invalid_request");
    expect(envelope.error.message).toContain("markdown, mermaid, svg, chart, html, tsx");
    expect(envelope.error.details).toEqual({ reason: "invalid_artifact_type" });
  });

  test("publish without --renderer preserves the svg request shape", () => {
    const request = buildPublishRequest(
      { "artifact-id": "artifact-1", type: "chart" },
      new TextEncoder().encode('{"mark":"bar"}'),
    );
    expect({ ...request, requestId: "<generated>" }).toEqual({
      command: "publish",
      requestId: "<generated>",
      artifactId: "artifact-1",
      artifactType: "chart",
      renderer: "svg",
      bytes: "eyJtYXJrIjoiYmFyIn0=",
    });
  });

  test("piped envelope bytes remain identical to the canonical output path", () => {
    const envelope = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: "req-fixed",
      ok: true as const,
      data: { command: "status", state: "dormant" },
    };
    const before = { value: "" };
    const after = { value: "" };
    const writer = {
      write(chunk: string | Uint8Array) {
        before.value += String(chunk);
        return true;
      },
    };
    const io = {
      stdout: {
        write(chunk: string | Uint8Array) {
          after.value += String(chunk);
          return true;
        },
        isTTY: false,
      },
      stderr: {
        write() {
          return true;
        },
      },
      env: {},
    } as unknown as CliIo;
    printEnvelope(writer, envelope);
    writeEnvelope(io, parseArgs(["status"]), envelope);
    expect(after.value).toBe(before.value);
  });

  test("spawns the service when invoked outside the repository root", async () => {
    const { env } = makeEnv("non-root-cwd");
    const io = makeIo();
    const originalCwd = process.cwd();

    process.chdir(scratchRoot);
    try {
      const exit = await runCli(
        ["create", "--project-id", "dogfood", "--slug", "outside-cwd", "--title", "Outside cwd"],
        { ...io, env },
      );

      expect(exit.code).toBe(0);
      const envelope = parseStdoutEnvelope(io.stdoutBuf.value);
      expect(envelope.ok).toBe(true);
      if (envelope.ok) expect(envelope.data.artifact).toBeDefined();
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("all harness adapters preserve the CLI envelope for publish and read-back", async () => {
    const repoRoot = resolve(import.meta.dir, "../..");
    const adapters = [
      join(repoRoot, "src/harness-adapters/opencode/facet.sh"),
      join(repoRoot, "src/harness-adapters/claude-code/facet.sh"),
      join(repoRoot, "src/harness-adapters/codex/facet.sh"),
    ];
    const normalizedRuns: unknown[] = [];
    for (const [index, adapter] of adapters.entries()) {
      const home = join(scratchRoot, `adapter-${index}-${crypto.randomUUID()}`);
      mkdirSync(home, { recursive: true });
      const created = JSON.parse(
        await runAdapter(
          adapter,
          ["create", "--project-id", "p", "--slug", "s", "--title", "S"],
          home,
        ),
      ) as { data: { artifact: { id: string } } };
      const artifactId = created.data.artifact.id;
      const published = JSON.parse(
        await runAdapter(
          adapter,
          ["publish", "--artifact-id", artifactId, "--type", "markdown", "--file", "-"],
          home,
          "adapter fixture",
        ),
      ) as { data: { revision: { sha256: string } } };
      const readBack = await runAdapter(
        adapter,
        [
          "read-back",
          "--artifact-id",
          artifactId,
          "--revision-sha",
          published.data.revision.sha256,
          "--tier",
          "0",
        ],
        home,
      );
      normalizedRuns.push({
        publish: normalizeAdapterEnvelope(JSON.stringify(published)),
        readBack: normalizeAdapterEnvelope(readBack),
      });
    }
    for (const run of normalizedRuns.slice(1)) expect(run).toEqual(normalizedRuns[0]);
  }, 60_000);

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
  test("render export reads seeded Tier 1 screenshot bytes and defaults to .png", async () => {
    const { env, home } = makeEnv("render-export");
    const screenshot = new Uint8Array([137, 80, 78, 71, 11, 12, 13]);
    const seeded = seedRenderEvidence(home, screenshot);
    const originalCwd = process.cwd();
    const exportCwd = join(scratchRoot, `render-export-cwd-${crypto.randomUUID()}`);
    mkdirSync(exportCwd, { recursive: true });
    process.chdir(exportCwd);
    try {
      const io = makeIo();
      const exit = await runCli(
        ["export", seeded.artifactId, "--revision", seeded.revisionSha, "--format", "render"],
        { ...io, env },
      );
      expect(exit.code).toBe(0);
      const envelope = parseStdoutEnvelope(io.stdoutBuf.value);
      if (!envelope.ok) throw new Error(`render export failed: ${JSON.stringify(envelope.error)}`);
      expect(envelope.ok).toBe(true);
      const expectedPath = join(exportCwd, `seeded-render-${seeded.revisionSha.slice(0, 7)}.png`);
      const expectedSidecarPath = join(
        exportCwd,
        `seeded-render-${seeded.revisionSha.slice(0, 7)}.facet.json`,
      );
      expect(readFileSync(expectedPath)).toEqual(Buffer.from(screenshot));
      expect(JSON.parse(readFileSync(expectedSidecarPath, "utf8"))).toEqual(
        envelope.data["sidecar"],
      );
      expect((envelope.data["sidecar"] as { format: string }).format).toBe("render");
      expect((envelope.data["sidecar"] as { verdict: { tier: number } }).verdict.tier).toBe(1);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("render export missing evidence emits one typed envelope and writes no files", async () => {
    const { env, home } = makeEnv("render-export-missing");
    const seeded = seedRenderEvidence(home, null);
    const originalCwd = process.cwd();
    const exportCwd = join(scratchRoot, `render-export-missing-cwd-${crypto.randomUUID()}`);
    mkdirSync(exportCwd, { recursive: true });
    process.chdir(exportCwd);
    try {
      const outputPath = join(exportCwd, "missing.png");
      const io = makeIo();
      const exit = await runCli(
        [
          "export",
          seeded.artifactId,
          "--revision",
          seeded.revisionSha,
          "--format",
          "render",
          "--out",
          outputPath,
        ],
        { ...io, env },
      );
      expect(exit.code).toBe(0);
      expect(io.stdoutBuf.value.trim().split("\n")).toHaveLength(1);
      const envelope = parseStdoutEnvelope(io.stdoutBuf.value);
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) expect(envelope.error.code).toBe("evidence_unavailable");
      expect(existsSync(outputPath)).toBe(false);
      expect(existsSync(outputPath.replace(/\.png$/, ".facet.json"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("successful export always writes the mandatory sidecar and published bytes as one envelope", async () => {
    const { env } = makeEnv("export-files");
    const io = makeIo();
    const originalCwd = process.cwd();
    const exportCwd = join(scratchRoot, `export-cwd-${crypto.randomUUID()}`);
    mkdirSync(exportCwd, { recursive: true });
    process.chdir(exportCwd);
    try {
      const createIo = makeIo();
      const createExit = await runCli(
        ["create", "--project-id", "p", "--slug", "cli-export", "--title", "CLI export"],
        { ...createIo, env },
      );
      expect(createExit.code).toBe(0);
      const created = parseStdoutEnvelope(createIo.stdoutBuf.value);
      if (!created.ok) throw new Error("create must succeed");
      const artifactId = (created.data["artifact"] as { id: string }).id;

      const source = "# exported from the CLI\n";
      const publishIo = makeIo(source);
      const publishExit = await runCli(
        ["publish", "--artifact-id", artifactId, "--type", "markdown", "--file", "-"],
        { ...publishIo, env },
      );
      expect(publishExit.code).toBe(0);
      const published = parseStdoutEnvelope(publishIo.stdoutBuf.value);
      if (!published.ok) throw new Error("publish must succeed");
      const revisionSha = (published.data["revision"] as { sha256: string }).sha256;

      const exit = await runCli(["export", artifactId], { ...io, env });
      expect(exit.code).toBe(0);
      expect(io.stdoutBuf.value.trim().split("\n")).toHaveLength(1);
      const exported = parseStdoutEnvelope(io.stdoutBuf.value);
      if (!exported.ok) throw new Error("export must succeed");
      expect(exported.data["command"]).toBe("export");
      const artifactPath = join(exportCwd, `cli-export-${revisionSha.slice(0, 7)}.md`);
      const sidecarPath = join(exportCwd, `cli-export-${revisionSha.slice(0, 7)}.facet.json`);
      expect(readFileSync(artifactPath, "utf8")).toBe(source);
      expect(JSON.parse(readFileSync(sidecarPath, "utf8"))).toEqual(exported.data["sidecar"]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("export preflights an existing sidecar and force replaces the pair", async () => {
    const { env } = makeEnv("export-preflight");
    const originalCwd = process.cwd();
    const exportCwd = join(scratchRoot, `export-preflight-cwd-${crypto.randomUUID()}`);
    mkdirSync(exportCwd, { recursive: true });
    process.chdir(exportCwd);
    try {
      const createIo = makeIo();
      await runCli(["create", "--project-id", "p", "--slug", "preflight", "--title", "Preflight"], {
        ...createIo,
        env,
      });
      const created = parseStdoutEnvelope(createIo.stdoutBuf.value);
      if (!created.ok) throw new Error("create must succeed");
      const artifactId = (created.data["artifact"] as { id: string }).id;
      const publishIo = makeIo("fresh bytes");
      await runCli(["publish", "--artifact-id", artifactId, "--type", "markdown", "--file", "-"], {
        ...publishIo,
        env,
      });
      const published = parseStdoutEnvelope(publishIo.stdoutBuf.value);
      if (!published.ok) throw new Error("publish must succeed");
      const revisionSha = (published.data["revision"] as { sha256: string }).sha256;
      const artifactPath = join(exportCwd, "requested.md");
      const sidecarPath = join(exportCwd, "requested.facet.json");

      const first = makeIo();
      await runCli(["export", artifactId, "--out", artifactPath], { ...first, env });
      expect(existsSync(artifactPath)).toBe(true);
      expect(existsSync(sidecarPath)).toBe(true);
      rmSync(artifactPath);
      const preservedSidecar = readFileSync(sidecarPath, "utf8");
      const refused = makeIo();
      const refusedExit = await runCli(["export", artifactId, "--out", artifactPath], {
        ...refused,
        env,
      });
      expect(refusedExit.code).toBe(0);
      const refusedEnvelope = parseStdoutEnvelope(refused.stdoutBuf.value);
      expect(refusedEnvelope.ok).toBe(false);
      if (!refusedEnvelope.ok) expect(refusedEnvelope.error.code).toBe("invalid_request");
      expect(existsSync(artifactPath)).toBe(false);
      expect(readFileSync(sidecarPath, "utf8")).toBe(preservedSidecar);

      writeFileSync(artifactPath, "stale artifact");
      writeFileSync(sidecarPath, "stale sidecar\n");
      const forced = makeIo();
      const forcedExit = await runCli(["export", artifactId, "--out", artifactPath, "--force"], {
        ...forced,
        env,
      });
      expect(forcedExit.code).toBe(0);
      expect(readFileSync(artifactPath, "utf8")).toBe("fresh bytes");
      expect(JSON.parse(readFileSync(sidecarPath, "utf8"))).toMatchObject({ revisionSha });
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("successful export option matrix always leaves the mandatory sidecar", async () => {
    const originalCwd = process.cwd();
    const exportCwd = join(scratchRoot, `export-matrix-cwd-${crypto.randomUUID()}`);
    mkdirSync(exportCwd, { recursive: true });
    const cases = [
      { label: "out", flags: ["--out", join(exportCwd, "out.artifact")] as string[], env: {} },
      {
        label: "force",
        flags: ["--out", join(exportCwd, "force.artifact"), "--force"] as string[],
        env: {},
      },
      {
        label: "json",
        flags: ["--out", join(exportCwd, "json.artifact"), "--json"] as string[],
        env: {},
      },
      {
        label: "pretty",
        flags: ["--out", join(exportCwd, "pretty.artifact")] as string[],
        env: { FACET_PRETTY: "1" },
      },
      {
        label: "insecure",
        flags: ["--out", join(exportCwd, "insecure.artifact")] as string[],
        env: { FACET_INSECURE: "3" },
      },
    ] as const;
    process.chdir(exportCwd);
    try {
      for (const testCase of cases) {
        const { env } = makeEnv(`export-matrix-${testCase.label}`);
        Object.assign(env, testCase.env);
        const createIo = makeIo();
        await runCli(
          [
            "create",
            "--project-id",
            "p",
            "--slug",
            `matrix-${testCase.label}`,
            "--title",
            "Matrix",
          ],
          { ...createIo, env },
        );
        const created = parseStdoutEnvelope(createIo.stdoutBuf.value);
        if (!created.ok) throw new Error(`create failed for ${testCase.label}`);
        const artifactId = (created.data["artifact"] as { id: string }).id;
        const publishIo = makeIo("matrix source");
        await runCli(
          ["publish", "--artifact-id", artifactId, "--type", "markdown", "--file", "-"],
          { ...publishIo, env },
        );
        const published = parseStdoutEnvelope(publishIo.stdoutBuf.value);
        if (!published.ok) throw new Error(`publish failed for ${testCase.label}`);
        const exportIo = makeIo();
        const exit = await runCli(["export", artifactId, ...testCase.flags], { ...exportIo, env });
        expect(exit.code).toBe(0);
        const out = testCase.flags[1];
        if (typeof out !== "string") throw new Error("missing matrix output path");
        expect(existsSync(out)).toBe(true);
        expect(existsSync(out.replace(/\.artifact$/, ".facet.json"))).toBe(true);
        expect(parseStdoutEnvelope(exportIo.stdoutBuf.value).ok).toBe(true);
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

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
      { args: ["list"], label: "list missing --project-id" },
      { args: ["create", "--project-id", "p", "--slug", "s"], label: "create missing --title" },
      { args: ["open", "--artifact-id", "x"], label: "open missing --revision-sha" },
      { args: ["pin", "--pinned", "true"], label: "pin missing --revision-id" },
      {
        args: ["promote", "--revision-id", "r", "--name", "n"],
        label: "promote missing --promoted-by",
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

  test("status without artifact id reports dormant health without spawning", async () => {
    const { env, home } = makeEnv("health-dormant");
    const io = makeIo();
    const exit = await runCli(["status"], { ...io, env });
    expect(exit.code).toBe(0);
    expect(exit.spawnedPid).toBeNull();
    expect(JSON.parse(io.stdoutBuf.value)).toMatchObject({
      ok: true,
      data: { command: "status", state: "dormant", process: null },
    });
    expect(existsSync(join(home, "run", "facet.lock"))).toBe(false);
  });
});

describe("cli contract — errors", () => {
  test("export without an artifact id returns a typed usage error before service startup", async () => {
    const { env } = makeEnv("export");
    const io = makeIo();
    const exit = await runCli(["export"], { ...io, env });
    expect(exit.code).toBe(64);
    const env1 = parseStdoutEnvelope(io.stdoutBuf.value);
    expect(env1.ok).toBe(false);
    if (!env1.ok) expect(env1.error.code).toBe("invalid_request");
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
