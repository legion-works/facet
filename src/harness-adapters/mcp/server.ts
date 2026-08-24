import { mkdirSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodError } from "zod";

import { buildFacetArgs, FacetBridgeError, invokeFacet } from "./cli-bridge";
import {
  ExportToolSchema,
  OpenUrlToolSchema,
  PublishToolSchema,
  type PublishToolInput,
  ReadBackToolSchema,
  StatusToolSchema,
} from "./tool-schemas";
import { errEnvelope, type FacetEnvelope } from "../../shared/contracts/envelope";

function requestId(): string {
  return `req-mcp-${crypto.randomUUID()}`;
}

function errorEnvelope(cause: unknown): FacetEnvelope<never> {
  if (cause instanceof ZodError) {
    const issue = cause.issues[0];
    const field = issue?.path.join(".") || "arguments";
    return errEnvelope(requestId(), {
      code: "invalid_request",
      message: `Invalid MCP argument '${field}': ${issue?.message ?? "schema validation failed"}`,
      retryable: false,
      details: { field },
    });
  }
  const body =
    cause instanceof FacetBridgeError
      ? cause.body
      : {
          code: "invalid_envelope",
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: false,
        };
  return errEnvelope(requestId(), body);
}

const LooseToolInputSchema = z.record(z.unknown());

function toolResult(envelope: FacetEnvelope<unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    ...(envelope.ok ? {} : { isError: true }),
  };
}

async function invoke(args: readonly string[], options: { cwd?: string; stdin?: string } = {}) {
  try {
    return toolResult(await invokeFacet(args, options));
  } catch (cause) {
    return toolResult(errorEnvelope(cause));
  }
}

async function withInput<T>(
  args: unknown,
  parse: (input: unknown) => T,
  run: (input: T) => Promise<ReturnType<typeof toolResult>>,
): Promise<ReturnType<typeof toolResult>> {
  try {
    return await run(parse(args));
  } catch (cause) {
    return toolResult(errorEnvelope(cause));
  }
}

function publishSource(input: PublishToolInput): {
  file?: string;
  stdin?: string;
} {
  if (input.sourceText !== undefined && input.file !== undefined) {
    throw new FacetBridgeError({
      code: "invalid_request",
      message: "Pass sourceText or file, not both",
      retryable: false,
    });
  }
  if (input.sourceText !== undefined) return { stdin: input.sourceText };
  if (input.file !== undefined) return { file: input.file };
  throw new FacetBridgeError({
    code: "invalid_request",
    message: "publish requires sourceText or file",
    retryable: false,
  });
}

export function createFacetMcpServer(): McpServer {
  const server = new McpServer({ name: "facet", version: "1.0.0" });

  server.registerTool(
    "facet_export",
    {
      description:
        "Export source or stored render evidence into outDir. Check envelope.ok for transport success; a successful publish verdict remains a separate data.verdict.status decision.",
      inputSchema: LooseToolInputSchema,
    },
    async (args) =>
      withInput(args, ExportToolSchema.parse, async (input) => {
        mkdirSync(input.outDir, { recursive: true });
        return invoke(buildFacetArgs("export", input), { cwd: input.outDir });
      }),
  );

  server.registerTool(
    "facet_open_url",
    {
      description:
        "Return a Facet gallery frameUrl without launching a browser. This always invokes facet open --no-launch; agents must not launch desktop display.",
      inputSchema: LooseToolInputSchema,
    },
    async (args) =>
      withInput(args, OpenUrlToolSchema.parse, async (input) =>
        invoke(buildFacetArgs("open", input)),
      ),
  );

  server.registerTool(
    "facet_publish",
    {
      description:
        "Publish sourceText or a local file. Check envelope.ok separately from data.verdict.status: stored verdict status error is not a transport failure.",
      inputSchema: LooseToolInputSchema,
    },
    async (args) =>
      withInput(args, PublishToolSchema.parse, async (input) => {
        const source = publishSource(input);
        return invoke(buildFacetArgs("publish", { ...input, ...source }), source);
      }),
  );

  server.registerTool(
    "facet_read_back",
    {
      description:
        "Read back the latest or revision-bound stored verdict at Tier 0, Tier 1, or visual. Tier 1 and visual need browser evidence; inspect envelope.ok before verdict status.",
      inputSchema: LooseToolInputSchema,
    },
    async (args) =>
      withInput(args, ReadBackToolSchema.parse, async (input) =>
        invoke(buildFacetArgs("read_back", input)),
      ),
  );

  server.registerTool(
    "facet_status",
    {
      description:
        "Read Facet status. Set start only when activation is intended; envelope.ok reports command transport and never replaces verdict.status inspection.",
      inputSchema: LooseToolInputSchema,
    },
    async (args) =>
      withInput(args, StatusToolSchema.parse, async (input) =>
        invoke(buildFacetArgs("status", input)),
      ),
  );

  return server;
}
