# CLI reference

`facet` writes one JSON envelope per command to stdout. Diagnostics go to
stderr. `--help` and `--version` may use text output; verbs always use JSON.
Named exception: `publish --watch` is a stream and writes one envelope per
publish attempt as NDJSON in machine mode; a TTY receives presenter lines.

## Envelope

```json
{ "schemaVersion": "facet.v1", "requestId": "req-<uuid>", "ok": true, "data": {} }
```

Errors use the same top level with `ok: false` and
`error: { code, message, retryable, details? }`.

## Verbs and flags

| verb          | flags                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `create`      | `--project-id`, `--slug`, `--title`                                                                                               |
| `publish`     | `--artifact-id`, `--type`, `--file`, `--watch`, `--note`, `--parent-revision-id`, `--renderer`, `--execution static\|interactive` |
| `list`        | `--project-id`, `--slug-prefix`, `--limit`                                                                                        |
| `read-back`   | `--artifact-id`, optional `--revision-sha` (latest when omitted), `--tier` (one of: `0` \| `1` \| `visual`)                       |
| `status`      | `--artifact-id`, `--start` (valueless start-then-inspect switch)                                                                  |
| `open`        | `--artifact-id`, optional `--revision-sha` (latest when omitted), `--no-launch`                                                   |
| `promote`     | `--artifact-id`, `--revision-id`, `--name`, `--description`, `--promoted-by`                                                      |
| `instantiate` | `--name`, `--new-slug`, `--project-id`                                                                                            |
| `pin`         | `--revision-id`, `--pinned` (`true` or `false`)                                                                                   |
| `export`      | `<artifactId>`, `--revision`, `--format source\|render`, `--out`, `--force`, `--include-bytes`                                    |
|               | `--format source` writes `.md` / `.mmd` / `.svg` / `.json` / `.html` to match the type                                            |
|               | `--format render` writes detected evidence as `.webp` (new) or `.png` (legacy); the sidecar records `renderFormat`                |
| `doctor`      | no flags; read-only local environment diagnostics                                                                                 |

`publish --file -` reads bytes from stdin. `--json` is shorthand for
`--format json` on meta commands. Verb stdout is always a JSON envelope;
`--format` applies only to meta commands and `export`, except
`publish --watch --format json`, which selects machine NDJSON.

`publish --watch --file <path>` performs an initial publish, then watches the
parent directory with debounce. It hashes bytes before sending and skips
identical content. Directory watching survives atomic-save rename/recreate
sequences. A `duplicate_revision` envelope is emitted and the loop continues;
other typed responses are emitted per attempt. Ctrl-C exits cleanly with code 0.
Watch requires a real file path and never reads stdin.

```sh
printf '# Report\n' | facet publish --artifact-id art-123 --type markdown
facet read-back --artifact-id art-123 --tier 0
facet read-back --artifact-id art-123 --revision-sha <sha256> --tier 0
facet read-back --artifact-id art-123 --tier visual  # launches the pinned headless browser
facet open --artifact-id art-123 --no-launch
facet export art-123 --format render --out exports/report.webp
facet export art-123 --format render --out exports/report-with-bytes.webp --include-bytes
```

For file input, use the same publish request with `--file report.md` instead of
the piped `--file -` form above. The read-back and render-export steps are still
required before exporting Tier 1 evidence.

The publish envelope carries the stored Tier 0 verdict, including when its
`status` is `error`; callers must inspect `data.verdict` before treating the
publication as usable. A duplicate publish returns `ok: false` with
`duplicate_revision`; the existing SHA is in `error.details.revisionSha`.

Every verb accepts `--help`. It prints its positional arguments and flags from the
same command table used by the parser. Missing required inputs are reported
together in one typed usage envelope.

`doctor` runs seven read-only probes: the pinned Bun version, headless shell,
network namespace support, database and migration version, token permissions,
evidence-root permissions, and service lock state. Dormant with no lock is
healthy; missing or stale state fails with a literal repair command. A failed
probe still emits an `ok: true` envelope and exits 1.

