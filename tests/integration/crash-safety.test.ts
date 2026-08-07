import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import { openDatabase } from "../../src/service/store/database";
import { runMigrations } from "../../src/service/store/migrations";
import { ArtifactRepository } from "../../src/service/store/repository";

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
  expect(db.query("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'projects'").get()).toEqual({
    name: "projects",
  });
});
