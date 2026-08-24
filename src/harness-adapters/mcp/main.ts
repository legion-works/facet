import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createFacetMcpServer } from "./server";

async function main(): Promise<void> {
  const server = createFacetMcpServer();
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `facet MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
