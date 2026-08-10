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

| verb          | flags                                                                               |
| ------------- | ----------------------------------------------------------------------------------- |
| `create`      | `--project-id`, `--slug`, `--title`                                                 |
| `publish`     | `--artifact-id`, `--type`, `--file`, `--note`, `--parent-revision-id`, `--renderer` |
| `list`        | `--project-id`, `--slug-prefix`, `--limit`                                          |
| `read-back`   | `--artifact-id`, `--revision-sha`, `--tier` (one of: `0`, `1`, `visual`)            |
| `status`      | `--artifact-id`, `--start`                                                          |
| `open`        | `--artifact-id`, `--revision-sha`                                                   |
| `promote`     | `--artifact-id`, `--revision-id`, `--name`, `--description`, `--promoted-by`        |
| `instantiate` | `--name`, `--new-slug`, `--project-id`                                              |
| `pin`         | `--revision-id`, `--pinned` (`true` or `false`)                                     |
| `export`      | `<artifactId>`, `--revision`, `--format source\|render`, `--out`, `--force`         |

`publish --file -` reads bytes from stdin. `--json` is shorthand for
`--format json` on meta commands.

`publish --renderer` selects the renderer persisted with the revision. It
defaults to `svg`; `canvas` is valid only for chart artifacts. An invalid
renderer value is a usage error and exits 64.

## Insecure mode

`FACET_INSECURE=1|2|3` sets a boot-only forced floor. `FACET_INSECURE_AUTO=1`
opts into startup probe fallback; it never selects level 3. Restart after
changing either variable. Insecure verdicts print an explicit line:

```
INSECURE L1 — auto:tier 1 unavailable
```

## Exit codes

| code | meaning                                       |
| ---: | --------------------------------------------- |
|    0 | Well-formed envelope, including typed refusal |
|   64 | Usage error before a command can be built     |
|   70 | Unhandled internal failure                    |

## Reserved surface

HTML remains a reserved artifact type and returns `unsupported_reserved_type`.

→ [Architecture](../../ARCHITECTURE.md) → [Export](export.md) · [Validation](validation.md) · [Storage](storage.md) · [Security](security.md) · [HTTP](http.md)