`status --start` takes no value: it starts the local service if needed, then
returns the normal status envelope. With `--artifact-id`, status includes
`latestRevisionSha`; `read-back --artifact-id <id>` uses that latest revision
when `--revision-sha` is omitted.

`open --artifact-id <id>` resolves the latest revision when no SHA is supplied.
It returns `data.frameUrl` and `data.launched`; `--no-launch` leaves the URL
available without invoking the desktop launcher, and a launcher failure reports
`launched: false`.

`publish --renderer` selects the renderer persisted with the revision. It
defaults to `svg`; `canvas` is valid only for chart artifacts. An invalid
renderer value is a usage error and exits 64.

`publish --type html` publishes a static, script-free HTML artifact.
See [HTML reference](html.md) for the static / script-free contract,
the denied element and attribute set, the vendored class vocabulary,
and the verdict precedence specific to HTML.

`publish --type tsx` defaults to `--execution static`; `interactive` is valid
only for TSX. Non-TSX `interactive` is rejected. See [TSX reference](tsx.md).

Regular boots run Tier 0 on publish, and the publish envelope returns its stored
Tier 0 verdict even when its `status` is `error`. `read-back --tier 1` and
`read-back --tier visual` run Tier 1 on demand, then reuse the stored
revision-bound verdict. If the pinned browser or its network namespace is
unavailable, visual read-back records a Tier 1 `error` verdict with a typed
`tier1_*` code.

`screenshot_unavailable` is nested verdict evidence
(`data.verdict.screenshotError`), not a top-level CLI error code. Common typed
errors and next actions:

| code                   | next action                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `artifact_not_found`   | Check the artifact ID and list the project.                                                                    |
| `revision_not_found`   | Omit the SHA for latest read-back or use an existing SHA.                                                      |
| `duplicate_revision`   | Reuse `error.details.revisionSha`; no new revision was stored.                                                 |
| `output_unwritable`    | Fix the output directory, permissions, or rename target.                                                       |
| `evidence_unavailable` | Run Tier 1 again or inspect retention and evidence paths.                                                      |
| `tier0_*`              | Inspect `error.details`; restore the Tier 0 worker, isolation, protocol, or runtime prerequisites named there. |
| `tier1_*`              | Restore browser/network prerequisites and retry visual read-back.                                              |

Gallery theme modes are `system` (the default), `dark`, and `light`. The selected mode is
session-persistent and changes Tier 2 display; Tier 1 remains dark for
structural parity. Interactive TSX declares animated-capture eligibility; the
mode does not assert that its visuals always change.

`promote` reads its operator bearer from `FACET_PROMOTE_TOKEN` or, by default,
`FACET_HOME/secrets/promote.token`. Neither source is accepted as an argv flag
or emitted in a CLI envelope.

## Insecure mode

`FACET_INSECURE=1|2|3` sets a boot-only forced floor. `FACET_INSECURE_AUTO=1`
opts into startup probe fallback; it never selects level 3. Restart after
changing either variable. Insecure verdicts print an explicit line:

```
INSECURE L1 — auto:tier 1 unavailable
```

## Exit codes

| code | meaning                                         |
| ---: | ----------------------------------------------- |
|    0 | Well-formed envelope, including typed refusal   |
|    1 | Doctor completed with one or more failed probes |
|   64 | Usage error before a command can be built       |
|   70 | Unhandled internal failure                      |

## Reserved surface

There is no reserved artifact type surface left for `publish --type`.
`html` ships alongside `markdown`, `mermaid`, `svg`, and `chart`. Every
artifact type goes through the same `checkArtifactTypeSupported` gate;
an unknown type returns `unsupported_reserved_type`.

→ [Architecture](../../ARCHITECTURE.md) → [Export](export.md) · [HTML](html.md) · [Validation](validation.md) · [Storage](storage.md) · [Security](security.md) · [HTTP](http.md)
