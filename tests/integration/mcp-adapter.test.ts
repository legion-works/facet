import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { FACET_VERSION } from "../../src/shared/version";
import {
  CreateToolSchema,
  ExportToolSchema,
  OpenUrlToolSchema,
  PublishToolSchema,
  PublishToolShape,
  ReadBackToolSchema,
  StatusToolSchema,
} from "../../src/harness-adapters/mcp/tool-schemas";

const ROOT = resolve(import.meta.dir, "../..");
const MCP_ENTRY = join(ROOT, "src/harness-adapters/mcp/main.ts");
const CLI_ENTRY = join(ROOT, "src/cli/main.ts");
const scratchRoot = join(import.meta.dir, ".mcp-adapter-scratch");
const homes: string[] = [];

beforeEach(() => mkdirSync(scratchRoot, { recursive: true }));

afterEach(() => {
  for (const home of homes.splice(0)) {
    const metadataPath = join(home, "metadata.json");
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid?: number };
      if (metadata.pid !== undefined) {
        try {
          process.kill(metadata.pid, "SIGTERM");
        } catch {
          // The service may already have stopped before test cleanup.
        }
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
});

function newHome(): string {
  const home = join(scratchRoot, crypto.randomUUID());
  mkdirSync(home, { recursive: true });
  homes.push(home);
  return home;
}

async function connect(home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    cwd: ROOT,
    env: { ...process.env, FACET_HOME: home },
  });
  const client = new Client({ name: "facet-mcp-integration", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function textContent(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !Array.isArray((result as { content?: unknown }).content)
  ) {
    throw new Error("MCP tool result did not contain content");
  }
  const first = (result as { content: readonly unknown[] }).content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    (first as { type?: unknown }).type !== "text" ||
    typeof (first as { text?: unknown }).text !== "string"
  ) {
    throw new Error("MCP tool result did not contain text content");
  }
  return (first as { text: string }).text;
}

async function createArtifact(home: string): Promise<string> {
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI_ENTRY,
      "create",
      "--project-id",
      "mcp",
      "--slug",
      "inline",
      "--title",
      "Inline",
    ],
    {
      cwd: ROOT,
      env: { ...process.env, FACET_HOME: home },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  expect(exitCode).toBe(0);
  const envelope = JSON.parse(stdout) as { ok: boolean; data?: { artifact?: { id?: string } } };
  expect(envelope.ok).toBe(true);
  const artifactId = envelope.data?.artifact?.id;
  if (artifactId === undefined) throw new Error("create did not return an artifact id");
  return artifactId;
}

