import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import { openDatabase } from "../../src/service/store/database";
import { runMigrations } from "../../src/service/store/migrations";
import { ArtifactRepository } from "../../src/service/store/repository";
import {
  INITIAL_SCHEMA,
  V2_SCHEMA_FRAGMENT,
  V3_SCHEMA_FRAGMENT,
  V4_SCHEMA_FRAGMENT,
} from "../../src/service/store/schema";

const databasePaths: string[] = [];
const connections: Array<{ close: () => void }> = [];

function pathFor(label: string): string {
  const path = `/tmp/facet-${label}-${crypto.randomUUID()}.sqlite`;
  databasePaths.push(path);
  return path;
}

function openStore(label: string, busyTimeoutMs = 1_000) {
  const databasePath = pathFor(label);
  const db = openDatabase({ databasePath, busyTimeoutMs });
  connections.push(db);
  runMigrations(db);
  const repository = new ArtifactRepository(db);
  const project = repository.createProject({ projectRoot: `/tmp/${crypto.randomUUID()}` });
  const artifact = repository.createArtifact({
    projectId: project.id,
    slug: "test",
    title: "Test",
  });
  return { databasePath, db, repository, artifact };
}

afterEach(() => {
  while (connections.length > 0) connections.pop()?.close();
  for (const path of databasePaths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${path}${suffix}`);
      } catch {}
    }
  }
});

test("SIGKILL during an uncommitted publish leaves no partial revision and WAL recovers", async () => {
  const { databasePath, db, artifact } = openStore("kill");
  db.close();
  connections.pop();
  const childSource = `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(databasePath)}, { strict: true });
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    db.query("INSERT INTO revisions(id, artifact_id, revision_number, artifact_type, source, sha256, created_at) VALUES (?, ?, 1, 'markdown', ?, ?, ?)")
      .run("child-revision", ${JSON.stringify(artifact.id)}, new Uint8Array([1,2,3]), "${"a".repeat(64)}", new Date().toISOString());
    console.log("READY");
    await new Promise(() => {});
  `;
  const child = Bun.spawn(["bun", "-e", childSource], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const ready = await Promise.race([
    reader.read().then(({ value }) => new TextDecoder().decode(value)),
    Bun.sleep(3_000).then(() => "TIMEOUT"),
  ]);
  expect(ready).toContain("READY");
  child.kill(9);
  await child.exited;

  const reopened = openDatabase({ databasePath });
  connections.push(reopened);
  expect(reopened.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(reopened.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(reopened.query("SELECT COUNT(*) AS count FROM revisions").get()).toEqual({ count: 0 });
});

test("injected disk-full failure rolls back the complete publish", () => {
  const { db, artifact } = openStore("disk-full");
  const repository = new ArtifactRepository(db, {
    writeHook: ({ phase }) => {
      if (phase === "before_commit") throw new Error("ENOSPC: no space left on device");
    },
  });
  expect(() =>
    repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "chart",
      source: new Uint8Array([4, 5, 6]),
    }),
  ).toThrowError(expect.objectContaining({ code: "disk_full" }));
  expect(db.query("SELECT COUNT(*) AS count FROM revisions").get()).toEqual({ count: 0 });
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
});

test("locked database honors busy_timeout and returns a typed timeout", () => {
  const { databasePath, db, artifact } = openStore("locked", 150);
  const second = openDatabase({ databasePath, busyTimeoutMs: 150 });
  connections.push(second);
  const repository = new ArtifactRepository(second);
  db.exec("BEGIN IMMEDIATE");
  const startedAt = performance.now();
  expect(() =>
    repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "svg",
      source: new Uint8Array([7]),
    }),
  ).toThrowError(expect.objectContaining({ code: "database_busy" }));
  const elapsed = performance.now() - startedAt;
  db.exec("ROLLBACK");
  expect(elapsed).toBeGreaterThanOrEqual(100);
  expect(elapsed).toBeLessThan(2_000);
});

test("enforces 0600 on an existing database opened with wider permissions", () => {
  const databasePath = pathFor("permissions");
  const initial = openDatabase({ databasePath });
  initial.close();
  chmodSync(databasePath, 0o644);
  const reopened = openDatabase({ databasePath });
  connections.push(reopened);
  expect(statSync(databasePath).mode & 0o777).toBe(0o600);
});

test("hardened WAL sidecars are 0600 after a write when SQLite creates them", () => {
  const { databasePath, repository, artifact } = openStore("sidecars");
  repository.publishRevision({
    artifactId: artifact.id,
    artifactType: "markdown",
    source: new Uint8Array([8]),
  });
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${databasePath}${suffix}`))
      expect(statSync(`${databasePath}${suffix}`).mode & 0o777).toBe(0o600);
  }
});

test("corrupt database raises database_corrupt without changing the file", () => {
  const databasePath = pathFor("corrupt");
  const garbage = new Uint8Array([70, 65, 67, 69, 84, 0, 255, 1]);
  writeFileSync(databasePath, garbage, { mode: 0o600 });
  const before = readFileSync(databasePath);
  expect(() => openDatabase({ databasePath })).toThrowError(
    expect.objectContaining({ code: "database_corrupt" }),
  );
  expect(readFileSync(databasePath)).toEqual(before);
});

