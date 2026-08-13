import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";

import { openDatabase } from "../../src/service/store/database";
import { ArtifactRepository } from "../../src/service/store/repository";
import { runMigrations } from "../../src/service/store/migrations";
import {
  INITIAL_SCHEMA,
  V2_SCHEMA_FRAGMENT,
  V3_SCHEMA_FRAGMENT,
  V4_SCHEMA_FRAGMENT,
  V5_SCHEMA_FRAGMENT,
  V6_SCHEMA_FRAGMENT,
  V7_SCHEMA_FRAGMENT,
} from "../../src/service/store/schema";
import { ARTIFACT_TYPES } from "../../src/shared/contracts/artifact-types";
import { RENDERERS } from "../../src/shared/contracts/renderers";

const databases: Array<{ close: () => void }> = [];

function makeStore() {
  const db = openDatabase({ databasePath: ":memory:" });
  databases.push(db);
  runMigrations(db);
  const repository = new ArtifactRepository(db);
  const project = repository.createProject({ projectRoot: `/tmp/facet-${crypto.randomUUID()}` });
  const artifact = repository.createArtifact({
    projectId: project.id,
    slug: "example",
    title: "Example",
  });
  return { db, repository, artifact };
}

function v5InitialSchema(): string {
  return INITIAL_SCHEMA.replace(
    "artifact_type TEXT NOT NULL CHECK(artifact_type IN ('markdown','mermaid','svg','chart','html'))",
    "artifact_type TEXT NOT NULL CHECK(artifact_type IN ('markdown','mermaid','svg','chart'))",
  );
}

function makeV5Store() {
  const db = openDatabase({ databasePath: ":memory:" });
  databases.push(db);
  db.exec(
    `${v5InitialSchema()}${V2_SCHEMA_FRAGMENT}${V3_SCHEMA_FRAGMENT}${V4_SCHEMA_FRAGMENT}${V5_SCHEMA_FRAGMENT}`,
  );
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const version of [1, 2, 3, 4, 5]) {
    db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
      version,
      "2026-08-10T00:00:00.000Z",
    );
  }
  const repository = new ArtifactRepository(db);
  const project = repository.createProject({ projectRoot: `/tmp/facet-v5-${crypto.randomUUID()}` });
  const artifact = repository.createArtifact({
    projectId: project.id,
    slug: "v5-example",
    title: "V5 example",
  });
  return { db, repository, artifact };
}

