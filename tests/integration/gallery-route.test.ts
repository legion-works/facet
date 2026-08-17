import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startFacetService } from "../../src/service/server";
import { FacetClient, publishArtifact } from "../../src/cli/client";
import { CommandResultSchema } from "../../src/shared/contracts/commands";
import { generateRequestId } from "../../src/shared/util/time";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { openDatabase } from "../../src/service/store/database";
import { runMigrations } from "../../src/service/store/migrations";
import { ArtifactRepository } from "../../src/service/store/repository";

const GALLERY_DIR = join(import.meta.dir, "../../dist/gallery");
const originalGalleryDir = mkdtempSync(join(tmpdir(), "facet-gallery-route-original-"));
rmSync(originalGalleryDir, { recursive: true, force: true });

function moveGalleryDir(destination: string): void {
  if (existsSync(GALLERY_DIR)) {
    cpSync(GALLERY_DIR, destination, { recursive: true });
    rmSync(GALLERY_DIR, { recursive: true, force: true });
  }
}

function restoreGalleryDir(): void {
  rmSync(GALLERY_DIR, { recursive: true, force: true });
  if (existsSync(originalGalleryDir)) {
    cpSync(originalGalleryDir, GALLERY_DIR, { recursive: true });
  }
}

describe("GET /gallery", () => {
  let service: Awaited<ReturnType<typeof startFacetService>> | undefined;
  let envDir: string | undefined;

  afterEach(async () => {
    await service?.stop();
    service = undefined;
    restoreGalleryDir();
    if (envDir !== undefined) rmSync(envDir, { recursive: true, force: true });
    envDir = undefined;
  });

  test("builds the real shell on demand and serves its referenced asset", async () => {
    moveGalleryDir(originalGalleryDir);
    rmSync(GALLERY_DIR, { recursive: true, force: true });
    const testEnvDir = mkdtempSync(join(tmpdir(), "facet-gallery-route-"));
    envDir = testEnvDir;
    service = await startFacetService({
      dbPath: join(testEnvDir, "facet.sqlite"),
      installTokenPath: join(testEnvDir, "install.token"),
      promoteTokenPath: join(testEnvDir, "promote.token"),
      lockPath: join(testEnvDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-route-test" }),
      tier0Runner: stubTier0Runner,
    });

    const response = await fetch(`${service.url}/gallery`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain("Loading facet gallery…");
    expect(html).toMatch(/<script[^>]+src=["'][^"']+["']/i);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");

    const assetPath = html.match(/<script[^>]+src=["']([^"']+)["']/i)?.[1];
    expect(assetPath).toBeDefined();
    const asset = await fetch(new URL(assetPath!, `${service.url}/gallery`));
    expect(asset.status).toBe(200);
    const galleryAsset = await fetch(new URL(assetPath!, `${service.url}/gallery/`));
    expect(galleryAsset.status).toBe(200);
  });

  test("GET /index.html carries the same CSP and bytes as /gallery", async () => {
    moveGalleryDir(originalGalleryDir);
    rmSync(GALLERY_DIR, { recursive: true, force: true });
    const testEnvDir = mkdtempSync(join(tmpdir(), "facet-gallery-route-"));
    envDir = testEnvDir;
    service = await startFacetService({
      dbPath: join(testEnvDir, "facet.sqlite"),
      installTokenPath: join(testEnvDir, "install.token"),
      promoteTokenPath: join(testEnvDir, "promote.token"),
      lockPath: join(testEnvDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-route-index-test" }),
      tier0Runner: stubTier0Runner,
    });

    const galleryResponse = await fetch(`${service.url}/gallery`);
    const galleryBytes = await galleryResponse.arrayBuffer();
    const galleryCsp = galleryResponse.headers.get("content-security-policy");
    expect(galleryCsp).not.toBeNull();

    const indexResponse = await fetch(`${service.url}/index.html`);
    const indexBytes = await indexResponse.arrayBuffer();
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("content-security-policy")).toBe(galleryCsp);
    expect(Buffer.from(indexBytes).equals(Buffer.from(galleryBytes))).toBe(true);
  });

  test("GET /index.html builds the gallery before serving the root fallback", async () => {
    moveGalleryDir(originalGalleryDir);
    rmSync(GALLERY_DIR, { recursive: true, force: true });
    const testEnvDir = mkdtempSync(join(tmpdir(), "facet-gallery-root-fallback-"));
    envDir = testEnvDir;
    service = await startFacetService({
      dbPath: join(testEnvDir, "facet.sqlite"),
      installTokenPath: join(testEnvDir, "install.token"),
      promoteTokenPath: join(testEnvDir, "promote.token"),
      lockPath: join(testEnvDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-root-fallback-test" }),
      tier0Runner: stubTier0Runner,
    });

    const response = await fetch(`${service.url}/index.html`);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("Loading facet gallery…");
  });

  test("the frame script route refuses to escape the gallery root", async () => {
    // af46b64 added a NEW file-serving route keyed on URL path
    // (/gallery/frame/bootstrap/*.js, /gallery/frame/chunks/*.js) so each
    // artifact type loads only its own renderer bundle. Path traversal is the
    // classic defect of exactly that shape, and the guard is worth an
    // executable proof rather than a careful read.
    const testEnvDir = mkdtempSync(join(tmpdir(), "facet-gallery-traversal-"));
    envDir = testEnvDir;
    service = await startFacetService({
      dbPath: join(testEnvDir, "facet.sqlite"),
      installTokenPath: join(testEnvDir, "install.token"),
      promoteTokenPath: join(testEnvDir, "promote.token"),
      lockPath: join(testEnvDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-traversal-test" }),
      tier0Runner: stubTier0Runner,
    });

    // The escape targets must EXIST on disk outside the gallery root, or the
    // 404 proves only that the file is missing. Mutation-checked: with the
    // traversal guard disabled these requests return 200 and serve real bytes
    // from node_modules. An earlier version of this test aimed at
    // /etc/passwd.js and passed with the guard removed — a guard verified by an
    // unrelated 404 is not verified at all.
    // FOUR levels: the request path is already two deep (frame/bootstrap/),
    // and dist/gallery is two below the repo root. Under-escaping produces a
    // path that never leaves the root, which passes for the wrong reason.
    const realFileOutsideRoot = "../../../../node_modules/marked/lib/marked.esm.js";
    const escapes = [
      `/gallery/frame/runtime/${realFileOutsideRoot}`,
      `/gallery/frame/chunks/${realFileOutsideRoot}`,
      "/gallery/frame/runtime/..%2f..%2f..%2f..%2fnode_modules%2fmarked%2flib%2fmarked.esm.js",
      "/gallery/frame/chunks/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fnode_modules%2fmarked%2flib%2fmarked.esm.js",
    ];
    for (const escape of escapes) {
      const response = await fetch(`${service.url}${escape}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("marked");
    }

    // A legitimate bundle still serves, so the guard is not just refusing
    // everything — a 404-for-all guard would pass the assertions above while
    // breaking the gallery entirely.
    const legit = await fetch(`${service.url}/gallery/frame/runtime/svg.js`);
    expect(legit.status).toBe(200);
    expect((await legit.text()).length).toBeGreaterThan(0);
  });

  test("serves an ordinary same-origin frame document without source bytes", async () => {
    const testEnvDir = mkdtempSync(join(tmpdir(), "facet-gallery-frame-"));
    envDir = testEnvDir;
    service = await startFacetService({
      dbPath: join(testEnvDir, "facet.sqlite"),
      installTokenPath: join(testEnvDir, "install.token"),
      promoteTokenPath: join(testEnvDir, "promote.token"),
      lockPath: join(testEnvDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-frame-test" }),
      tier0Runner: stubTier0Runner,
    });
    const frame = await fetch(`${service.url}/gallery/frame?type=markdown`);
    const document = await frame.text();
    expect(frame.status).toBe(200);
    const frameCsp = frame.headers.get("content-security-policy");
    expect(frameCsp).toBe(
      "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; font-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(document).toContain('<link rel="stylesheet" href="/gallery/frame/frame.css">');
    expect(document).toContain(
      '<script type="module" src="/gallery/frame/runtime/markdown.js"></script>',
    );
    expect(document).not.toContain("FACET_SENTINEL_ARTIFACT_BYTES");
    expect(document.match(/<script/gi)?.length ?? 0).toBe(1);
    expect(document).not.toContain("nonce=");
    expect(document).not.toContain("handshake=");
    expect(document).not.toContain("Content-Security-Policy");
    expect(document).not.toMatch(/<style[\s>]/i);

    const htmlFrame = await fetch(`${service.url}/gallery/frame?type=html`);
    expect(htmlFrame.status).toBe(200);
    const htmlDocument = await htmlFrame.text();
    expect(htmlDocument.match(/href="\/gallery\/frame\/artifact\.css"/g)?.length ?? 0).toBe(1);
    expect(htmlDocument).toContain(
      '<script type="module" src="/gallery/frame/runtime/html.js"></script>',
    );
    const tsxFrame = await fetch(`${service.url}/gallery/frame?type=tsx`);
    expect(tsxFrame.status).toBe(200);
    const tsxDocument = await tsxFrame.text();
    expect(tsxDocument.match(/href="\/gallery\/frame\/artifact\.css"/g)?.length ?? 0).toBe(1);
    expect(tsxDocument).toContain(
      '<script type="module" src="/gallery/frame/runtime/tsx.js"></script>',
    );
    expect(document).not.toContain("artifact.css");
    const invalidType = await fetch(`${service.url}/gallery/frame?type=pdf`);
    expect(invalidType.status).toBe(400);

    const runtime = await fetch(`${service.url}/gallery/frame/runtime/markdown.js`);
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get("access-control-allow-origin")).toBeNull();
    const runtimeSource = await runtime.text();
    const chunkPath = runtimeSource.match(/["'](\.\.\/chunks\/[^"']+\.js)["']/)?.[1];
    expect(chunkPath).toBeDefined();
    const chunk = await fetch(new URL(chunkPath!, runtime.url));
    expect(chunk.status).toBe(200);
    expect(chunk.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("serves source only through the matching live gallery lease", async () => {
    const testEnvDir = mkdtempSync(join(tmpdir(), "facet-gallery-source-"));
    envDir = testEnvDir;
    service = await startFacetService({
      dbPath: join(testEnvDir, "facet.sqlite"),
      installTokenPath: join(testEnvDir, "install.token"),
      promoteTokenPath: join(testEnvDir, "promote.token"),
      lockPath: join(testEnvDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-source-test" }),
      tier0Runner: stubTier0Runner,
    });
    const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
    const first = await publishArtifact(client, {
      artifactType: "mermaid",
      bytes: new TextEncoder().encode("graph TD\n A-->B").buffer as ArrayBuffer,
      slug: "source-a",
    });
    const second = await publishArtifact(client, {
      artifactType: "mermaid",
      bytes: new TextEncoder().encode("graph TD\n C-->D").buffer as ArrayBuffer,
      slug: "source-b",
    });
    const openResponse = await client.sendCommand({
      command: "open",
      requestId: generateRequestId(),
      artifactId: first.artifactId,
      revisionSha: first.revisionSha,
    });
    expect(openResponse.ok).toBe(true);
    if (!openResponse.ok) throw new Error("open request failed");
    const open = CommandResultSchema.parse(openResponse.data);
    expect(open.command).toBe("open");
    if (open.command !== "open") throw new Error("open result mismatch");
    const bootstrap = await fetch(new URL(open.frameUrl).origin + "/api/v1/gallery/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: new URL(open.frameUrl).hash.split("=")[1] }),
    });
    const handoff = (await bootstrap.json()) as {
      authorization: string;
      artifactId: string;
      lease: { leaseId: string };
    };
    const sourceUrl = `${service.url}/api/v1/gallery/source?revisionSha=${first.revisionSha}`;
    const source = await fetch(sourceUrl, {
      headers: {
        authorization: handoff.authorization,
        "x-gallery-lease": handoff.lease.leaseId,
        "x-gallery-artifact": first.artifactId,
      },
    });
    expect(source.status).toBe(200);
    const sourceBody = (await source.json()) as { verdict: unknown };
    expect(sourceBody).toMatchObject({
      artifactId: first.artifactId,
      slug: "source-a",
      title: "source-a",
      artifactType: "mermaid",
      renderer: "svg",
    });
    expect(sourceBody.verdict).toMatchObject({
      artifactId: first.artifactId,
      revisionSha: first.revisionSha,
      tier: 0,
    });
    expect((await fetch(sourceUrl)).status).toBe(401);
    expect(
      (
        await fetch(sourceUrl, {
          headers: {
            authorization: handoff.authorization,
            "x-gallery-lease": "wrong",
            "x-gallery-artifact": first.artifactId,
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${service.url}/api/v1/gallery/source?revisionSha=${second.revisionSha}`, {
          headers: {
            authorization: handoff.authorization,
            "x-gallery-lease": handoff.lease.leaseId,
            "x-gallery-artifact": first.artifactId,
          },
        })
      ).status,
    ).toBe(404);
    // The lease is for artifact A, but artifactId is read from the CALLER's
    // X-Gallery-Artifact header. Naming artifact B with B's own revisionSha
    // makes the repository lookup SUCCEED, so only the lease's artifact-match
    // stands between a display lease and another artifact's bytes.
    expect(
      (
        await fetch(`${service.url}/api/v1/gallery/source?revisionSha=${second.revisionSha}`, {
          headers: {
            authorization: handoff.authorization,
            "x-gallery-lease": handoff.lease.leaseId,
            "x-gallery-artifact": second.artifactId,
          },
        })
      ).status,
    ).toBe(401);
  });

  test("returns null for an unvalidated revision without creating a render run", async () => {
    const testEnvDir = mkdtempSync(join(tmpdir(), "facet-gallery-source-unverified-"));
    envDir = testEnvDir;
    const dbPath = join(testEnvDir, "facet.sqlite");
    const db = openDatabase({ databasePath: dbPath });
    runMigrations(db);
    const repository = new ArtifactRepository(db);
    const project = repository.createProject({ projectRoot: testEnvDir });
    const artifact = repository.createArtifact({
      projectId: project.id,
      slug: "unverified",
      title: "Unverified",
    });
    const revision = repository.publishRevision({
      artifactId: artifact.id,
      artifactType: "mermaid",
      source: new TextEncoder().encode("graph TD\n A-->B"),
    });
    expect(repository.listRenderRuns({ revisionId: revision.id, tier: 0 })).toHaveLength(0);
    db.close();

    service = await startFacetService({
      dbPath,
      installTokenPath: join(testEnvDir, "install.token"),
      promoteTokenPath: join(testEnvDir, "promote.token"),
      lockPath: join(testEnvDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-source-unverified-test" }),
      tier0Runner: stubTier0Runner,
    });
    const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
    const openResponse = await client.sendCommand({
      command: "open",
      requestId: generateRequestId(),
      artifactId: artifact.id,
      revisionSha: revision.sha256,
    });
    expect(openResponse.ok).toBe(true);
    if (!openResponse.ok) throw new Error("open request failed");
    const open = CommandResultSchema.parse(openResponse.data);
    if (open.command !== "open") throw new Error("open result mismatch");
    const bootstrap = await fetch(`${service.url}/api/v1/gallery/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: new URL(open.frameUrl).hash.split("=")[1] }),
    });
    const handoff = (await bootstrap.json()) as {
      authorization: string;
      lease: { leaseId: string };
    };
    const source = await fetch(
      `${service.url}/api/v1/gallery/source?revisionSha=${revision.sha256}`,
      {
        headers: {
          authorization: handoff.authorization,
          "x-gallery-lease": handoff.lease.leaseId,
          "x-gallery-artifact": artifact.id,
        },
      },
    );
    expect(source.status).toBe(200);
    expect((await source.json()).verdict).toBeNull();
    await service.stop();
    service = undefined;
    const verifyDb = openDatabase({ databasePath: dbPath });
    runMigrations(verifyDb);
    const verifyRepository = new ArtifactRepository(verifyDb);
    expect(verifyRepository.listRenderRuns({ revisionId: revision.id, tier: 0 })).toHaveLength(0);
    expect(verifyRepository.listRenderRuns({ revisionId: revision.id, tier: 1 })).toHaveLength(0);
    verifyDb.close();
  });
});
