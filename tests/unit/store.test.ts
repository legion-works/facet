import { afterEach, describe, expect, test } from "bun:test";

import { openDatabase } from "../../src/service/store/database";
import { ArtifactRepository } from "../../src/service/store/repository";
import { runMigrations } from "../../src/service/store/migrations";

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

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("artifact store", () => {
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
});
