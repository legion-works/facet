# MCP adapter

Facet's MCP adapter is source-archive-only. It needs a Facet checkout or source archive and Bun `1.4.0`; releases do not ship a `facet-mcp` binary or embed MCP in the Facet CLI.

Run the adapter with Bun:

```sh
bun /absolute/path/to/facet/src/harness-adapters/mcp/main.ts
```

The adapter resolves the CLI in this order: `FACET_CLI`, then `bun <adapter-relative-repository>/src/cli/main.ts`, then `facet` on `PATH`. Set `FACET_CLI` to an absolute CLI executable when the adapter should use another installation.

## Register the server

OpenCode config:

```json
{
  "mcp": {
    "facet": {
      "type": "local",
      "command": ["bun", "/absolute/path/to/facet/src/harness-adapters/mcp/main.ts"],
      "enabled": true
    }
  }
}
```

Claude Code project config (`.mcp.json`):

```json
{
  "mcpServers": {
    "facet": {
      "command": "bun",
      "args": ["/absolute/path/to/facet/src/harness-adapters/mcp/main.ts"]
    }
  }
}
```

Codex config (`~/.codex/config.toml`):

```toml
[mcp_servers.facet]
command = "bun"
args = ["/absolute/path/to/facet/src/harness-adapters/mcp/main.ts"]
```

Set `FACET_HOME` in the host configuration when the adapter must use a non-default Facet runtime directory. Set `FACET_CLI` only for an alternate CLI executable; the source-archive default already resolves the checkout CLI.

## Tools

| Tool              | Inputs                                                                                                     | Effect                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `facet_publish`   | `artifactId`, `type`, `sourceText` or `file`; optional `execution`, `renderer`, `note`, `parentRevisionId` | Publishes inline source through CLI stdin or reads the named local file.     |
| `facet_read_back` | `artifactId`; optional `revisionSha`, `tier` (`0` \| `1` \| `visual`)                                      | Reads the latest or named revision. Tier 1 and visual need browser evidence. |
| `facet_status`    | optional `artifactId`, `start`                                                                             | Reads status. Set `start` only when activation is intended.                  |
| `facet_export`    | `artifactId`, `format` (`source` \| `render`), `outDir`; optional `revisionSha`, `force`, `includeBytes`   | Writes the CLI's normal export and sidecar beneath `outDir`.                 |
| `facet_open_url`  | `artifactId`; optional `revisionSha`                                                                       | Returns a gallery `frameUrl` without launching a browser.                    |

`facet_open_url` always adds `--no-launch`. It is the MCP-safe form of `facet open`; it never invokes `xdg-open` or another desktop launcher.

## Result and error handling

Every tool returns one text content item containing the complete versioned Facet envelope. `ok: true` means the CLI command completed at the transport boundary. For publish and read-back, inspect `data.verdict.status` separately: a stored verdict can be `error` even when the envelope is successful.

Typed Facet failures return that same envelope with `isError: true`. The JSON body preserves `error.code`, `error.message`, `error.retryable`, and `error.details`. The adapter converts malformed CLI stdout and subprocess failures into typed `invalid_envelope` errors instead of throwing raw process text through MCP.

## Boundary

The adapter only shells out to `facet` and parses the shared wire envelope. It does not import service, validation, or gallery code. The boundary checker permits only the MCP SDK, Zod, Node builtins, adapter-local modules, and shared contracts in `src/harness-adapters/mcp/`.
