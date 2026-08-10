/**
 * End-to-end proof that markdown external-image disclosure is symmetric
 * with HTML — a markdown artifact carrying a native `![](https://…)`
 * image verdicts `partial:external_resources`, the same partial status
 * an HTML artifact gets for the same property.
 *
 * Why this exists as its own test: before the fix, the verdict's
 * `externalImageCount` check read `protocolObservation.html?.externalImageCount`
 * (HTML-shaped subfield). Markdown's verdict had no html subfield, so
 * the partial status was unreachable — the artifact loaded its https
 * image at display time and the verdict said `ok`.
 *
 * Two companion cases pin the no-false-downgrade side: a markdown
 * artifact with a `data:` image still verdicts `ok`, and a markdown
 * artifact with no image at all still verdicts `ok`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startFacetService, type RunningService } from "../../src/service/server";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { CommandResultSchema, type CommandResult } from "../../src/shared/contracts/commands";
import { FACET_SCHEMA_VERSION } from "../../src/shared/contracts/envelope";

const scratchRoot = mkdtempSync(join(tmpdir(), "facet-md-external-"));

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

interface MdEnv {
  service: RunningService;
}

async function startEnv(): Promise<MdEnv> {
  const envDir = join(scratchRoot, crypto.randomUUID());
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 5_000,
    logger: createQuietLogger({ component: "md-external-test" }),
    tier0Runner: stubTier0Runner,
  });
  return { service };
}

async function request(
  service: RunningService,
  command: Record<string, unknown>,
): Promise<Extract<CommandResult, { command: "create" | "publish" | "readBack" }>> {
  const requestId = `req-${crypto.randomUUID()}`;
  const response = await fetch(`${service.url}/api/v1/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${service.installToken}`,
      "content-type": "application/json",
      host: new URL(service.url).host,
    },
    body: JSON.stringify({
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId,
      ok: true,
      data: { requestId, ...command },
    }),
  });
  const body = (await response.json()) as {
    ok: boolean;
    data?: { command: "create" | "publish" | "readBack"; [k: string]: unknown };
    error?: unknown;
  };
  if (!body.ok || body.data === undefined) {
    throw new Error(`request failed: ${JSON.stringify(body.error ?? body)}`);
  }
  return CommandResultSchema.parse(body.data) as Extract<
    CommandResult,
    { command: "create" | "publish" | "readBack" }
  >;
}

async function publishMarkdown(
  service: RunningService,
  source: string,
  slug: string,
): Promise<{ artifactId: string; revisionSha: string }> {
  const createBody = await request(service, {
    command: "create",
    projectId: "md-external-project",
    slug,
    title: slug,
  });
  if (createBody.command !== "create") throw new Error("expected create");
  const artifactId = createBody.artifact.id;
  const publishBody = await request(service, {
    command: "publish",
    artifactId,
    artifactType: "markdown",
    bytes: Buffer.from(source, "utf8").toString("base64"),
  });
  if (publishBody.command !== "publish") throw new Error("expected publish");
  return { artifactId, revisionSha: publishBody.revision.sha256 };
}

describe("markdown external-image disclosure is type-agnostic", () => {
  test("markdown with a native `![](https://…)` image verdicts partial:external_resources", async () => {
    const { service } = await startEnv();
    try {
      const source = "# Report\n\n![beacon](https://example.com/x.png)\n";
      const { artifactId, revisionSha } = await publishMarkdown(
        service,
        source,
        "external-image-downgrade",
      );
      const verdict = await request(service, {
        command: "readBack",
        artifactId,
        revisionSha,
        tier: 0,
      });
      if (verdict.command !== "readBack") throw new Error("expected readBack");
      expect(verdict.verdict.status).toBe("partial:external_resources");
      expect(verdict.verdict.observed.externalImageCount).toBe(1);
    } finally {
      await service.stop();
    }
  });

  test("markdown with a `data:` image does NOT downgrade to partial:external_resources", async () => {
    const { service } = await startEnv();
    try {
      const source = "# Report\n\n![inline](data:image/png;base64,AAA)\n";
      const { artifactId, revisionSha } = await publishMarkdown(
        service,
        source,
        "data-image-no-downgrade",
      );
      const verdict = await request(service, {
        command: "readBack",
        artifactId,
        revisionSha,
        tier: 0,
      });
      if (verdict.command !== "readBack") throw new Error("expected readBack");
      expect(verdict.verdict.status).not.toBe("partial:external_resources");
      expect(verdict.verdict.observed.externalImageCount).toBe(0);
    } finally {
      await service.stop();
    }
  });

  test("markdown with no image at all does NOT downgrade to partial:external_resources", async () => {
    const { service } = await startEnv();
    try {
      const source = "# Title\n\nJust a paragraph with no images.\n";
      const { artifactId, revisionSha } = await publishMarkdown(
        service,
        source,
        "no-image-no-downgrade",
      );
      const verdict = await request(service, {
        command: "readBack",
        artifactId,
        revisionSha,
        tier: 0,
      });
      if (verdict.command !== "readBack") throw new Error("expected readBack");
      expect(verdict.verdict.status).not.toBe("partial:external_resources");
      expect(verdict.verdict.observed.externalImageCount).toBe(0);
    } finally {
      await service.stop();
    }
  });
});
