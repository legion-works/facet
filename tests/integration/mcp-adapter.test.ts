import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { FACET_VERSION } from "../../src/shared/version";
import { PublishToolShape } from "../../src/harness-adapters/mcp/tool-schemas";

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
  test("lists the five stable tools and starts Facet status", async () => {
    const home = newHome();
    const client = await connect(home);
    try {
      const tools = await client.listTools();
      expect(client.getServerVersion()).toEqual({ name: "facet", version: FACET_VERSION });
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "facet_export",
        "facet_open_url",
        "facet_publish",
        "facet_read_back",
        "facet_status",
      ]);

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