test("interrupted migration rolls back its version and recovers on retry", () => {
  const databasePath = pathFor("migration");
  const db = openDatabase({ databasePath });
  connections.push(db);
  expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  expect(() =>
    runMigrations(db, {
      beforeRecordVersion: () => {
        throw new Error("simulated interruption");
      },
    }),
  ).toThrow("simulated interruption");
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'projects'").get()).toBeNull();

  runMigrations(db);
  expect(db.query("SELECT version FROM schema_migrations").all()).toEqual([
    { version: 1 },
    { version: 2 },
    { version: 3 },
    { version: 4 },
    { version: 5 },
    { version: 6 },
    { version: 7 },
  ]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'projects'").get()).toEqual({
    name: "projects",
  });
});

test("upgrades a populated v2 database with renderer and screenshot-error columns", () => {
  const databasePath = pathFor("migration-v2-upgrade");
  const db = openDatabase({ databasePath });
  connections.push(db);
  db.exec(INITIAL_SCHEMA);
  db.exec(V2_SCHEMA_FRAGMENT);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const timestamp = new Date().toISOString();
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?), (?, ?)").run(
    1,
    timestamp,
    2,
    timestamp,
  );
  db.query("INSERT INTO projects(id, project_root, created_at) VALUES (?, ?, ?)").run(
    "project-v2",
    "/tmp/facet-v2-upgrade",
    timestamp,
  );
  db.query(
    "INSERT INTO artifacts(id, project_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("artifact-v2", "project-v2", "v2", "V2", timestamp, timestamp);
  db.query(
    "INSERT INTO revisions(id, artifact_id, revision_number, artifact_type, source, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "revision-v2",
    "artifact-v2",
    1,
    "markdown",
    new Uint8Array([1, 2, 3]),
    "a".repeat(64),
    timestamp,
  );

  runMigrations(db);

  expect(db.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
    { version: 1 },
    { version: 2 },
    { version: 3 },
    { version: 4 },
    { version: 5 },
    { version: 6 },
    { version: 7 },
  ]);
  expect(db.query("SELECT renderer FROM revisions WHERE id = ?").get("revision-v2")).toEqual({
    renderer: "svg",
  });
  expect(new ArtifactRepository(db).getRevisionById("revision-v2")?.renderer).toBe("svg");
  expect(
    (db.query("PRAGMA table_info(render_runs)").all() as Array<{ name: string }>).some(
      (column) => column.name === "screenshot_error_json",
    ),
  ).toBe(true);
});

test("upgrades a populated v4 database and preserves render-run bytes without insecure markers", () => {
  const databasePath = pathFor("migration-v4-upgrade");
  const db = openDatabase({ databasePath });
  connections.push(db);
  db.exec(INITIAL_SCHEMA);
  db.exec(V2_SCHEMA_FRAGMENT);
  db.exec(V3_SCHEMA_FRAGMENT);
  db.exec(V4_SCHEMA_FRAGMENT);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const timestamp = new Date().toISOString();
  db.query(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?), (?, ?), (?, ?), (?, ?)",
  ).run(1, timestamp, 2, timestamp, 3, timestamp, 4, timestamp);
  db.query("INSERT INTO projects(id, project_root, created_at) VALUES (?, ?, ?)").run(
    "project-v4",
    "/tmp/facet-v4-upgrade",
    timestamp,
  );
  db.query(
    "INSERT INTO artifacts(id, project_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("artifact-v4", "project-v4", "v4", "V4", timestamp, timestamp);
  db.query(
    "INSERT INTO revisions(id, artifact_id, revision_number, artifact_type, source, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "revision-v4",
    "artifact-v4",
    1,
    "markdown",
    new Uint8Array([9, 8, 7]),
    "b".repeat(64),
    timestamp,
  );
  const expectedJson = JSON.stringify({ rendererRootSvgCount: 1 });
  const observedJson = JSON.stringify({ rendererRootSvgCount: 1, errorCount: 0 });
  // The v7 migration backfills the observed_json column with zeros
  // for counters the pre-arc shape omitted (`opaqueRegionCount` and
  // `externalImageCount`); this is the exact reason the migration
  // exists. The post-migration JSON carries those fields too, so
  // the read-back assertion compares against the backfilled shape,
  // not the on-disk shape as it was first planted.
  const backfilledObservedJson = JSON.stringify({
    rendererRootSvgCount: 1,
    errorCount: 0,
    opaqueRegionCount: 0,
    externalImageCount: 0,
  });
  db.query(
    "INSERT INTO render_runs(id, revision_id, tier, status, expected_json, observed_json, screenshot_path, console_path, screenshot_error_json, retained, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "run-v4",
    "revision-v4",
    0,
    "ok",
    expectedJson,
    observedJson,
    null,
    null,
    JSON.stringify({ code: "capture_failed", message: "old screenshot error" }),
    0,
    timestamp,
    timestamp,
  );

  runMigrations(db);

  expect(db.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
    { version: 1 },
    { version: 2 },
    { version: 3 },
    { version: 4 },
    { version: 5 },
    { version: 6 },
    { version: 7 },
  ]);
  expect(
    db
      .query(
        "SELECT expected_json, observed_json, screenshot_error_json, insecure_json FROM render_runs WHERE id = ?",
      )
      .get("run-v4"),
  ).toEqual({
    expected_json: expectedJson,
    observed_json: backfilledObservedJson,
    screenshot_error_json: JSON.stringify({
      code: "capture_failed",
      message: "old screenshot error",
    }),
    insecure_json: null,
  });
});
