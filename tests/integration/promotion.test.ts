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
import { RenderStatusSchema } from "../../src/shared/contracts/validation";
import { parseArgs, renderHelp } from "../../src/cli/parser";
import { buildPromoteRequest } from "../../src/cli/commands/promote";

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
  test("duplicate template name is a typed conflict and cannot insert a second row", () => {
    const { db, repository, artifact } = makeStore();
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new Uint8Array([71]),
    });
    repository.recordRenderRun({
      revisionId: revision.id,
      tier: 1,
      status: "ok",
      expected: {},
      observed: {},
    });
    const input = { revisionId: revision.id, name: "shared-name", promotedBy: "operator" };
    repository.promoteRevision(input);
    expect(() => repository.promoteRevision(input)).toThrowError(
      expect.objectContaining({ code: "template_name_taken", details: { name: "shared-name" } }),
    );
    expect(
      db.query("SELECT COUNT(*) AS count FROM templates WHERE name = ?").get("shared-name"),
    ).toEqual({ count: 1 });
    expect(() =>
      repository.publishRevision({
        artifactId: artifact.id,
        artifactType: "markdown",
        source: new Uint8Array([71]),
      }),
    ).toThrowError(expect.objectContaining({ code: "duplicate_revision" }));
  });
  const allowed = new Set([
    "ok",
    "partial:layout_unverified",
    "partial:opaque_content",
    "partial:external_resources",
    "partial:unstable",
  ]);

  test.each(RenderStatusSchema.options)("classifies newest visual status %s", (status) => {
    const { db, repository, artifact } = makeStore();
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new TextEncoder().encode(status),
    });
    repository.recordRenderRun({
      revisionId: revision.id,
      tier: 1,
      status,
      expected: {},
      observed: {},
    });
    const input = { revisionId: revision.id, name: `status-${status}`, promotedBy: "operator" };
    if (allowed.has(status)) {
      expect(repository.promoteRevision(input).promotionOverride).toBeNull();
    } else {
      expect(() => repository.promoteRevision(input)).toThrowError(
        expect.objectContaining({
          code: "promotion_refused",
          details: expect.objectContaining({ reason: status, tier1Status: status }),
        }),
      );
      expect(
        (db.query("SELECT COUNT(*) AS count FROM templates").get() as { count: number }).count,
      ).toBe(0);
    }
  });

  test("refuses missing visual verification without inserting a template", () => {
    const { db, repository, artifact } = makeStore();
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new Uint8Array([1]),
    });
    expect(() =>
      repository.promoteRevision({
        revisionId: revision.id,
        name: "missing",
        promotedBy: "operator",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "promotion_refused",
        details: {
          revisionId: revision.id,
          reason: "no_visual_verification",
          tier1Status: null,
          tier0Status: null,
        },
      }),
    );
    expect(db.query("SELECT COUNT(*) AS count FROM templates").get()).toEqual({ count: 0 });
  });

  test("a failed parse cannot be redeemed by a visual ok", () => {
    const { repository, artifact } = makeStore();
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new Uint8Array([2]),
    });
    repository.recordRenderRun({
      revisionId: revision.id,
      tier: 0,
      status: "error",
      expected: {},
      observed: {},
    });
    repository.recordRenderRun({
      revisionId: revision.id,
      tier: 1,
      status: "ok",
      expected: {},
      observed: {},
    });
    expect(() =>
      repository.promoteRevision({
        revisionId: revision.id,
        name: "bad-parse",
        promotedBy: "operator",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "promotion_refused",
        details: expect.objectContaining({
          reason: "error",
          tier0Status: "error",
          tier1Status: "ok",
        }),
      }),
    );
  });

  test.each([
    ["error", "ok", true],
    ["ok", "error", false],
  ] as const)("newer visual %s supersedes older %s", (oldStatus, newStatus, permitted) => {
    const { repository, artifact } = makeStore();
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new Uint8Array([3]),
    });
    for (const [status, finishedAt] of [
      [oldStatus, "2026-01-01T00:00:00.000Z"],
      [newStatus, "2026-01-02T00:00:00.000Z"],
    ] as const) {
      repository.recordRenderRun({
        revisionId: revision.id,
        tier: 1,
        status,
        expected: {},
        observed: {},
        finishedAt,
      });
    }
    const input = { revisionId: revision.id, name: "latest", promotedBy: "operator" };
    if (permitted) expect(repository.promoteRevision(input).promotionOverride).toBeNull();
    else
      expect(() => repository.promoteRevision(input)).toThrowError(
        expect.objectContaining({ code: "promotion_refused" }),
      );
  });

  test("override persists refusal reason and templates show live source verdict", async () => {
    const { repository, artifact } = makeStore();
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new Uint8Array([4]),
    });
    const result = (await dispatch(
      { repository } as never,
      {
        command: "promote",
        requestId: "override",
        revisionId: revision.id,
        name: "override",
        promotedBy: "operator",
        allowUnverified: true,
      },
      "override",
    )) as { template: { promotionOverride: string } };
    expect(result.template.promotionOverride).toBe("no_visual_verification");
    expect(repository.findTemplateByName("override")?.promotionOverride).toBe(
      "no_visual_verification",
    );
    const before = (await dispatch(
      { repository } as never,
      { command: "templates", requestId: "before" },
      "before",
    )) as { templates: Array<{ promotionOverride: string; sourceVerdict: unknown }> };
    expect(before.templates[0]).toMatchObject({
      promotionOverride: "no_visual_verification",
      sourceVerdict: null,
    });
    repository.recordRenderRun({
      revisionId: revision.id,
      tier: 1,
      status: "ok",
      expected: {},
      observed: {},
    });
    const after = (await dispatch(
      { repository } as never,
      { command: "templates", requestId: "after" },
      "after",
    )) as {
      templates: Array<{ revisionSha: string; sourceVerdict: { status: string; tier: number } }>;
    };
    expect(after.templates[0]).toMatchObject({
      revisionSha: revision.sha256,
      sourceVerdict: { status: "ok", tier: 1 },
    });
  });

  test("promote override flag and templates help parse", () => {
    expect(
      parseArgs([
        "promote",
        "--revision-id",
        "r",
        "--name",
        "n",
        "--promoted-by",
        "p",
        "--allow-unverified",
      ]),
    ).toMatchObject({ kind: "verb", args: { "allow-unverified": true } });
    expect(
      buildPromoteRequest({
        "revision-id": "r",
        name: "n",
        "promoted-by": "p",
        "allow-unverified": true,
      }),
    ).toMatchObject({ allowUnverified: true });
    expect(parseArgs(["templates", "--help"])).toMatchObject({ kind: "help", verb: "templates" });
    expect(renderHelp("templates" as never)).toContain("--limit");
  });
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
      const refused = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: headers(promoteToken),
        body: JSON.stringify(
          envelope({ command: "promote", revisionId, name: "refused", promotedBy: "operator" }),
        ),
      });
      expect(refused.status).toBe(409);
      const refusalBody = await refused.json();
      expect(refusalBody.error).toMatchObject({
        code: "promotion_refused",
        details: {
          revisionId,
          reason: "no_visual_verification",
          tier1Status: null,
          tier0Status: "ok",
        },
      });
      expect(refusalBody.error.message).toContain(
        `facet read-back --artifact-id ${artifactId} --tier visual`,
      );
      expect(refusalBody.error.message).toContain("--allow-unverified");
      const promoted = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: headers(promoteToken),
        body: JSON.stringify(
          envelope({
            command: "promote",
            revisionId,
            name: "stable",
            promotedBy: "operator",
            allowUnverified: true,
          }),
        ),
      });
      expect(promoted.status).toBe(200);
      expect((await promoted.json()).data.template).toMatchObject({
        promotedBy: "operator",
        promotionOverride: "no_visual_verification",
      });
      const templates = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: headers(service.installToken),
        body: JSON.stringify(envelope({ command: "templates", limit: 1 })),
      });
      expect(templates.status).toBe(200);
      expect((await templates.json()).data.templates).toMatchObject([
        {
          name: "stable",
          revisionId,
          promotionOverride: "no_visual_verification",
          sourceVerdict: { status: "ok", tier: 0 },
        },
      ]);
      const nameTaken = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: headers(promoteToken),
        body: JSON.stringify(
          envelope({
            command: "promote",
            revisionId,
            name: "stable",
            promotedBy: "operator",
            allowUnverified: true,
          }),
        ),
      });
      expect(nameTaken.status).toBe(409);
      expect((await nameTaken.json()).error).toMatchObject({
        code: "template_name_taken",
        details: { name: "stable" },
      });
    } finally {
      await service.stop();
    }
  });

  test("rejects promotion when the supplied artifactId does not own the revision", () => {
    const { repository, artifact } = makeStore();
    const other = repository.createArtifact({
      projectId: artifact.projectId,
      slug: "other",
      title: "Other",
    });
    const revision = repository.publishRevision({
      artifactId: other.id,
      artifactType: "markdown",
      source: new TextEncoder().encode("# other"),
    });
    expect(() =>
      repository.promoteRevision({
        artifactId: artifact.id,
        revisionId: revision.id,
        name: "cross-artifact",
        promotedBy: "operator",
      }),
    ).toThrow(/does not own|belongs to|foreign_key/i);
  });

  test("promotes when the supplied artifactId matches the revision owner", () => {
    const { repository, artifact } = makeStore();
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "markdown",
      source: new TextEncoder().encode("# match"),
    });
    const template = repository.promoteRevision({
      artifactId: artifact.id,
      revisionId: revision.id,
      name: "matching",
      promotedBy: "operator",
      allowUnverified: true,
    });
    expect(template.artifactId).toBe(artifact.id);
  });

  test("instantiation copies immutable source bytes, artifact type, and renderer", async () => {
    const { repository, artifact } = makeStore();
    const source = new Uint8Array([0, 255, 7]);
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "chart",
      renderer: "canvas",
      source,
    });
    const template = repository.promoteRevision({
      revisionId: revision.id,
      name: "stable",
      promotedBy: "operator",
      allowUnverified: true,
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
    expect(copiedRevision?.artifactType).toBe("chart");
    expect(copiedRevision?.renderer).toBe("canvas");
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
    repository.promoteRevision({
      revisionId: revision.id,
      name: "stable",
      promotedBy: "operator",
      allowUnverified: true,
    });
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

  test("instantiate preserves source execution mode for TSX interactive templates", () => {
    // The instantiate command must copy the source revision's
    // execution mode end-to-end. A TSX interactive template must
    // produce an interactive revision rather than silently falling
    // back to the non-TSX default.
    const { repository, artifact } = makeStore();
    const source = new Uint8Array([1, 2, 3]);
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "tsx",
      source,
      execution: "interactive",
    });
    const template = repository.promoteRevision({
      revisionId: revision.id,
      name: "interactive-tsx",
      promotedBy: "operator",
      allowUnverified: true,
    });
    return (async () => {
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
      expect(copiedRevision?.artifactType).toBe("tsx");
      expect(copiedRevision?.execution).toBe("interactive");
    })();
  });
});
