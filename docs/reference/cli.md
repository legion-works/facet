# CLI reference

`facet` writes one JSON envelope per command to stdout. Diagnostics go to
stderr. `--help` and `--version` may use text output; verbs always use JSON.

## Envelope

```json
{ "schemaVersion": "facet.v1", "requestId": "req-<uuid>", "ok": true, "data": {} }
```

Errors use the same top level with `ok: false` and
`error: { code, message, retryable, details? }`.

## Verbs and flags

| verb          | flags                                                                        |
| ------------- | ---------------------------------------------------------------------------- | ------ | ------- |
| `create`      | `--project-id`, `--slug`, `--title`                                          |
| `publish`     | `--artifact-id`, `--type`, `--file`, `--note`, `--parent-revision-id`        |
| `list`        | `--project-id`, `--slug-prefix`, `--limit`                                   |
| `read-back`   | `--artifact-id`, `--revision-sha`, `--tier 0                                 | 1      | visual` |
| `status`      | `--artifact-id`, `--start`                                                   |
| `open`        | `--artifact-id`, `--revision-sha`                                            |
| `promote`     | `--artifact-id`, `--revision-id`, `--name`, `--description`, `--promoted-by` |
| `instantiate` | `--name`, `--new-slug`, `--project-id`                                       |
| `pin`         | `--revision-id`, `--pinned true                                              | false` |
| `export`      | `--format`                                                                   |

`publish --file -` reads bytes from stdin. `--json` is shorthand for
`--format json` on meta commands.

## Exit codes

| code | meaning                                       |
| ---: | --------------------------------------------- |
|    0 | Well-formed envelope, including typed refusal |
|   64 | Usage error before a command can be built     |
|   70 | Unhandled internal failure                    |

## Reserved surface

`export` is parsed but returns `accepted: false` with a typed
`reserved_not_implemented` result. HTML remains a reserved artifact type and
returns `unsupported_reserved_type`.

→ [Architecture](../../ARCHITECTURE.md) → [Validation](validation.md) · [Storage](storage.md) · [Security](security.md) · [HTTP](http.md)
