# Facet MCP adapter

Run this source-archive adapter with Bun:

```sh
bun src/harness-adapters/mcp/main.ts
```

It shells out to the Facet CLI, returns the strict CLI envelope as MCP text content, and maps typed CLI failures to MCP tool errors. `FACET_CLI` selects an alternate CLI executable; otherwise the adapter uses the repository CLI, then `facet` on `PATH`.

The adapter imports only adapter-local code, shared contracts, the MCP SDK, Zod, and Node builtins. Do not add service, validation, or gallery imports.

→ [MCP reference](../../../docs/reference/mcp.md)
