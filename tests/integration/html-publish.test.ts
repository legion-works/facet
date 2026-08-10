import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { FACET_SCHEMA_VERSION } from "../../src/shared/contracts/envelope";
import type {
  HtmlStructureCounts,
  Tier0Runner,
  Tier1Input,
  Tier1Result,
} from "../../src/shared/contracts/validation";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { startFacetService, type RunningService } from "../../src/service/server";

const roots: string[] = [];
const htmlPrediction: HtmlStructureCounts = {
  rendererRootCount: 1,
  headingCount: 1,
  tableCount: 0,
  listCount: 0,
  imageCount: 1,
  canvasCount: 0,
  externalImageCount: 1,
};

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function envelope(data: object) {
  const requestId = crypto.randomUUID();
  return {
    schemaVersion: FACET_SCHEMA_VERSION,
    requestId,
    ok: true as const,
    data: { requestId, ...data },
  };
}

async function request(service: RunningService, body: object): Promise<any> {
  const response = await fetch(`${service.url}/api/v1/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${service.installToken}`,
      "content-type": "application/json",
      host: new URL(service.url).host,
    },
    body: JSON.stringify(envelope(body)),
  });
  return response.json();
}

async function startHtmlService(input: {
  readonly tier0Runner: Tier0Runner;
  readonly tier1Runner?: (input: Tier1Input) => Promise<Tier1Result>;
}): Promise<{ service: RunningService; dbPath: string }> {
  const root = join(tmpdir(), `facet-html-publish-${crypto.randomUUID()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const dbPath = join(root, "facet.sqlite");
  const service = await startFacetService({
    dbPath,
    installTokenPath: join(root, "install.token"),
    promoteTokenPath: join(root, "promote.token"),
    lockPath: join(root, "facet.lock"),
    idleTimeoutMs: 5_000,
    logger: createQuietLogger({ component: "html-publish-test" }),
    tier0Runner: input.tier0Runner,
    ...(input.tier1Runner === undefined ? {} : { tier1Runner: input.tier1Runner }),
  });
  return { service, dbPath };
}

function observed(html: HtmlStructureCounts, errorCount = 0) {
  return {
    rendererRootSvgCount: 0,
    graphCount: 0,
    mermaidNodeCount: 0,
    visibleSvgCount: 0,
    opaqueRegionCount: html.canvasCount,
    externalImageCount: html.externalImageCount,
    html,
    errorCount,
  };
}

async function createArtifact(service: RunningService): Promise<string> {
  const result = await request(service, {
    command: "create",
    projectId: "html-project",
    slug: "html-artifact",
    title: "HTML artifact",
  });
  return result.data.artifact.id;
}

describe("HTML publish prediction boundary", () => {
  test("stores the worker HTML prediction and passes it unchanged to Tier 1", async () => {
    const tier1Inputs: Tier1Input[] = [];
    const { service, dbPath } = await startHtmlService({
      tier0Runner: async (input) => ({
        tier: 0,
        status: "ok",
        revisionSha: input.revisionSha,
        expected: { ...input.lexical, html: htmlPrediction },
        observed: observed(htmlPrediction),
      }),
      tier1Runner: async (input) => {
        tier1Inputs.push(input);
        return {
          tier: 1,
          status: "ok",
          artifactId: "",
          revisionSha: input.revisionSha,
          expected: input.lexical,
          observed: observed(input.lexical.html!),
          screenshotPath: null,
          consolePath: null,
        };
      },
    });
    try {
      const source = '<h1>HTML</h1><img src="https://cdn.example/image.png">';
      const artifactId = await createArtifact(service);
      const published = await request(service, {
        command: "publish",
        artifactId,
        artifactType: "html",
        bytes: Buffer.from(source).toString("base64"),
      });

      expect(published.data.revision.artifactType).toBe("html");
      expect(tier1Inputs[0]?.lexical.html).toEqual(htmlPrediction);
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .query(
            "SELECT expected_json FROM render_runs WHERE tier = 0 ORDER BY finished_at DESC LIMIT 1",
          )
          .get() as { expected_json: string };
        expect(JSON.parse(row.expected_json).html).toEqual(htmlPrediction);
      } finally {
        db.close();
      }
      const exported = await request(service, {
        command: "export",
        artifactId,
        revisionSha: published.data.revision.sha256,
        format: "source",
      });
      expect(Buffer.from(exported.data.bytes, "base64").toString("utf8")).toBe(source);
    } finally {
      await service.stop();
    }
  });

  test("records denied HTML as an error while retaining its immutable source", async () => {
    const { service, dbPath } = await startHtmlService({
      tier0Runner: async (input) => ({
        tier: 0,
        status: "error",
        revisionSha: input.revisionSha,
        expected: { ...input.lexical, html: htmlPrediction },
        observed: {
          ...observed(htmlPrediction, 1),
          discriminativeErrors: [
            { code: "html_denied_element", message: "HTML contains a denied <script> element" },
          ],
        },
      }),
    });
    try {
      const source = "<script>blocked</script>";
      const artifactId = await createArtifact(service);
      const published = await request(service, {
        command: "publish",
        artifactId,
        artifactType: "html",
        bytes: Buffer.from(source).toString("base64"),
      });
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .query(
            "SELECT status, observed_json FROM render_runs WHERE tier = 0 ORDER BY finished_at DESC LIMIT 1",
          )
          .get() as { status: string; observed_json: string };
        expect(row.status).toBe("error");
        expect(JSON.parse(row.observed_json).discriminativeErrors[0].code).toBe(
          "html_denied_element",
        );
      } finally {
        db.close();
      }
      const exported = await request(service, {
        command: "export",
        artifactId,
        revisionSha: published.data.revision.sha256,
        format: "source",
      });
      expect(Buffer.from(exported.data.bytes, "base64").toString("utf8")).toBe(source);
    } finally {
      await service.stop();
    }
  });

  test("keeps markdown expected JSON byte-identical without an HTML key", async () => {
    const { service, dbPath } = await startHtmlService({
      tier0Runner: async (input) => ({
        tier: 0,
        status: "ok",
        revisionSha: input.revisionSha,
        expected: input.lexical,
        observed: {
          rendererRootSvgCount: input.lexical.rendererRootSvgCount,
          graphCount: 0,
          mermaidNodeCount: input.lexical.mermaidNodeCount,
          visibleSvgCount: 0,
          opaqueRegionCount: input.lexical.opaqueRegionCount,
          externalImageCount: input.lexical.externalImageCount,
          errorCount: 0,
        },
      }),
    });
    try {
      const artifactId = await createArtifact(service);
      await request(service, {
        command: "publish",
        artifactId,
        artifactType: "markdown",
        bytes: Buffer.from("# Markdown").toString("base64"),
      });
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .query(
            "SELECT expected_json FROM render_runs WHERE tier = 0 ORDER BY finished_at DESC LIMIT 1",
          )
          .get() as { expected_json: string };
        expect(row.expected_json).toBe(
          '{"rendererRootSvgCount":0,"mermaidNodeCount":0,"visibleSvgCount":0,"opaqueRegionCount":0,"externalImageCount":0}',
        );
      } finally {
        db.close();
      }
    } finally {
      await service.stop();
    }
  });
});
