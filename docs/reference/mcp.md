# MCP adapter

On harnesses with shell access, the CLI is the integration; the MCP adapter is for structured-tool-only environments. If an agent can run a shell, use the CLI and the Facet skill — this adapter buys no capability there.

Facet's npm package includes the `facet-mcp` bin. It needs Bun `1.4.0`; npm and pnpm install the package, but Bun remains the runtime.

Recommended installation and invocation:

```sh
bun add -g @legionworks/facet
facet-mcp
```

No-install alternative:

```sh
npx -p @legionworks/facet facet-mcp
```

Do not use `bunx -p @legionworks/facet facet-mcp` as the registration command without verifying the local Bun release. It exited immediately with status 1 on Bun `1.3.14` on the measured host; the same form also exited with status 1 under the available scratch Bun `1.4.0` runtime. These observations are environment-specific, so this caveat is not a universal claim about every Bun release or installation.

The adapter resolves the CLI in this order: `FACET_CLI`, then `bun <adapter-relative-repository>/src/cli/main.ts`, then `facet` on `PATH`. Set `FACET_CLI` to an absolute CLI executable when the adapter should use another installation.

## Register the server

OpenCode config:

```json
{
  "mcp": {
    "facet": {
      "type": "local",
      "command": ["facet-mcp"],
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
      "command": "facet-mcp"
    }
  }
}
```

Codex config (`~/.codex/config.toml`):

```toml
[mcp_servers.facet]
command = "facet-mcp"
```

Set `FACET_HOME` in the host configuration when the adapter must use a non-default Facet runtime directory. Set `FACET_CLI` only for an alternate CLI executable.

## Tools

| Tool              | Inputs                                                                                                                    | Effect                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `facet_publish`   | `artifactId`, `type`, exactly one of `sourceText` or `file`; optional `execution`, `renderer`, `note`, `parentRevisionId` | Publishes inline source through CLI stdin or reads the named local file.     |
| `facet_read_back` | `artifactId`; optional `revisionSha`, `tier` (`0` \| `1` \| `visual`)                                                     | Reads the latest or named revision. Tier 1 and visual need browser evidence. |
| `facet_status`    | optional `artifactId`, `start`                                                                                            | Reads status. Set `start` only when activation is intended.                  |
| `facet_export`    | `artifactId`, `format` (`source` \| `render`), `outDir`; optional `revisionSha`, `force`, `includeBytes`                  | Writes the CLI's normal export and sidecar beneath `outDir`.                 |
| `facet_open_url`  | `artifactId`; optional `revisionSha`                                                                                      | Returns a gallery `frameUrl` without launching a browser.                    |

`facet_open_url` always adds `--no-launch`. It is the MCP-safe form of `facet open`; it never invokes `xdg-open` or another desktop launcher.

Exactly one of `sourceText` or `file` is required. The adapter returns `invalid_request` when both or neither are supplied.

The MCP surface is the five artifact tools; run `facet doctor` through the CLI.

## Result and error handling

Every tool returns one text content item containing the complete versioned Facet envelope. `ok: true` means the CLI command completed at the transport boundary. For publish and read-back, inspect `data.verdict.status` separately: a stored verdict can be `error` even when the envelope is successful.

Typed Facet failures return that same envelope with `isError: true`. The JSON body preserves `error.code`, `error.message`, `error.retryable`, and `error.details`. The adapter converts malformed CLI stdout and subprocess failures into typed `invalid_envelope` errors instead of throwing raw process text through MCP.

## Boundary

The adapter only shells out to `facet` and parses the shared wire envelope. It does not import service, validation, or gallery code. The boundary checker permits only the MCP SDK, Zod, Node builtins, adapter-local modules, shared contracts, and the shared product version in `src/harness-adapters/mcp/`.
