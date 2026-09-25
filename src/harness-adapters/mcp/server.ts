import { mkdirSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type ZodType, ZodError } from "zod";
import { FACET_VERSION } from "../../shared/version";

import { buildFacetArgs, FacetBridgeError, invokeFacet } from "./cli-bridge";
import {
  CreateToolSchema,
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

function defineTool<T>(
  schema: ZodType<T>,
  description: string,
  run: (input: T) => Promise<ReturnType<typeof toolResult>>,
) {
  return {
    schema,
    description,
    execute: (args: unknown) => withInput(args, (input) => schema.parse(input), run),
  };
}

export function createFacetMcpServer(): Server {
  const server = new Server(
    { name: "facet", version: FACET_VERSION },
    { capabilities: { tools: {} } },
  );
  // The high-level SDK validates arguments before the handler and emits plain-text errors.
  // Wire schemas and handler parsing are separate so invalid calls retain Facet envelopes.
  const tools = {
    facet_create: defineTool(
      CreateToolSchema,
      "Create an artifact from projectId, slug, and title before publishing source.",
      async (input) => invoke(buildFacetArgs("create", input)),
    ),
    facet_export: defineTool(
      ExportToolSchema,
      "Export source or stored render evidence into outDir. Check envelope.ok for transport success; a successful publish verdict remains a separate data.verdict.status decision.",
      async (input) => {
        try {
          mkdirSync(input.outDir, { recursive: true });
        } catch (cause) {
          throw new FacetBridgeError(
            {
              code: "output_unwritable",
              message: `Cannot write export output: ${input.outDir}`,
              retryable: false,
              details: { out: input.outDir },
            },
            cause,
          );
        }
        return invoke(buildFacetArgs("export", input), { cwd: input.outDir });
      },
    ),
    facet_open_url: defineTool(
      OpenUrlToolSchema,
      "Return a Facet gallery frameUrl without launching a browser. This always invokes facet open --no-launch; agents must not launch desktop display.",
      async (input) => invoke(buildFacetArgs("open", input)),
    ),
    facet_publish: defineTool(
      PublishToolSchema,
      "Publish exactly one sourceText or local file. Check envelope.ok separately from data.verdict.status: stored verdict status error is not a transport failure.",
      async (input) => {
        const source = publishSource(input);
        return invoke(buildFacetArgs("publish", { ...input, ...source }), source);
      },
    ),
    facet_read_back: defineTool(
      ReadBackToolSchema,
      "Read back the latest or revision-bound stored verdict at Tier 0, Tier 1, or visual. Tier 1 and visual need browser evidence; inspect envelope.ok before verdict status.",
      async (input) => invoke(buildFacetArgs("read_back", input)),
    ),
    facet_status: defineTool(
      StatusToolSchema,
      "Read Facet status. Set start only when activation is intended; envelope.ok reports command transport and never replaces verdict.status inspection.",
      async (input) => invoke(buildFacetArgs("status", input)),
    ),
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: toJsonSchemaCompat(tool.schema, { pipeStrategy: "input" }),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = Object.hasOwn(tools, params.name)
      ? tools[params.name as keyof typeof tools]
      : null;
    if (tool) return tool.execute(params.arguments);
    return toolResult(
      errEnvelope(requestId(), {
        code: "invalid_request",
        message: `Unknown MCP tool '${params.name}'`,
        retryable: false,
      }),
    );
  });

  return server;
}
