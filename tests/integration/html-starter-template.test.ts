/**
 * Acceptance checks for the HTML starter template
 * (`templates/html-status-report.html`).
 *
 * The starter is the discoverable worked example of the shipped HTML
 * vocabulary and the static / script-free contract. This test pins:
 *
 * 1. Tier 0 publishes `ok` for the starter bytes.
 * 2. Every `class=` token on the starter belongs to
 *    `src/shared/html/style-vocabulary.ts` (no undocumented class
 *    silently disables styling).
 * 3. Exported source bytes are byte-identical to the file on disk
 *    (the renderer-owned wrapper never reaches storage or export).
 *
 * The acceptance render pass lives in `tests/acceptance/html-render.test.ts`;
 * this test stays at the Tier 0 + structural boundary so it runs
 * without the browser harness.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "bun:test";

import { parseHtml } from "../../src/validation/tier0/html";
import { HTML_STYLE_CLASSES } from "../../src/shared/html/style-vocabulary";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { CommandResultSchema, type CommandResult } from "../../src/shared/contracts/commands";
import { FACET_SCHEMA_VERSION } from "../../src/shared/contracts/envelope";

const STARTER_PATH = join(import.meta.dir, "..", "..", "templates", "html-status-report.html");

async function request(
  service: Awaited<ReturnType<typeof startFacetService>>,
  command: Record<string, unknown>,
): Promise<Extract<CommandResult, { command: "create" | "publish" | "export" }>> {
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
    data?: { command: "create" | "publish" | "export"; [k: string]: unknown };
    error?: unknown;
  };
  if (!body.ok || body.data === undefined) {
    throw new Error(`request failed: ${JSON.stringify(body.error ?? body)}`);
  }
  return CommandResultSchema.parse(body.data) as Extract<
    CommandResult,
    { command: "create" | "publish" | "export" }
  >;
}

test("starter parses to ok in Tier 0", () => {
  const bytes = new Uint8Array(readFileSync(STARTER_PATH));
  const result = parseHtml(bytes);
  if (result.status !== "ok") {
    throw new Error(
      `Tier 0 rejected the starter template: ${result.errors.map((e) => e.code).join(", ")}`,
    );
  }
  expect(result.status).toBe("ok");
  // The starter exercises headings, a table, and a list — its absence
  // would mean a structural regression in the template itself.
  expect(result.html.headingCount).toBeGreaterThanOrEqual(2);
  expect(result.html.tableCount).toBe(1);
  expect(result.html.listCount).toBeGreaterThanOrEqual(1);
  expect(result.html.rendererRootCount).toBe(1);
});

test("every class token on the starter belongs to the vendored vocabulary", () => {
  const source = readFileSync(STARTER_PATH, "utf8");
  const tokens = new Set<string>();
  const classRegex = /class="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = classRegex.exec(source)) !== null) {
    for (const token of match[1]!.split(/\s+/).filter(Boolean)) {
      tokens.add(token);
    }
  }
  const vocabulary = new Set<string>(HTML_STYLE_CLASSES);
  const unknown = [...tokens].filter((t) => !vocabulary.has(t));
  expect(unknown).toEqual([]);
  // The starter must use at least a handful of vocabulary tokens to
  // be a meaningful worked example. A starter with zero classes would
  // be vacuous.
  expect(tokens.size).toBeGreaterThan(10);
});

test("starter contains no script, event handler, inline style, or external font/media", () => {
  const source = readFileSync(STARTER_PATH, "utf8");
  expect(/<script\b/i.test(source)).toBe(false);
  expect(/<style\b/i.test(source)).toBe(false);
  expect(/\sstyle\s*=/i.test(source)).toBe(false);
  expect(/\son[a-z]+\s*=/i.test(source)).toBe(false);
  expect(/<link\b/i.test(source)).toBe(false);
  expect(/<img\b/i.test(source)).toBe(false);
  expect(/@import|@font-face/i.test(source)).toBe(false);
  expect(/data-facet-/i.test(source)).toBe(false);
});

test("exported source bytes equal the file byte-for-byte through the real pipeline", async () => {
  // The HTML renderer wraps sanitized body content in a frame-owned
  // element carrying `data-facet-renderer-root`. That wrapper never
  // touches storage or export — exported bytes are exactly the bytes
  // the operator published. This is the byte-identity contract from
  // D13 of the HTML design.
  //
  // The previous incarnation of this test only proved that UTF-8
  // decode∘encode is the identity on valid UTF-8 — no service, no
  // publish path, no export command, no renderer. It accepted without
  // comment even after the export pipeline was gutted. This rewrite
  // routes through `request(service, …)` so the byte-identity claim
  // is anchored to the real wire path, not a string-roundtrip in
  // test code.
  const fileBytes = new Uint8Array(readFileSync(STARTER_PATH));
  const envDir = mkdtempSync(join(tmpdir(), "facet-starter-template-"));
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 5_000,
    logger: createQuietLogger({ component: "starter-template-test" }),
    tier0Runner: stubTier0Runner,
  });
  try {
    const createBody = await request(service, {
      command: "create",
      projectId: "starter-template-project",
      slug: "html-status-report",
      title: "HTML status report",
    });
    if (createBody.command !== "create") throw new Error("expected create");
    const artifactId = createBody.artifact.id;
    const publishBody = await request(service, {
      command: "publish",
      artifactId,
      artifactType: "html",
      bytes: Buffer.from(fileBytes).toString("base64"),
    });
    if (publishBody.command !== "publish") throw new Error("expected publish");
    const revisionSha = publishBody.revision.sha256;
    const exportBody = await request(service, {
      command: "export",
      artifactId,
      revisionSha,
      format: "source",
    });
    if (exportBody.command !== "export") throw new Error("expected export");
    const exportedBytes = Buffer.from(exportBody.bytes, "base64");
    expect(new Uint8Array(exportedBytes)).toEqual(fileBytes);
    expect(exportBody.sidecar.revisionSha).toBe(revisionSha);
    // Re-issuing export without a revisionSha must select the same
    // (latest) revision and still match byte-for-byte.
    const latest = await request(service, {
      command: "export",
      artifactId,
      format: "source",
    });
    if (latest.command !== "export") throw new Error("expected export");
    expect(Buffer.from(latest.bytes, "base64")).toEqual(Buffer.from(fileBytes));
  } finally {
    await service.stop();
    rmSync(envDir, { recursive: true, force: true });
  }
});
