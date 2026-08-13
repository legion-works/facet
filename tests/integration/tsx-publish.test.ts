import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FacetClient, publishArtifact } from "../../src/cli/client";
import { startFacetService, type RunningService } from "../../src/service/server";
import { createTier0RunnerForTests } from "../../src/validation/tier0/runner";
import { createQuietLogger } from "../../src/shared/logging/logger";
import type { Tier1Runner } from "../../src/shared/contracts/validation";

const source = readFileSync(join(import.meta.dir, "../fixtures/tsx/static-source.tsx"));
const interactive = readFileSync(join(import.meta.dir, "../fixtures/tsx/interactive-source.tsx"));

describe("TSX Tier 0 publish path", () => {
  let root: string;
  let service: RunningService | undefined;
  let runner: ReturnType<typeof createTier0RunnerForTests> | undefined;

  beforeEach(() => {
    root = join(tmpdir(), `facet-tsx-integration-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    process.env.FACET_HOME = root;
  });

  afterEach(async () => {
    await service?.stop();
    runner?.close?.();
    delete process.env.FACET_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  async function start(tier1Runner?: Tier1Runner): Promise<FacetClient> {
    const dbPath = join(root, "facet.sqlite");
    runner = createTier0RunnerForTests(0, {});
    service = await startFacetService({
      dbPath,
      installTokenPath: join(root, "install.token"),
      promoteTokenPath: join(root, "promote.token"),
      lockPath: join(root, "facet.lock"),
      tier0Runner: runner,
      ...(tier1Runner === undefined ? {} : { tier1Runner }),
      logger: createQuietLogger({ component: "tsx-integration" }),
    });
    return new FacetClient({ baseUrl: service.url, installToken: service.installToken });
  }

  test("static compiles through parseHtml and retains derived bytes separately", async () => {
    const client = await start();
    const published = await publishArtifact(client, {
      artifactType: "tsx",
      bytes: source.buffer,
      execution: "static",
    });
    const db = new Database(join(root, "facet.sqlite"));
    try {
      const row = db
        .query(
          "SELECT compiled_path, expected_json, observed_json FROM render_runs ORDER BY finished_at DESC LIMIT 1",
        )
        .get() as { compiled_path: string | null; expected_json: string; observed_json: string };
      expect(row.compiled_path).not.toBeNull();
      expect(existsSync(row.compiled_path!)).toBe(true);
      expect(JSON.parse(row.expected_json).html.rendererRootCount).toBe(1);
      expect(JSON.parse(row.observed_json).html.rendererRootCount).toBe(1);
      const exported = await client.sendCommand({
        command: "export",
        requestId: crypto.randomUUID(),
        artifactId: published.artifactId,
        revisionSha: published.revisionSha,
        format: "source",
      });
      expect(exported.ok).toBe(true);
      if (exported.ok && exported.data.command === "export") {
        expect(Uint8Array.from(Buffer.from(exported.data.bytes, "base64"))).toEqual(source);
      }
      const opened = await client.sendCommand({
        command: "open",
        requestId: crypto.randomUUID(),
        artifactId: published.artifactId,
        revisionSha: published.revisionSha,
      });
      expect(opened.ok).toBe(true);
      if (opened.ok && opened.data.command === "open") {
        const gallery = await fetch(
          `${service!.url}/api/v1/gallery/source?revisionSha=${published.revisionSha}`,
          {
            headers: {
              authorization: `Bearer ${service!.installToken}`,
              host: new URL(service!.url).host,
              "x-gallery-artifact": published.artifactId,
              "x-gallery-lease": opened.data.lease.leaseId,
            },
          },
        );
        expect(gallery.status).toBe(200);
        const payload = (await gallery.json()) as {
          source: string;
          renderBytesBase64?: string;
          execution?: string;
        };
        expect(new TextEncoder().encode(payload.source)).toEqual(source);
        expect(payload.execution).toBe("static");
        expect(payload.renderBytesBase64).toBeDefined();
        expect(payload.renderBytesBase64).toBe(
          Buffer.from(readFileSync(row.compiled_path!)).toString("base64"),
        );
      }
    } finally {
      db.close();
    }
  });

  test("the pooled worker keeps compiled SHA stable across many requests", async () => {
    const pids: number[] = [];
    const pooled = createTier0RunnerForTests(0, { onWorkerSpawn: (pid) => pids.push(pid) });
    try {
      const bytes = new Uint8Array(source);
      const hashes: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        const result = await pooled({
          revisionSha: "a".repeat(64),
          artifactType: "tsx",
          renderer: "svg",
          source: bytes,
          execution: "static",
          lexical: {
            rendererRootSvgCount: 0,
            mermaidNodeCount: 0,
            visibleSvgCount: 0,
            opaqueRegionCount: 0,
            externalImageCount: 0,
          },
        });
        hashes.push(result.compiled?.sha256 ?? "");
      }
      expect(new Set(hashes).size).toBe(1);
      expect(pids).toHaveLength(1);
    } finally {
      pooled.close?.();
    }
  });

  test("interactive compiles to JavaScript without an SSR expectation", async () => {
    const client = await start();
    const published = await publishArtifact(client, {
      artifactType: "tsx",
      bytes: interactive.buffer,
      execution: "interactive",
    });
    const db = new Database(join(root, "facet.sqlite"));
    try {
      const row = db
        .query(
          "SELECT compiled_path, expected_json FROM render_runs ORDER BY finished_at DESC LIMIT 1",
        )
        .get() as { compiled_path: string | null; expected_json: string };
      expect(row.compiled_path).toEndWith("compiled.js");
      expect(existsSync(row.compiled_path!)).toBe(true);
      expect(JSON.parse(row.expected_json).html).toBeUndefined();
      const sourceResponse = await fetch(
        `${service!.url}/api/v1/gallery/source?revisionSha=${published.revisionSha}`,
        {
          headers: {
            authorization: `Bearer ${service!.installToken}`,
            host: new URL(service!.url).host,
            "x-gallery-artifact": published.artifactId,
            "x-gallery-lease": "missing",
          },
        },
      );
      expect(sourceResponse.status).toBe(401);
    } finally {
      db.close();
    }
  });

  test("AST-denied source records an error without compiled evidence", async () => {
    const client = await start();
    const denied = new TextEncoder().encode(
      `export default function App(){fetch("/x");return null;}`,
    );
    await publishArtifact(client, {
      artifactType: "tsx",
      bytes: denied.slice().buffer as ArrayBuffer,
      execution: "static",
    });
    const db = new Database(join(root, "facet.sqlite"));
    try {
      const row = db
        .query(
          "SELECT status, compiled_path, observed_json FROM render_runs ORDER BY finished_at DESC LIMIT 1",
        )
        .get() as { status: string; compiled_path: string | null; observed_json: string };
      expect(row.status).toBe("error");
      expect(row.compiled_path).toBeNull();
      expect(row.observed_json).toContain("tsx_capability_fetch");
    } finally {
      db.close();
    }
  });

  test("compile-failing interactive TSX records its Tier 0 error without invoking Tier 1", async () => {
    let tier1Calls = 0;
    const client = await start(async () => {
      tier1Calls += 1;
      throw new Error("Tier 1 must not receive failed TSX source");
    });
    const malformed = new TextEncoder().encode(
      "export default function Broken(){ return <section>; }",
    );
    const published = await publishArtifact(client, {
      artifactType: "tsx",
      bytes: malformed.slice().buffer as ArrayBuffer,
      execution: "interactive",
    });
    const db = new Database(join(root, "facet.sqlite"));
    try {
      const rows = db
        .query("SELECT tier, status, observed_json FROM render_runs ORDER BY tier")
        .all() as Array<{ tier: number; status: string; observed_json: string }>;
      expect(tier1Calls).toBe(0);
      expect(rows).toEqual([expect.objectContaining({ tier: 0, status: "error" })]);
      expect(rows[0]?.observed_json).toContain("tsx_compile_error");
      expect(rows[0]?.observed_json).toContain("Syntax Error");
      const readBack = await client.sendCommand({
        command: "readBack",
        requestId: crypto.randomUUID(),
        artifactId: published.artifactId,
        revisionSha: published.revisionSha,
        tier: 0,
      });
      expect(readBack.ok).toBe(true);
      if (readBack.ok && readBack.data.command === "readBack") {
        expect(readBack.data.verdict.status).toBe("error");
        expect(readBack.data.verdict.observed.discriminativeErrors?.[0]?.message).toContain(
          "Syntax Error",
        );
      }
    } finally {
      db.close();
    }
  });
});