describe("facet MCP adapter", () => {
  test("lists the six tools with inputs derived from their validation schemas", async () => {
    const home = newHome();
    const client = await connect(home);
    try {
      const tools = await client.listTools();
      expect(client.getServerVersion()).toEqual({ name: "facet", version: FACET_VERSION });
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "facet_create",
        "facet_export",
        "facet_open_url",
        "facet_publish",
        "facet_read_back",
        "facet_status",
      ]);
      const schemas = {
        facet_create: CreateToolSchema,
        facet_export: ExportToolSchema,
        facet_open_url: OpenUrlToolSchema,
        facet_publish: PublishToolSchema,
        facet_read_back: ReadBackToolSchema,
        facet_status: StatusToolSchema,
      };
      for (const tool of tools.tools) {
        const schema = schemas[tool.name as keyof typeof schemas];
        expect(schema).toBeDefined();
        expect(tool.inputSchema as unknown).toEqual(
          toJsonSchemaCompat(schema!, { pipeStrategy: "input" }),
        );
      }

      // Descriptions carry workflow boundaries because MCP clients may only load the tool list.
      // Presence test: it pins the wording a model reads, not how a model acts on it.
      const descriptions = Object.fromEntries(
        tools.tools.map((tool) => [tool.name, tool.description]),
      );
      expect(descriptions.facet_publish).toContain("Tier 0");
      expect(descriptions.facet_publish).toMatch(/not rendered|nothing rendered/i);
      expect(descriptions.facet_publish).toContain('tier: "visual"');
      expect(descriptions.facet_publish).toContain("envelope.ok");
      expect(descriptions.facet_read_back).toContain("interaction");
      expect(descriptions.facet_read_back).toContain("envelope.ok");

      const result = await client.callTool({ name: "facet_status", arguments: { start: true } });
      expect(result.isError).not.toBe(true);
      const envelope = JSON.parse(textContent(result)) as {
        ok: boolean;
        data?: { command?: string };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.command).toBe("status");
    } finally {
      await client.close();
    }
  });

  test("creates, publishes, reads back, and exports using MCP alone from a cold home", async () => {
    const home = newHome();
    const outDir = join(home, "mcp-export");
    const client = await connect(home);
    try {
      const created = await client.callTool({
        name: "facet_create",
        arguments: { projectId: "mcp", slug: "cold", title: "Cold MCP" },
      });
      expect(created.isError).not.toBe(true);
      const createEnvelope = JSON.parse(textContent(created)) as {
        ok: boolean;
        data?: { artifact?: { id?: string } };
      };
      expect(createEnvelope.ok).toBe(true);
      const artifactId = createEnvelope.data?.artifact?.id;
      expect(artifactId).toBeString();
      if (!artifactId) throw new Error("MCP create returned no artifact id");

      const published = await client.callTool({
        name: "facet_publish",
        arguments: { artifactId, type: "markdown", sourceText: "# Cold MCP source\n" },
      });
      expect(published.isError).not.toBe(true);
      const publishEnvelope = JSON.parse(textContent(published)) as {
        ok: boolean;
        data?: { revision?: { sha256?: string } };
      };
      expect(publishEnvelope.ok).toBe(true);
      const revisionSha = publishEnvelope.data?.revision?.sha256;
      expect(revisionSha).toBeString();

      const readBack = await client.callTool({
        name: "facet_read_back",
        arguments: { artifactId, revisionSha, tier: 0 },
      });
      expect(readBack.isError).not.toBe(true);
      const readEnvelope = JSON.parse(textContent(readBack)) as {
        ok: boolean;
        data?: { verdict?: { artifactId?: string; revisionSha?: string; tier?: number } };
      };
      expect(readEnvelope.ok).toBe(true);
      expect(readEnvelope.data?.verdict).toMatchObject({ artifactId, revisionSha, tier: 0 });

      const exported = await client.callTool({
        name: "facet_export",
        arguments: { artifactId, revisionSha, format: "source", outDir },
      });
      expect(exported.isError).not.toBe(true);
      expect(JSON.parse(textContent(exported))).toMatchObject({ ok: true });
      const sourceFiles = readdirSync(outDir).filter((name) => /^cold-[a-f0-9]{7}\.md$/.test(name));
      expect(sourceFiles).toHaveLength(1);
      expect(readFileSync(join(outDir, sourceFiles[0]!), "utf8")).toBe("# Cold MCP source\n");
    } finally {
      await client.close();
    }
  });

  test("classifies an unwritable export directory as output_unwritable", async () => {
    const home = newHome();
    const locked = join(home, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    const client = await connect(home);
    try {
      const result = await client.callTool({
        name: "facet_export",
        arguments: { artifactId: "missing-artifact", outDir: join(locked, "export") },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(textContent(result))).toMatchObject({
        ok: false,
        error: { code: "output_unwritable", retryable: false },
      });
    } finally {
      chmodSync(locked, 0o700);
      await client.close();
    }
  });

  test("reports the resolved directory when relative MCP export output cannot be created", async () => {
    const home = newHome();
    const blocked = join(home, "missing-export");
    const outDir = relative(ROOT, join(blocked, "export"));
    mkdirSync(blocked, { recursive: true });
    chmodSync(blocked, 0o500);
    const client = await connect(home);
    try {
      const result = await client.callTool({
        name: "facet_export",
        arguments: { artifactId: "missing-artifact", outDir },
      });
      expect(result.isError).toBe(true);
      const envelope = JSON.parse(textContent(result)) as {
        error?: { code?: string; details?: { out?: string } };
      };
      expect(envelope.error?.code).toBe("output_unwritable");
      expect(isAbsolute(envelope.error?.details?.out ?? "")).toBe(true);
      expect(envelope.error?.details?.out).toBe(resolve(ROOT, outDir));
    } finally {
      chmodSync(blocked, 0o700);
      await client.close();
    }
  });

  test("documents and enforces exactly one inline or file publish source", async () => {
    const home = newHome();
    const artifactId = await createArtifact(home);
    const client = await connect(home);
    try {
      await client.listTools();
      expect(Object.keys(PublishToolShape).toSorted()).toContain("sourceText");
      expect(Object.keys(PublishToolShape).toSorted()).toContain("file");
      expect(readFileSync(join(ROOT, "docs/reference/mcp.md"), "utf8")).toContain(
        "Exactly one of `sourceText` or `file` is required.",
      );

      for (const input of [
        { artifactId, type: "markdown" },
        { artifactId, type: "markdown", sourceText: "# inline", file: "/tmp/source.md" },
      ]) {
        const result = await client.callTool({ name: "facet_publish", arguments: input });
        expect(result.isError).toBe(true);
        const envelope = JSON.parse(textContent(result)) as {
          ok: boolean;
          error?: { code?: string };
        };
        expect(envelope).toMatchObject({ ok: false, error: { code: "invalid_request" } });
      }
    } finally {
      await client.close();
    }
  });

  test("publishes inline markdown and returns its verdict envelope", async () => {
    const home = newHome();
    const artifactId = await createArtifact(home);
    const client = await connect(home);
    try {
      const result = await client.callTool({
        name: "facet_publish",
        arguments: { artifactId, type: "markdown", sourceText: "# MCP inline source" },
      });
      expect(result.isError).not.toBe(true);
      const envelope = JSON.parse(textContent(result)) as {
        ok: boolean;
        data?: { verdict?: { status?: string } };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.verdict?.status).toBeDefined();
    } finally {
      await client.close();
    }
  });

  test("relays a malformed Mermaid fence as a stored Tier 0 verdict, not a tool error", async () => {
    const home = newHome();
    const client = await connect(home);
    try {
      const created = await client.callTool({
        name: "facet_create",
        arguments: { projectId: "mcp", slug: "bad-mermaid", title: "Bad Mermaid" },
      });
      const artifactId = (
        JSON.parse(textContent(created)) as {
          data?: { artifact?: { id?: string } };
        }
      ).data?.artifact?.id;
      expect(artifactId).toBeString();
      const result = await client.callTool({
        name: "facet_publish",
        arguments: {
          artifactId,
          type: "markdown",
          sourceText: "# Diagram\n\n```mermaid\nnot a diagram %%%\n```\n",
        },
      });
      expect(result.isError).toBe(false);
      expect(JSON.parse(textContent(result))).toMatchObject({
        ok: true,
        data: {
          verdict: {
            status: "error",
            observed: {
              discriminativeErrors: [{ code: "mermaid_parse_error", location: "mermaid fence 0" }],
            },
          },
        },
      });
    } finally {
      await client.close();
    }
  });

  test("every registered tool rejects extra arguments with a typed invalid_request", async () => {
    const home = newHome();
    const client = await connect(home);
    try {
      const tools = await client.listTools();
      const minimalByTool: Record<string, Record<string, unknown>> = {
        facet_create: { projectId: "mcp", slug: "extra", title: "Extra" },
        facet_export: { artifactId: "missing-artifact", outDir: home },
        facet_open_url: { artifactId: "missing-artifact" },
        facet_publish: {
          artifactId: "missing-artifact",
          type: "markdown",
          sourceText: "# Extra",
        },
        facet_read_back: { artifactId: "missing-artifact" },
        facet_status: {},
      };
      expect(Object.keys(minimalByTool).toSorted()).toEqual(
        tools.tools.map((tool) => tool.name).toSorted(),
      );
      for (const tool of tools.tools) {
        const result = await client.callTool({
          name: tool.name,
          arguments: { ...minimalByTool[tool.name], extraField: 1 },
        });
        expect(result.isError, tool.name).toBe(true);
        expect(JSON.parse(textContent(result)), tool.name).toMatchObject({
          ok: false,
          error: { code: "invalid_request", retryable: false },
        });
      }
    } finally {
      await client.close();
    }
  });

  test("maps typed Facet publish failures to MCP tool errors", async () => {
    const home = newHome();
    const client = await connect(home);
    try {
      const result = await client.callTool({
        name: "facet_publish",
        arguments: {
          artifactId: "missing-artifact",
          type: "markdown",
          sourceText: "# Missing artifact",
        },
      });
      expect(result.isError).toBe(true);
      const envelope = JSON.parse(textContent(result)) as {
        ok: boolean;
        error?: { code?: string; message?: string; retryable?: boolean; details?: unknown };
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.error).toMatchObject({
        code: "artifact_not_found",
        retryable: false,
      });
      expect(envelope.error?.message).toBeString();
    } finally {
      await client.close();
    }
  });

  test("maps schema-invalid publish inputs to typed MCP errors", async () => {
    const home = newHome();
    const client = await connect(home);
    try {
      for (const invalidInput of [
        { artifactId: "missing-artifact", type: "not-a-type", sourceText: "# Invalid type" },
        { artifactId: 42, type: "markdown", sourceText: "# Invalid artifact id" },
        {
          artifactId: "missing-artifact",
          type: "markdown",
          sourceText: "# Valid",
          extraField: true,
        },
      ]) {
        const result = await client.callTool({ name: "facet_publish", arguments: invalidInput });
        expect(result.isError).toBe(true);
        const envelope = JSON.parse(textContent(result)) as {
          ok: boolean;
          error?: { code?: string; message?: string; retryable?: boolean; details?: unknown };
        };
        expect(envelope.ok).toBe(false);
        expect(envelope.error).toMatchObject({ code: "invalid_request", retryable: false });
        expect(envelope.error?.message).toBeString();
      }
    } finally {
      await client.close();
    }
  });
});