function tableCounts(db: ReturnType<typeof openDatabase>) {
  return Object.fromEntries(
    ["revisions", "render_runs", "templates"].map((table) => [
      table,
      (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]),
  );
}

function artifactTypeCheckValues(db: ReturnType<typeof openDatabase>): string[] {
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'revisions'")
    .get() as {
    sql: string;
  };
  const match = row.sql.match(/artifact_type TEXT NOT NULL CHECK\(artifact_type IN \(([^)]+)\)\)/);
  if (match?.[1] === undefined) throw new Error("revisions artifact_type CHECK is missing");
  return match[1].split(",").map((value) => value.trim().slice(1, -1));
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("artifact store", () => {
  test("v3 renderer CHECK constraint stays in parity with the renderer contract", () => {
    const expected = RENDERERS.map((renderer) => `'${renderer}'`).join(",");
    expect(V3_SCHEMA_FRAGMENT).toContain(`CHECK(renderer IN (${expected}))`);
  });
  test("enables WAL, busy timeout, and foreign key enforcement", () => {
    const db = openDatabase({ databasePath: `/tmp/facet-wal-${crypto.randomUUID()}.sqlite` });
    databases.push(db);
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(
      Number((db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout),
    ).toBeGreaterThan(0);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  test("runs migrations idempotently", () => {
    const db = openDatabase({ databasePath: ":memory:" });
    databases.push(db);
    runMigrations(db);
    const first = db
      .query("SELECT version, applied_at FROM schema_migrations ORDER BY version")
      .all();
    runMigrations(db);
    expect(
      db.query("SELECT version, applied_at FROM schema_migrations ORDER BY version").all(),
    ).toEqual(first);
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toHaveLength(6);
  });

  test("artifact type check matches the canonical implemented type array", () => {
    const fresh = openDatabase({ databasePath: ":memory:" });
    databases.push(fresh);
    runMigrations(fresh);

    const { db: v5 } = makeV5Store();
    runMigrations(v5);

    expect(artifactTypeCheckValues(fresh)).toEqual([...ARTIFACT_TYPES]);
    expect(artifactTypeCheckValues(v5)).toEqual([...ARTIFACT_TYPES]);
  });

  test("v7→v8 migration widens artifact_type to all canonical types including tsx", () => {
    const { db: v5 } = makeV5Store();
    runMigrations(v5);
    // v5 → v6 → v7 widened the artifact_type CHECK; v7 → v8 should add
    // tsx to the canonical list while preserving every prior row.
    expect(artifactTypeCheckValues(v5)).toEqual([...ARTIFACT_TYPES]);
    // Backfill + tsx acceptance: publish a tsx revision after v8 lands
    // and confirm the CHECK accepts it.
    const { repository, artifact } = (() => {
      // reuse the existing v5 store: read its repository out by hand.
      // The makeV5Store helper exposes repository + artifact on the
      // returned object; here we already have the db, so reconstruct.
      const project = (v5.query("SELECT id FROM projects LIMIT 1").get() as { id: string } | null)
        ?.id;
      if (!project) throw new Error("v5 store has no project");
      return {
        repository: new ArtifactRepository(v5),
        artifact: {
          id:
            (v5.query("SELECT id FROM artifacts LIMIT 1").get() as { id: string } | null)?.id ?? "",
        },
      };
    })();
    const tsx = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "tsx",
      source: new TextEncoder().encode("export default function App(){return null;}"),
    });
    expect(tsx.artifactType).toBe("tsx");
    expect(v5.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("v7 row with pre-arc observed JSON shape migrates and reads back", () => {
    // The migration trap that shipped twice: a row written by an earlier
    // release must read back AFTER v8 lands. Plant a v7-shape row
    // (no execution column, pre-arc observed_json missing both opaque
    // and externalImageCount counters) and confirm the migration +
    // tolerant read recover it.
    const db = openDatabase({ databasePath: ":memory:" });
    databases.push(db);
    db.exec(
      `${v5InitialSchema()}${V2_SCHEMA_FRAGMENT}${V3_SCHEMA_FRAGMENT}${V4_SCHEMA_FRAGMENT}${V5_SCHEMA_FRAGMENT}`,
    );
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const version of [1, 2, 3, 4, 5]) {
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        version,
        "2026-08-10T00:00:00.000Z",
      );
    }
    const projectId = crypto.randomUUID();
    db.query("INSERT INTO projects(id, project_root, created_at) VALUES (?, ?, ?)").run(
      projectId,
      `/tmp/legacy-${crypto.randomUUID()}`,
      "2026-08-10T00:00:00.000Z",
    );
    const artifactId = crypto.randomUUID();
    db.query(
      "INSERT INTO artifacts(id, project_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      artifactId,
      projectId,
      "legacy",
      "Legacy",
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    );
    const revisionId = crypto.randomUUID();
    db.query(
      "INSERT INTO revisions(id, artifact_id, revision_number, parent_revision_id, artifact_type, source, sha256, note, pinned, created_at, renderer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      revisionId,
      artifactId,
      1,
      null,
      "markdown",
      new Uint8Array([104, 105]),
      "a".repeat(64),
      null,
      0,
      "2026-08-10T00:00:00.000Z",
      "svg",
    );
    const runId = crypto.randomUUID();
    // Pre-v7 row: no opaqueRegionCount, no externalImageCount in observed_json.
    db.query(
      "INSERT INTO render_runs(id, revision_id, tier, status, expected_json, observed_json, screenshot_path, console_path, screenshot_error_json, insecure_json, retained, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      runId,
      revisionId,
      0,
      "ok",
      JSON.stringify({ rendererRootSvgCount: 1, mermaidNodeCount: 1, visibleSvgCount: 1 }),
      JSON.stringify({
        rendererRootSvgCount: 1,
        graphCount: 1,
        mermaidNodeCount: 1,
        visibleSvgCount: 1,
        errorCount: 0,
      }),
      null,
      null,
      null,
      null,
      0,
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    );

    const before = tableCounts(db);
    runMigrations(db);

    // Counts unchanged: no orphan rows, no FK violations.
    expect(tableCounts(db)).toEqual(before);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    // Migration recorded.
    expect(db.query("SELECT MAX(version) AS max FROM schema_migrations").get()).toEqual({
      max: 8,
    });
    // Pre-arc row reads back: the legacy observed_json is enriched with
    // the missing counters (V7 backfill) but the row still maps to a
    // valid VerdictObserved via the tolerant read.
    const repository = new ArtifactRepository(db);
    const runs = repository.listRenderRuns({ revisionId, tier: 0 });
    expect(runs).toHaveLength(1);
    const observed = JSON.parse(runs[0]!.observedJson);
    expect(observed.opaqueRegionCount).toBe(0);
    expect(observed.externalImageCount).toBe(0);
    // The revision still maps through RevisionSchema.parse.
    const storedRevision = repository.getRevisionById(revisionId);
    expect(storedRevision).not.toBeNull();
    expect(storedRevision?.artifactType).toBe("markdown");
  });

  test("migrates v5 revisions without breaking render and template relationships", () => {
    const { db, repository, artifact } = makeV5Store();
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new TextEncoder().encode("# v5"),
    });
    repository.recordRenderRun({
      revisionId: revision.id,
      tier: 0,
      status: "ok",
      expected: { nodes: 0 },
      observed: { nodes: 0 },
    });
    repository.promoteRevision({
      revisionId: revision.id,
      name: `v5-template-${crypto.randomUUID()}`,
      promotedBy: "test",
    });
    const before = tableCounts(db);

    runMigrations(db);

    expect(tableCounts(db)).toEqual(before);
    expect(db.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
    ]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

    const uniqueColumns = (
      db.query("PRAGMA index_list('revisions')").all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>
    )
      .filter((index) => index.unique === 1 && index.origin === "u")
      .map((index) =>
        (db.query(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      )
      .toSorted((left, right) => left.join(",").localeCompare(right.join(",")));
    expect(uniqueColumns).toEqual([
      ["artifact_id", "revision_number"],
      ["artifact_id", "sha256"],
    ]);

    const html = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "html",
      source: new TextEncoder().encode("<main>HTML</main>"),
    });
    expect(html.artifactType).toBe("html");
    expect(tableCounts(db)).toEqual({ revisions: 2, render_runs: 1, templates: 1 });
  });

  test("rolls back the v6 rebuild when interrupted before recording its schema version", () => {
    const { db, repository, artifact } = makeV5Store();
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new TextEncoder().encode("# v5"),
    });
    repository.recordRenderRun({
      revisionId: revision.id,
      tier: 0,
      status: "ok",
      expected: { nodes: 0 },
      observed: { nodes: 0 },
    });
    repository.promoteRevision({
      revisionId: revision.id,
      name: `v5-interrupted-${crypto.randomUUID()}`,
      promotedBy: "test",
    });
    const before = tableCounts(db);

    expect(() =>
      runMigrations(db, {
        beforeRecordVersion: (version) => {
          if (version === 6) throw new Error("simulated v6 interruption");
        },
      }),
    ).toThrow("simulated v6 interruption");

    expect(tableCounts(db)).toEqual(before);
    expect(db.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
    ]);
    expect(artifactTypeCheckValues(db)).toEqual(["markdown", "mermaid", "svg", "chart"]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

    runMigrations(db);
    expect(artifactTypeCheckValues(db)).toEqual([...ARTIFACT_TYPES]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("round-trips exact bytes and sha256 lookup", () => {
    const { repository, artifact } = makeStore();
    const source = new Uint8Array([0, 255, 10, 128, 0]);
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "svg",
      source,
    });
    const found = repository.getRevisionBySha(artifact.id, revision.sha256);
    expect(Array.from(found?.source ?? [])).toEqual(Array.from(source));
    expect(found?.sha256).toBe(revision.sha256);
  });

  test("rejects duplicate bytes and immutable revision updates with typed errors", () => {
    const { repository, artifact } = makeStore();
    const source = new TextEncoder().encode("same");
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source,
    });
    expect(() =>
      repository.publishRevision({ artifactId: artifact.id, artifactType: "markdown", source }),
    ).toThrowError(expect.objectContaining({ code: "duplicate_revision" }));
    expect(() => repository.updateRevisionSource(revision.id, new Uint8Array([1]))).toThrowError(
      expect.objectContaining({ code: "immutable_revision" }),
    );
    expect(
      Array.from(repository.getRevisionBySha(artifact.id, revision.sha256)?.source ?? []),
    ).toEqual(Array.from(source));
  });

  test("onCommitted fires once only after a successful commit", () => {
    const { db, artifact } = makeStore();
    let calls = 0;
    const failing = new ArtifactRepository(db, {
      onCommitted: () => {
        calls += 1;
      },
      writeHook: ({ phase }) => {
        if (phase === "before_commit") throw new Error("forced commit failure");
      },
    });
    expect(() =>
      failing.publishRevision({
        artifactId: artifact.id,
        artifactType: "svg",
        source: new Uint8Array([9]),
      }),
    ).toThrow();
    expect(calls).toBe(0);
    const successful = new ArtifactRepository(db, {
      onCommitted: () => {
        calls += 1;
        expect(db.query("SELECT COUNT(*) AS count FROM revisions").get()).toEqual({ count: 1 });
      },
    });
    successful.publishRevision({
      artifactId: artifact.id,
      artifactType: "svg",
      source: new Uint8Array([10]),
    });
    expect(calls).toBe(1);
  });

  test("enforces foreign keys", () => {
    const { repository } = makeStore();
    expect(() =>
      repository.publishRevision({
        artifactId: "missing",
        artifactType: "chart",
        source: new Uint8Array([1]),
      }),
    ).toThrowError(expect.objectContaining({ code: "foreign_key" }));
  });

  test("persists the renderer with svg default and explicit canvas", () => {
    const { db, repository, artifact } = makeStore();
    const svg = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new Uint8Array([1]),
    });
    const canvas = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "chart",
      renderer: "canvas",
      source: new Uint8Array([2]),
    });

    expect(svg.renderer).toBe("svg");
    expect(canvas.renderer).toBe("canvas");
    expect(db.query("SELECT renderer FROM revisions ORDER BY revision_number").all()).toEqual([
      { renderer: "svg" },
      { renderer: "canvas" },
    ]);
  });

  test("evicts oldest unpinned revisions beyond the 50 revision ring", () => {
    const { repository, artifact } = makeStore();
    const revisions = Array.from({ length: 55 }, (_, index) =>
      repository.publishRevision({
        artifactId: artifact.id,
        artifactType: "markdown",
        source: new Uint8Array([index]),
      }),
    );
    expect(repository.getRevisionBySha(artifact.id, revisions[0]!.sha256)).toBeNull();
    expect(repository.getRevisionBySha(artifact.id, revisions[4]!.sha256)).toBeNull();
    expect(repository.getRevisionBySha(artifact.id, revisions[5]!.sha256)?.revisionNumber).toBe(6);
    expect(repository.getRevisionBySha(artifact.id, revisions[54]!.sha256)?.revisionNumber).toBe(
      55,
    );
  });

  test("pinned and template revisions block eviction", () => {
    const { repository, artifact } = makeStore();
    const pinned = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new Uint8Array([1]),
    });
    repository.pinRevision(pinned.id);
    const templated = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new Uint8Array([2]),
    });
    repository.instantiateTemplate({
      artifactId: artifact.id,
      revisionId: templated.id,
      name: "stable",
      promotedBy: "test",
    });
    for (let index = 3; index <= 55; index += 1) {
      repository.publishRevision({
        artifactId: artifact.id,
        artifactType: "markdown",
        source: new Uint8Array([index]),
      });
    }
    expect(repository.getRevisionBySha(artifact.id, pinned.sha256)).not.toBeNull();
    expect(repository.getRevisionBySha(artifact.id, templated.sha256)).not.toBeNull();
  });

  test("records render runs and promotes revisions", () => {
    const { repository, artifact } = makeStore();
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "mermaid",
      source: new Uint8Array([1]),
    });
    const run = repository.recordRenderRun({
      revisionId: revision.id,
      tier: 1,
      status: "ok",
      expected: { nodes: 1 },
      observed: { nodes: 1 },
    });
    expect(run.revisionId).toBe(revision.id);
    const template = repository.promoteRevision({
      revisionId: revision.id,
      name: "promoted",
      promotedBy: "test",
    });
    expect(template.revisionId).toBe(revision.id);
  });

  test("removes compiled evidence when render-run insert fails", () => {
    const { repository } = makeStore();
    const compiledPath = `/tmp/facet-compiled-failed-${crypto.randomUUID()}.js`;
    writeFileSync(compiledPath, "derived");
    expect(() =>
      repository.recordRenderRun({
        revisionId: "missing-revision",
        tier: 0,
        status: "ok",
        expected: {},
        observed: {},
        compiledPath,
      }),
    ).toThrow();
    expect(existsSync(compiledPath)).toBe(false);
  });

  test("FK gate: rebuild steps must disable FKs; non-rebuild steps must not", () => {
    // Pin the gate shape introduced after the v8 fragment needed
    // FK enforcement off (the create-copy-drop-rename sequence on a
    // self-FK-bearing table fails with FKs ON). The gate must be
    // scoped to steps that explicitly opt in — a v9 that only adds a
    // column inherits nothing, and a fully-migrated database runs
    // with FKs ON throughout.
    const db = openDatabase({ databasePath: ":memory:" });
    databases.push(db);
    runMigrations(db);
    // After the canonical migration run, FKs are ON. The first
    // probe reads the pragma state across the migration boundary.
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    // A re-run with every step already applied does NOT touch the
    // FK pragma. This is the regression that would have left FKs
    // OFF on every migration call to an already-current DB — pin it
    // by spying on the pragma's value before/after a no-op re-run.
    const before = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    runMigrations(db);
    const after = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(after.foreign_keys).toBe(before.foreign_keys);
    expect(after.foreign_keys).toBe(1);
  });

  test("FK gate: rebuild pending (v8 not yet applied) disables FKs for that run", () => {
    // Plant a v7-shape DB and confirm the v8 step's
    // `requiresForeignKeyDisable` flag actually gates the pragma.
    // We measure the FK state AFTER the migration (the finally
    // block must restore it to ON regardless of the initial state).
    const db = openDatabase({ databasePath: ":memory:" });
    databases.push(db);
    db.exec(
      `${v5InitialSchema()}${V2_SCHEMA_FRAGMENT}${V3_SCHEMA_FRAGMENT}${V4_SCHEMA_FRAGMENT}${V5_SCHEMA_FRAGMENT}${V6_SCHEMA_FRAGMENT}${V7_SCHEMA_FRAGMENT}`,
    );
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        version,
        "2026-08-10T00:00:00.000Z",
      );
    }
    // Plant a parent-self-FK row that would block a v8 rebuild with
    // FKs ON — proves the gate actually toggled.
    const projectId = crypto.randomUUID();
    db.query("INSERT INTO projects(id, project_root, created_at) VALUES (?, ?, ?)").run(
      projectId,
      `/tmp/facet-fkgate-${crypto.randomUUID()}`,
      "2026-08-10T00:00:00.000Z",
    );
    const artifactId = crypto.randomUUID();
    db.query(
      "INSERT INTO artifacts(id, project_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      artifactId,
      projectId,
      "fk-gate",
      "FK gate",
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    );
    const sha = "a".repeat(64);
    db.query(
      "INSERT INTO revisions(id, artifact_id, revision_number, parent_revision_id, artifact_type, source, sha256, note, pinned, created_at, renderer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      crypto.randomUUID(),
      artifactId,
      1,
      null,
      "markdown",
      new Uint8Array([104, 105]),
      sha,
      null,
      0,
      "2026-08-10T00:00:00.000Z",
      "svg",
    );
    expect(() => runMigrations(db)).not.toThrow();
    // After the migration, the connection's FK pragma must be ON
    // — the gate's finally block is unconditional on the restore
    // direction, regardless of the pre-run state.
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  test("FK gate: restore to ON survives a pre-run OFF state", () => {
    // The mechanism the reviewer flagged: if a connection comes in
    // with FKs already OFF, the prior gate didn't restore them
    // because the gate condition was foreignKeys.foreign_keys === 1.
    // A migrated DB must end with FKs ON no matter the entry point.
    const db = openDatabase({ databasePath: ":memory:" });
    databases.push(db);
    db.exec("PRAGMA foreign_keys = OFF");
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
    runMigrations(db);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  test("FK gate: rebuild steps actually toggle FKs OFF mid-migration (observation seam)", () => {
    // The final FK state cannot prove that rebuilds ran with FKs disabled:
    // the finally
    // block had restored FKs to ON. The pragma's mid-migration value
    // was never observed, so a regression that drops
    // `requiresForeignKeyDisable` from v8 would still pass those tests
    // even though every v8 rebuild would now fail with FKs ON. Use the
    // `beforeRecordVersion` hook (the published seam) to sample the
    // pragma state DURING the v8 step's apply and AFTER it returns.
    const db = openDatabase({ databasePath: ":memory:" });
    databases.push(db);
    db.exec(
      `${v5InitialSchema()}${V2_SCHEMA_FRAGMENT}${V3_SCHEMA_FRAGMENT}${V4_SCHEMA_FRAGMENT}${V5_SCHEMA_FRAGMENT}${V6_SCHEMA_FRAGMENT}${V7_SCHEMA_FRAGMENT}`,
    );
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        version,
        "2026-08-10T00:00:00.000Z",
      );
    }
    // Plant a parent-self-FK row that would block a v8 rebuild with
    // FKs ON — the v8 step must run with FKs OFF, otherwise the
    // DROP+ALTER RENAME fails.
    const projectId = crypto.randomUUID();
    db.query("INSERT INTO projects(id, project_root, created_at) VALUES (?, ?, ?)").run(
      projectId,
      `/tmp/facet-fkgate-obs-${crypto.randomUUID()}`,
      "2026-08-10T00:00:00.000Z",
    );
    const artifactId = crypto.randomUUID();
    db.query(
      "INSERT INTO artifacts(id, project_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      artifactId,
      projectId,
      "fk-gate-obs",
      "FK gate (observation)",
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    );
    // FKs ON at start (openDatabase default).
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    const observed = new Map<number, number>();
    runMigrations(db, {
      beforeRecordVersion: (version) => {
        // The hook fires AFTER the step's apply and BEFORE the
        // schema_migrations INSERT, inside the transaction whose
        // outer gate has toggled FKs OFF for v8.
        const pragma = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
        observed.set(version, pragma.foreign_keys);
      },
    });
    // v8 (the rebuild) must have observed FKs OFF.
    expect(observed.get(8)).toBe(0);
    // After the migration, FKs are restored to ON.
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });
});
