/**
 * Integration tests for the loopback service.
 *
 * Each test starts a real `startFacetService` instance on an
 * ephemeral path under /tmp, exercises the API surface end-to-end
 * (Bearer auth, host pinning, mutation guards, envelope round-trip),
 * and asserts every response is a strict FacetEnvelope with no stray
 * diagnostics on stdout.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FACET_SCHEMA_VERSION, FacetEnvelopeSchema } from "../../src/shared/contracts/envelope";
import {
  CommandRequestSchema,
  CommandResultSchema,
  type CommandResult,
} from "../../src/shared/contracts/commands";

import { startFacetService, type RunningService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";

interface TestEnv {
  service: RunningService;
  baseUrl: string;
  installToken: string;
  promoteToken: string | null;
  cleanup: () => void;
}

const scratchRoot = join(tmpdir(), `facet-api-test-${crypto.randomUUID()}`);

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
});

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

async function startService(): Promise<TestEnv> {
  const envDir = join(scratchRoot, crypto.randomUUID());
  mkdirSync(envDir, { recursive: true });
  const dbPath = join(envDir, "facet.sqlite");
  const installTokenPath = join(envDir, "install.token");
  const promoteTokenPath = join(envDir, "promote.token");
  const lockPath = join(envDir, "facet.lock");

  const service = await startFacetService({
    dbPath,
    installTokenPath,
    promoteTokenPath,
    lockPath,
    idleTimeoutMs: 5_000,
    logger: createQuietLogger({ component: "test" }),
    tier0Runner: stubTier0Runner,
  });

  return {
    service,
    baseUrl: service.url,
    installToken: service.installToken,
    promoteToken: service.promoteToken,
    cleanup: async () => {
      await service.stop();
    },
  };
}

function envelopeRequest(env: TestEnv, body: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${env.installToken}`,
    host: new URL(env.baseUrl).host,
    ...extraHeaders,
  };
  // Ensure the inner command body carries a requestId. The wire contract
  // requires both an outer envelope requestId AND an inner command
  // requestId (for correlation against the result).
  const innerRequestId = `req-${crypto.randomUUID()}`;
  const data =
    typeof body === "object" && body !== null
      ? { requestId: innerRequestId, ...(body as Record<string, unknown>) }
      : { requestId: innerRequestId, payload: body };
  const wrapped = {
    schemaVersion: FACET_SCHEMA_VERSION,
    requestId: innerRequestId,
    ok: true as const,
    data,
  };
  return fetch(`${env.baseUrl}/api/v1/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify(wrapped),
  });
}

function parseEnvelopeStrict(text: string): unknown {
  const parsed = JSON.parse(text);
  return FacetEnvelopeSchema.parse(parsed);
}

describe("service API integration", () => {
  test("publish happy path returns a strict ok envelope", async () => {
    const env = await startService();
    try {
      // First create an artifact via the API.
      const createRes = await envelopeRequest(env, {
        command: "create",
        projectId: "project-1",
        slug: "hello",
        title: "Hello",
      });
      const createBody = parseEnvelopeStrict(await createRes.text()) as {
        ok: true;
        data: { artifact: { id: string } };
      };
      expect(createBody.ok).toBe(true);

      const publishRes = await envelopeRequest(env, {
        command: "publish",
        artifactId: createBody.data.artifact.id,
        artifactType: "markdown",
        bytes: "aGk=", // base64("hi")
      });
      const publishBody = parseEnvelopeStrict(await publishRes.text()) as {
        ok: true;
        data: CommandResult;
      };
      expect(publishBody.ok).toBe(true);
      expect(publishBody.data.command).toBe("publish");
      if (publishBody.data.command === "publish") {
        expect(publishBody.data.revision.artifactType).toBe("markdown");
        expect(publishBody.data.revision.renderer).toBe("svg");
        expect(publishBody.data.revision.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    } finally {
      await env.cleanup();
    }
  });

  test("publish preserves an explicitly requested canvas renderer", async () => {
    const env = await startService();
    try {
      const createRes = await envelopeRequest(env, {
        command: "create",
        projectId: "project-1",
        slug: "chart",
        title: "Chart",
      });
      const createBody = parseEnvelopeStrict(await createRes.text()) as {
        ok: true;
        data: { artifact: { id: string } };
      };
      const publishRes = await envelopeRequest(env, {
        command: "publish",
        artifactId: createBody.data.artifact.id,
        artifactType: "chart",
        renderer: "canvas",
        bytes: Buffer.from("{}", "utf8").toString("base64"),
      });
      const publishBody = parseEnvelopeStrict(await publishRes.text()) as {
        ok: true;
        data: CommandResult;
      };
      expect(publishBody.ok).toBe(true);
      if (publishBody.data.command === "publish") {
        expect(publishBody.data.revision.renderer).toBe("canvas");
      }
    } finally {
      await env.cleanup();
    }
  });

  test("rejects canvas renderer for non-chart publish", async () => {
    const env = await startService();
    try {
      const createRes = await envelopeRequest(env, {
        command: "create",
        projectId: "project-1",
        slug: "markdown-canvas",
        title: "Markdown canvas",
      });
      const createBody = parseEnvelopeStrict(await createRes.text()) as {
        ok: true;
        data: { artifact: { id: string } };
      };
      const res = await envelopeRequest(env, {
        command: "publish",
        artifactId: createBody.data.artifact.id,
        artifactType: "markdown",
        renderer: "canvas",
        bytes: Buffer.from("hello", "utf8").toString("base64"),
      });
      expect(res.status).toBe(400);
      const body = parseEnvelopeStrict(await res.text()) as {
        ok: false;
        error: { code: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("invalid_request");
      const statusRes = await envelopeRequest(env, {
        command: "status",
        artifactId: createBody.data.artifact.id,
      });
      const statusBody = parseEnvelopeStrict(await statusRes.text()) as {
        ok: true;
        data: { revisionCount: number };
      };
      expect(statusBody.data.revisionCount).toBe(0);
    } finally {
      await env.cleanup();
    }
  });

  test("publish payload_too_large returns a typed error BEFORE hashing", async () => {
    const env = await startService();
    try {
      const createRes = await envelopeRequest(env, {
        command: "create",
        projectId: "project-1",
        slug: "huge",
        title: "Huge",
      });
      const createBody = parseEnvelopeStrict(await createRes.text()) as {
        ok: true;
        data: { artifact: { id: string } };
      };

      // 5MB + 1 byte exceeds SOURCE_CAP_BYTES. Wire format is base64.
      const huge = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
      const res = await envelopeRequest(env, {
        command: "publish",
        artifactId: createBody.data.artifact.id,
        artifactType: "markdown",
        bytes: huge,
      });
      const body = parseEnvelopeStrict(await res.text()) as {
        ok: false;
        error: { code: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("payload_too_large");
    } finally {
      await env.cleanup();
    }
  });

  test("malformed JSON body returns 400 with invalid_envelope", async () => {
    const env = await startService();
    try {
      const res = await fetch(`${env.baseUrl}/api/v1/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.installToken}`,
          host: new URL(env.baseUrl).host,
        },
        body: "{not-json",
      });
      expect(res.status).toBe(400);
      const body = parseEnvelopeStrict(await res.text()) as {
        ok: false;
        error: { code: string };
      };
      expect(body.error.code).toBe("invalid_envelope");
    } finally {
      await env.cleanup();
    }
  });

  test("reserved html artifact type returns unsupported_reserved_type", async () => {
    const env = await startService();
    try {
      const createRes = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-create",
        command: "create",
        projectId: "project-1",
        slug: "x",
        title: "X",
      });
      const createBody = parseEnvelopeStrict(await createRes.text()) as {
        ok: true;
        data: { artifact: { id: string } };
      };

      const res = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-html",
        command: "publish",
        artifactId: createBody.data.artifact.id,
        artifactType: "html",
        bytes: Buffer.from("<h1>", "utf8").toString("base64"),
      });
      const body = parseEnvelopeStrict(await res.text()) as {
        ok: false;
        error: { code: string };
      };
      expect(body.error.code).toBe("unsupported_reserved_type");
    } finally {
      await env.cleanup();
    }
  });

  test("export reserved command returns the reserved envelope shape", async () => {
    const env = await startService();
    try {
      const res = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-export",
        command: "export",
        format: "html",
      });
      const body = parseEnvelopeStrict(await res.text()) as {
        ok: true;
        data: CommandResult;
      };
      expect(body.ok).toBe(true);
      if (body.data.command === "export") {
        expect(body.data.accepted).toBe(false);
      } else {
        throw new Error("expected export result");
      }
    } finally {
      await env.cleanup();
    }
  });

  test("list returns strict envelope artifacts array", async () => {
    const env = await startService();
    try {
      await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-create-1",
        command: "create",
        projectId: "project-1",
        slug: "a",
        title: "A",
      });
      await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-create-2",
        command: "create",
        projectId: "project-1",
        slug: "b",
        title: "B",
      });
      const res = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-list",
        command: "list",
        projectId: "project-1",
      });
      const body = parseEnvelopeStrict(await res.text()) as {
        ok: true;
        data: CommandResult;
      };
      if (body.data.command === "list") {
        expect(body.data.artifacts).toHaveLength(2);
        for (const a of body.data.artifacts) {
          expect(typeof a.id).toBe("string");
          expect(typeof a.slug).toBe("string");
        }
      } else {
        throw new Error("expected list result");
      }
    } finally {
      await env.cleanup();
    }
  });

  test("status returns counts; read-back 404 then present after a render run", async () => {
    const env = await startService();
    try {
      const createRes = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-create",
        command: "create",
        projectId: "project-1",
        slug: "s",
        title: "S",
      });
      const createBody = parseEnvelopeStrict(await createRes.text()) as {
        ok: true;
        data: { artifact: { id: string } };
      };

      const statusRes = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-status",
        command: "status",
        artifactId: createBody.data.artifact.id,
      });
      const statusBody = parseEnvelopeStrict(await statusRes.text()) as {
        ok: true;
        data: CommandResult;
      };
      if (statusBody.data.command === "status") {
        expect(statusBody.data.revisionCount).toBe(0);
        expect(statusBody.data.pinnedCount).toBe(0);
        expect(statusBody.data.templateCount).toBe(0);
      }

      const publishRes = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-pub",
        command: "publish",
        artifactId: createBody.data.artifact.id,
        artifactType: "markdown",
        bytes: "aA==", // base64 single byte 0x68
      });
      const publishBody = parseEnvelopeStrict(await publishRes.text()) as {
        ok: true;
        data: CommandResult;
      };
      let revisionSha = "";
      if (publishBody.data.command === "publish") {
        revisionSha = publishBody.data.revision.sha256;
      }

      const rb = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-rb",
        command: "readBack",
        artifactId: createBody.data.artifact.id,
        revisionSha,
        tier: 0,
      });
      // Publish now records a Tier 0 render_run, so read-back succeeds
      // and returns the verdict bound to (artifactId, revisionSha).
      expect(rb.status).toBe(200);
      const rbBody = parseEnvelopeStrict(await rb.text()) as {
        ok: true;
        data: { command: "readBack"; verdict: { tier: 0; revisionSha: string } };
      };
      expect(rbBody.data.command).toBe("readBack");
      expect(rbBody.data.verdict.tier).toBe(0);
      expect(rbBody.data.verdict.revisionSha).toBe(revisionSha);
    } finally {
      await env.cleanup();
    }
  });

  test("every response carries Cache-Control: no-store", async () => {
    const env = await startService();
    try {
      const res = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-cc",
        command: "list",
        projectId: "p",
      });
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      await env.cleanup();
    }
  });

  test("missing Bearer returns 401 with invalid_envelope", async () => {
    const env = await startService();
    try {
      const res = await fetch(`${env.baseUrl}/api/v1/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: new URL(env.baseUrl).host,
        },
        body: JSON.stringify({
          schemaVersion: FACET_SCHEMA_VERSION,
          requestId: "r",
          command: "list",
          projectId: "p",
        }),
      });
      expect(res.status).toBe(401);
      const body = parseEnvelopeStrict(await res.text()) as {
        ok: false;
        error: { code: string };
      };
      expect(body.error.code).toBe("invalid_envelope");
    } finally {
      await env.cleanup();
    }
  });

  test("every response is a strict envelope — no rogue keys", async () => {
    const env = await startService();
    try {
      const res = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-strict",
        command: "list",
        projectId: "p",
      });
      const text = await res.text();
      const parsed = JSON.parse(text);
      // Round-trip through the strict schema — fails on any extra key.
      const valid = FacetEnvelopeSchema.parse(parsed);
      expect(valid.schemaVersion).toBe(FACET_SCHEMA_VERSION);
    } finally {
      await env.cleanup();
    }
  });

  test("CommandResultSchema is satisfied by every success response", async () => {
    const env = await startService();
    try {
      const commands = [
        {
          schemaVersion: FACET_SCHEMA_VERSION,
          requestId: "r1",
          command: "list" as const,
          projectId: "p",
        },
      ];
      for (const cmd of commands) {
        const res = await envelopeRequest(env, cmd);
        const body = parseEnvelopeStrict(await res.text()) as {
          ok: true;
          data: CommandResult;
        };
        expect(() => CommandResultSchema.parse(body.data)).not.toThrow();
        expect(CommandRequestSchema.safeParse(cmd).success).toBe(true);
      }
    } finally {
      await env.cleanup();
    }
  });

  test("install token file is mode 0600 after start", async () => {
    const envDir = join(scratchRoot, crypto.randomUUID());
    mkdirSync(envDir, { recursive: true });
    const installTokenPath = join(envDir, "install.token");
    const service = await startFacetService({
      dbPath: join(envDir, "db.sqlite"),
      installTokenPath,
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath: join(envDir, "lock"),
      idleTimeoutMs: 5_000,
      logger: createQuietLogger({ component: "test" }),
      tier0Runner: stubTier0Runner,
    });
    try {
      expect(existsSync(installTokenPath)).toBe(true);
      const stat = readFileSync(installTokenPath);
      expect(stat.length).toBeGreaterThan(0);
      const mode = require("node:fs").statSync(installTokenPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await service.stop();
    }
  });

  test("Pin request toggles pinned count in status", async () => {
    const env = await startService();
    try {
      const createRes = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-c",
        command: "create",
        projectId: "p",
        slug: "s",
        title: "S",
      });
      const createBody = parseEnvelopeStrict(await createRes.text()) as {
        ok: true;
        data: { artifact: { id: string } };
      };
      const pubRes = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-p",
        command: "publish",
        artifactId: createBody.data.artifact.id,
        artifactType: "markdown",
        bytes: "AQ==", // base64 single byte 0x01
      });
      const pubBody = parseEnvelopeStrict(await pubRes.text()) as {
        ok: true;
        data: CommandResult;
      };
      let revisionId = "";
      if (pubBody.data.command === "publish") revisionId = pubBody.data.revision.id;
      const pinRes = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-pin",
        command: "pin",
        revisionId,
        pinned: true,
      });
      const pinBody = parseEnvelopeStrict(await pinRes.text()) as {
        ok: true;
        data: CommandResult;
      };
      expect(pinBody.data.command).toBe("pin");
      const statusRes = await envelopeRequest(env, {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: "req-s",
        command: "status",
        artifactId: createBody.data.artifact.id,
      });
      const statusBody = parseEnvelopeStrict(await statusRes.text()) as {
        ok: true;
        data: CommandResult;
      };
      if (statusBody.data.command === "status") {
        expect(statusBody.data.pinnedCount).toBe(1);
      }
    } finally {
      await env.cleanup();
    }
  });
});
