import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDatabase } from "../../src/service/store/database";
import { runMigrations } from "../../src/service/store/migrations";
import { ArtifactRepository } from "../../src/service/store/repository";
import { evictRevisions } from "../../src/service/store/repository-lifecycle";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { dispatch } from "../../src/service/dispatcher";
import { buildInstantiateRequest } from "../../src/cli/commands/instantiate";

const databases: Array<{ close: () => void }> = [];
const roots: string[] = [];

function envelope(data: unknown) {
  return {
    schemaVersion: "facet.v1",
    requestId: crypto.randomUUID(),
    ok: true,
    data: { requestId: crypto.randomUUID(), ...(data as object) },
  };
}

function makeStore() {
  const db = openDatabase({ databasePath: ":memory:" });
  databases.push(db);
  runMigrations(db);
  const repository = new ArtifactRepository(db);
  const project = repository.createProject({ projectRoot: `/tmp/facet-${crypto.randomUUID()}` });
  const artifact = repository.createArtifact({
    projectId: project.id,
    slug: "source",
    title: "Source",
  });
  return { db, repository, artifact };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("promotion", () => {
  test("operator promotion succeeds while the install token is denied", async () => {
    const root = join(tmpdir(), `facet-promotion-${crypto.randomUUID()}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const promoteToken = "operator-token-distinct";
    writeFileSync(join(root, "promote.token"), promoteToken, { mode: 0o600 });
    const service = await startFacetService({
      dbPath: join(root, "facet.sqlite"),
      installTokenPath: join(root, "install.token"),
      promoteTokenPath: join(root, "promote.token"),
      lockPath: join(root, "facet.lock"),
      idleTimeoutMs: 5_000,
      logger: createQuietLogger({ component: "promotion-test" }),
      tier0Runner: stubTier0Runner,
    });
    try {
      const headers = (token: string) => ({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        host: new URL(service.url).host,
      });
      const project = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: headers(service.installToken),
        body: JSON.stringify(
          envelope({ command: "create", projectId: "p", slug: "a", title: "A" }),
        ),
      }).then((res) => res.json());
      const artifactId = project.data.artifact.id as string;
      const published = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: headers(service.installToken),
        body: JSON.stringify(
          envelope({ command: "publish", artifactId, artifactType: "markdown", bytes: "aGk=" }),
        ),
      }).then((res) => res.json());
      const revisionId = published.data.revision.id as string;
      const denied = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: headers(service.installToken),
        body: JSON.stringify(
          envelope({ command: "promote", revisionId, name: "stable", promotedBy: "agent" }),
        ),
      });
      expect(denied.status).toBe(403);
      expect((await denied.json()).error.code).toBe("invalid_envelope");
      const promoted = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: headers(promoteToken),
        body: JSON.stringify(
          envelope({ command: "promote", revisionId, name: "stable", promotedBy: "operator" }),
        ),
      });
      expect(promoted.status).toBe(200);
      expect((await promoted.json()).data.template.promotedBy).toBe("operator");
    } finally {
      await service.stop();
    }
  });

  test("instantiation copies immutable source bytes and artifact type", async () => {
    const { repository, artifact } = makeStore();
    const source = new Uint8Array([0, 255, 7]);
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "svg",
      source,
    });
    const template = repository.promoteRevision({
      revisionId: revision.id,
      name: "stable",
      promotedBy: "operator",
    });
    const result = (await dispatch(
      { repository } as never,
      {
        command: "instantiate",
        requestId: "req",
        name: template.name,
        newSlug: "copy",
      },
      "req",
    )) as { artifact: { id: string } };
    const copiedRevision = repository.getRevisionBySha(result.artifact.id, revision.sha256);
    expect(copiedRevision?.artifactType).toBe("svg");
    expect(Array.from(copiedRevision?.source ?? [])).toEqual(Array.from(source));
    expect(copiedRevision?.artifactId).not.toBe(revision.artifactId);
  });

  test("template source remains byte-identical after later publishes", () => {
    const { repository, artifact } = makeStore();
    const original = new Uint8Array([1, 2, 3]);
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: original,
    });
    repository.promoteRevision({ revisionId: revision.id, name: "stable", promotedBy: "operator" });
    for (const value of [4, 5, 6]) {
      repository.publishRevision({
        artifactId: artifact.id,
        artifactType: "markdown",
        source: new Uint8Array([value]),
      });
    }
    expect(Array.from(repository.getRevisionById(revision.id)?.source ?? [])).toEqual(
      Array.from(original),
    );
    expect(repository.getRevisionBySha(artifact.id, revision.sha256)?.sha256).toBe(revision.sha256);
  });

  test("rejects publication when all 50 retained revisions are pinned", () => {
    const { repository, artifact } = makeStore();
    for (let index = 0; index < 50; index += 1) {
      const revision = repository.publishRevision({
        artifactId: artifact.id,
        artifactType: "markdown",
        source: new Uint8Array([index]),
      });
      repository.pinRevision(revision.id);
    }
    expect(() =>
      repository.publishRevision({
        artifactId: artifact.id,
        artifactType: "markdown",
        source: new Uint8Array([99]),
      }),
    ).toThrowError(expect.objectContaining({ code: "revision_capacity_pinned" }));
  });

  test("allows the newest revision to be evicted when it is the only eligible candidate", () => {
    const { db, repository, artifact } = makeStore();
    const revisions = Array.from({ length: 50 }, (_, index) =>
      repository.publishRevision({
        artifactId: artifact.id,
        artifactType: "markdown",
        source: new Uint8Array([index]),
      }),
    );
    for (const revision of revisions) repository.pinRevision(revision.id);
    const source = new Uint8Array([99]);
    const sha256 = new Bun.CryptoHasher("sha256");
    sha256.update(source);
    const revisionId = crypto.randomUUID();
    db.query(
      "INSERT INTO revisions(id, artifact_id, revision_number, parent_revision_id, artifact_type, source, sha256, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      revisionId,
      artifact.id,
      51,
      revisions[49]!.id,
      "markdown",
      source,
      sha256.digest("hex"),
      null,
      new Date().toISOString(),
    );
    evictRevisions(db, artifact.id);
    expect(repository.getRevisionById(revisionId)).toBeNull();
  });

  test("instantiate does not require or emit a promotion audit actor", () => {
    const request = buildInstantiateRequest({ name: "stable", "new-slug": "copy" });
    expect(request).not.toHaveProperty("promotedBy");
  });
});
