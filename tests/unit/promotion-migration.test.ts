import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../../src/service/store/database";
import { runMigrations, latestMigrationVersion } from "../../src/service/store/migrations";
import { ArtifactRepository } from "../../src/service/store/repository";
import {
  INITIAL_SCHEMA,
  V2_SCHEMA_FRAGMENT,
  V3_SCHEMA_FRAGMENT,
  V4_SCHEMA_FRAGMENT,
  V5_SCHEMA_FRAGMENT,
  V6_SCHEMA_FRAGMENT,
  V7_SCHEMA_FRAGMENT,
  V8_SCHEMA_FRAGMENT,
  V9_SCHEMA_FRAGMENT,
} from "../../src/service/store/schema";
import { CURRENT_STORAGE_VERSION } from "../../src/shared/storage-version";
import { runDoctor } from "../../src/cli/commands/doctor";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

test("v9 template migrates with a null override and a live v10 doctor database probe", () => {
  const root = mkdtempSync(join(tmpdir(), "facet-promotion-migrate-"));
  roots.push(root);
  const path = join(root, "facet.sqlite");
  const db = openDatabase({ databasePath: path });
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    for (const fragment of [
      INITIAL_SCHEMA,
      V2_SCHEMA_FRAGMENT,
      V3_SCHEMA_FRAGMENT,
      V4_SCHEMA_FRAGMENT,
      V5_SCHEMA_FRAGMENT,
      V6_SCHEMA_FRAGMENT,
      V7_SCHEMA_FRAGMENT,
      V8_SCHEMA_FRAGMENT,
      V9_SCHEMA_FRAGMENT,
    ])
      db.exec(fragment);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (let version = 1; version <= 9; version += 1)
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        version,
        "2026-01-01T00:00:00.000Z",
      );
    const repo = new ArtifactRepository(db);
    const project = repo.createProject({ projectRoot: root });
    const artifact = repo.createArtifact({
      projectId: project.id,
      slug: "legacy",
      title: "Legacy",
    });
    const revision = repo.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new Uint8Array([1]),
    });
    db.query(
      "INSERT INTO templates(id, artifact_id, revision_id, name, promoted_by, promoted_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      crypto.randomUUID(),
      artifact.id,
      revision.id,
      "legacy-template",
      "operator",
      new Date().toISOString(),
    );
    const copy = join(root, "migration-copy.sqlite");
    const verify = Bun.spawnSync([
      process.execPath,
      "scripts/verify-operator-migration.ts",
      "--source",
      path,
      "--copy",
      copy,
    ]);
    expect(verify.exitCode).toBe(0);
    const result = JSON.parse(new TextDecoder().decode(verify.stdout)) as {
      postconditions: Record<string, { passed: boolean }>;
    };
    expect(result.postconditions["10"]).toMatchObject({ passed: true });
    runMigrations(db);
    expect(latestMigrationVersion()).toBe(CURRENT_STORAGE_VERSION);
    expect(
      db.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get(),
    ).toEqual({ version: CURRENT_STORAGE_VERSION });
    expect(
      db.query("SELECT promotion_override FROM templates WHERE name = ?").get("legacy-template"),
    ).toEqual({ promotion_override: null });
    expect(repo.findTemplateByName("legacy-template")?.promotionOverride).toBeNull();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const doctor = runDoctor({
      paths: {
        database: path,
        evidence: join(root, "evidence"),
        token: join(root, "token"),
        lock: join(root, "lock"),
        metadata: join(root, "metadata"),
      },
      shellBinary: null,
      netns: { available: false, reason: "test" },
    });
    expect(doctor.probes.find((probe) => probe.name === "database")).toMatchObject({
      status: "pass",
      details: { version: CURRENT_STORAGE_VERSION },
    });
  } finally {
    db.close();
  }
});
