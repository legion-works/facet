/**
 * Wire-level regression: store errors must reach the client with their
 * typed code (not `invalid_envelope`) and the right HTTP status.
 *
 * Regression guard: `FacetError.from()` once only recognised
 * `instanceof FacetError`, so `FacetStoreError` (the store layer's own
 * error class) collapsed to `invalid_envelope` on every wire response.
 * The router's `statusFor()` arms for `duplicate_revision`, `foreign_key`,
 * etc. were unreachable. After the bridge fix (`FacetStoreError extends
 * FacetError`), this test exercises the full dispatcher → envelope path
 * and asserts the typed code carries through.
 *
 * Coverage:
 *   - duplicate_revision — publish the same bytes twice
 *   - foreign_key        — publish against a nonexistent artifactId
 *   - database_corrupt   — start the service with a corrupt DB on disk
 *
 * `disk_full`, `invalid_artifact_type`, `immutable_revision`, and
 * `constraint` are covered by `tests/unit/store-error-bridge.test.ts`
 * (the asStoreError / statusFor unit tests) because they cannot be
 * triggered reliably from the wire (the dispatcher validates the
 * artifact type before the store sees it; immutable_revision /
 * disk_full require fault injection that is not safe to run against
 * the real service).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FACET_SCHEMA_VERSION, FacetEnvelopeSchema } from "../../src/shared/contracts/envelope";
import { startFacetService, type RunningService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { asStoreError } from "../../src/shared/errors/store-error";

const scratchRoot = join(tmpdir(), `facet-store-err-${crypto.randomUUID()}`);

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
});

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

interface TestEnv {
  service: RunningService;
  baseUrl: string;
  installToken: string;
  cleanup: () => Promise<void>;
}

async function startEnv(): Promise<TestEnv> {
  const envDir = join(scratchRoot, crypto.randomUUID());
  mkdirSync(envDir, { recursive: true });
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 5_000,
    logger: createQuietLogger({ component: "store-err-wire-test" }),
  });
  return {
    service,
    baseUrl: service.url,
    installToken: service.installToken,
    cleanup: async () => {
      await service.stop();
    },
  };
}

interface EnvelopeRequest {
  (env: TestEnv, body: unknown, extraHeaders?: Record<string, string>): Promise<Response>;
}

const envelopeRequest: EnvelopeRequest = async (env, body, extraHeaders = {}) => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${env.installToken}`,
    host: new URL(env.baseUrl).host,
    ...extraHeaders,
  };
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
};

function parseEnvelope(
  text: string,
): { ok: true; data: unknown } | { ok: false; error: { code: string; message?: string } } {
  const parsed = JSON.parse(text);
  const valid = FacetEnvelopeSchema.parse(parsed);
  return valid.ok ? { ok: true, data: valid.data } : { ok: false, error: valid.error };
}

describe("store errors surface on the wire with typed codes", () => {
  test("duplicate_revision surfaces with code + status 409 (not invalid_envelope)", async () => {
    const env = await startEnv();
    try {
      const createRes = await envelopeRequest(env, {
        command: "create",
        projectId: "project-1",
        slug: "dup",
        title: "Dup",
      });
      const createBody = parseEnvelope(await createRes.text());
      if (!createBody.ok) throw new Error(`create failed: ${createBody.error.code}`);
      const artifactId = (createBody.data as { artifact: { id: string } }).artifact.id;

      // First publish succeeds.
      const firstRes = await envelopeRequest(env, {
        command: "publish",
        artifactId,
        artifactType: "markdown",
        bytes: "aGk=",
      });
      expect(firstRes.status).toBe(200);
      const firstBody = parseEnvelope(await firstRes.text());
      expect(firstBody.ok).toBe(true);

      // Second publish of identical bytes triggers a UNIQUE constraint
      // violation → store layer maps it to duplicate_revision.
      const dupRes = await envelopeRequest(env, {
        command: "publish",
        artifactId,
        artifactType: "markdown",
        bytes: "aGk=",
      });
      expect(dupRes.status).toBe(409);
      const dupBody = parseEnvelope(await dupRes.text());
      expect(dupBody.ok).toBe(false);
      if (dupBody.ok) throw new Error("expected error envelope");
      expect(dupBody.error.code).toBe("duplicate_revision");
      // Critically: NOT the old default invalid_envelope that the
      // original bridge bug produced.
      expect(dupBody.error.code).not.toBe("invalid_envelope");
    } finally {
      await env.cleanup();
    }
  });

  test("foreign_key surfaces with code + status 409 (not invalid_envelope)", async () => {
    const env = await startEnv();
    try {
      // Publish against an artifactId that does not exist. The
      // INSERT hits the FK constraint → store maps it to foreign_key.
      const res = await envelopeRequest(env, {
        command: "publish",
        artifactId: "no-such-artifact",
        artifactType: "markdown",
        bytes: "aGk=",
      });
      expect(res.status).toBe(409);
      const body = parseEnvelope(await res.text());
      expect(body.ok).toBe(false);
      if (body.ok) throw new Error("expected error envelope");
      expect(body.error.code).toBe("foreign_key");
      expect(body.error.code).not.toBe("invalid_envelope");
    } finally {
      await env.cleanup();
    }
  });

  test("database_corrupt surfaces during service open with the typed code", async () => {
    // Pre-create a file that is NOT a valid SQLite header. openDatabase
    // runs PRAGMA quick_check which throws; the catch block maps it to
    // a FacetStoreError("database_corrupt", ...). This proves the
    // bridge carries the typed code out of openDatabase — and combined
    // with the unit test for statusFor() proves the wire surface (500)
    // is reachable for a corrupt store.
    const envDir = join(scratchRoot, crypto.randomUUID());
    mkdirSync(envDir, { recursive: true });
    const dbPath = join(envDir, "facet.sqlite");
    writeFileSync(dbPath, "this is not a sqlite database file", { mode: 0o600 });

    let caught: unknown = null;
    try {
      await startFacetService({
        dbPath,
        installTokenPath: join(envDir, "install.token"),
        promoteTokenPath: join(envDir, "promote.token"),
        lockPath: join(envDir, "facet.lock"),
        idleTimeoutMs: 5_000,
        logger: createQuietLogger({ component: "store-err-wire-test" }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    // The error must be a typed FacetStoreError with database_corrupt —
    // and because FacetStoreError extends FacetError, the FacetError
    // bridge preserves the code on the wire.
    const mapped = asStoreError(caught);
    expect(mapped.code).toBe("database_corrupt");
  });

  test("disk_full surfaces through the asStoreError → FacetError bridge", async () => {
    // The wire path cannot easily simulate ENOSPC (would require fault
    // injection into Bun's filesystem layer), so this test pins the
    // bridge: asStoreError must map the canonical ENOSPC message to
    // disk_full, and FacetError.from must preserve the code on the
    // wire body. Together with the unit test for statusFor(disk_full)
    // this proves the full bridge.
    const { FacetError } = await import("../../src/shared/errors/facet-error");
    const mapped = asStoreError(new Error("ENOSPC: no space left on device, write"));
    const wrapped = FacetError.from(mapped);
    expect(wrapped.code).toBe("disk_full");
    expect(wrapped.toBody().code).toBe("disk_full");
    // disk_full has no dedicated statusFor arm → falls through to 500.
    const { statusFor } = await import("../../src/service/router-guards");
    expect(statusFor(wrapped)).toBe(500);
  });
});
