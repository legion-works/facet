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
 *
 * Test shape — the production Tier 0 runner parses the source for
 * real, then a custom Tier 1 runner applies the production
 * `deriveVerdict` over a synthetic observation sourced from the
 * same lexical. Tier 1 is where the verdict is computed in the real
 * pipeline, so this is where the downgrade lands.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startFacetService, type RunningService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { createTier0Runner } from "../../src/validation/tier0/runner";
import { deriveVerdict } from "../../src/validation/tier1/verdict";
import type {
  Tier1Input,
  Tier1Result,
  Tier0Runner,
  Tier1Runner,
} from "../../src/shared/contracts/validation";
import { CommandResultSchema, type CommandResult } from "../../src/shared/contracts/commands";
import { FACET_SCHEMA_VERSION } from "../../src/shared/contracts/envelope";

const scratchRoot = mkdtempSync(join(tmpdir(), "facet-md-external-"));

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

interface MdEnv {
  service: RunningService;
}

// Custom Tier 1 runner that mirrors the real pipeline's verdict
// derivation: synthesize a protocol observation from the lexical
// expectation (the markdown carries no viewBoxes / visible SVGs)
// and call the production `deriveVerdict` over it. The page-shim
// and isolated-world channels are absent, so the verdict would
// otherwise fall through to `probe_only`; we mirror the protocol
// observation into those stand-ins so the partial branches
// (`external_resources`, `opaque_content`) are reachable without a
// real browser. This stays at the Tier 1 layer where
// `deriveVerdict` is actually invoked in production — keeping the
// Tier 0 stub a stub and the verdict derivation production-
// equivalent.
function markdownTier1Runner(): Tier1Runner {
  return async (input: Tier1Input): Promise<Tier1Result> => {
    const externalImageCount = input.lexical.externalImageCount;
    const protocolObservation = {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      viewBoxes: [],
      errorCount: 0,
      opaqueRegionCount: 0,
      externalImageCount,
      discriminativeErrors: [],
    };
    const status = deriveVerdict(
      input.lexical,
      protocolObservation,
      protocolObservation,
      {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        externalImageCount,
        errorCount: 0,
      },
      { bootReady: true, renderComplete: true },
    );
    return {
      tier: 1,
      status,
      artifactId: input.artifactType,
      revisionSha: input.revisionSha,
      expected: input.lexical,
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        externalImageCount,
        opaqueRegionCount: 0,
        errorCount: 0,
      },
      screenshotPath: null,
      consolePath: null,
      ...(status.startsWith("partial:")
        ? {
            screenshotError: {
              code: "screenshot_unavailable" as const,
              message: "test-fixture: no browser harness",
            },
          }
        : {}),
    };
  };
}

async function startEnv(): Promise<MdEnv> {
  const envDir = join(scratchRoot, crypto.randomUUID());
  // The markdown external-image downgrade IS the property under test,
  // so this suite injects:
  //   - the PRODUCTION Tier 0 runner — the stub would zero the count
  //     and the test would degenerate to a tautology.
  //   - a Tier 1 runner that runs the production `deriveVerdict` over
  //     a synthetic observation sourced from the same lexical the
  //     Tier 0 worker emitted. Tier 0 alone would store status=ok
  //     for a markdown parser pass; the downgrade is applied at the
  //     Tier 1 verdict layer in production.
  const tier0Runner: Tier0Runner = createTier0Runner(0);
  const tier1Runner = markdownTier1Runner();
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 5_000,
    logger: createQuietLogger({ component: "md-external-test" }),
    tier0Runner,
    tier1Runner,
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
      // The Tier 1 verdict is what carries the type-agnostic
      // external_resources partial — Tier 0 alone reports `ok` for
      // a markdown parser pass. Tier 1 runs `deriveVerdict` over
      // the lexical and observation and downgrades here.
      const verdict = await request(service, {
        command: "readBack",
        artifactId,
        revisionSha,
        tier: 1,
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
        tier: 1,
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
        tier: 1,
      });
      if (verdict.command !== "readBack") throw new Error("expected readBack");
      expect(verdict.verdict.status).not.toBe("partial:external_resources");
      expect(verdict.verdict.observed.externalImageCount).toBe(0);
    } finally {
      await service.stop();
    }
  });
});
