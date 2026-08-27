---
name: facet
description: Use when creating, publishing, validating, exporting, or inspecting Facet artifacts, diagrams, charts, SVG, Markdown, or gallery output; when choosing between Markdown, Mermaid, SVG, chart, HTML, and TSX; or when a Facet CLI envelope or typed error needs interpretation.
---

# Facet

Install `@legionworks/facet` with `bun add -g` (recommended), `npm i -g`, or
`pnpm add -g`; use `bunx @legionworks/facet <verb>` without a global install.
Bun `1.4.0` or newer is the required runtime. npm and pnpm are distribution
channels only. The pinned browser downloads on the first visual read-back.

Facet stores and verifies artifact bytes through a versioned CLI envelope. Keep
artifact bytes separate from host capabilities.

## Choose the artifact type

| Need                     | Type                           | Why                                                                                         |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------- |
| Prose or mixed documents | Markdown                       | Portable authored content.                                                                  |
| One diagram              | Mermaid                        | A single declarative diagram.                                                               |
| Authored vector output   | SVG                            | Precise vector output under the SVG contract.                                               |
| Data visualization       | chart                          | Vega-Lite data visualization; `svg` is default, `canvas` only when chosen for the chart.    |
| Static semantic report   | HTML                           | Static semantic report with vendored styles.                                                |
| Component composition    | TSX: `static` \| `interactive` | Use `static` by default; use `interactive` only when runtime state or behavior is required. |

## Publish and check

1. Cold-start check: when environment, launch, or permission errors are present, run `facet doctor`; it is read-only and reports literal repair commands. Check status next and start only when needed: `facet status --start`.
2. Create or reuse an artifact: `facet create --project-id <id> --slug <slug> --title <title>`.
3. Publish source bytes with one of these forms:

   ```sh
   facet publish --artifact-id <id> --type markdown --file path/to/source.md
   facet publish --artifact-id <id> --type markdown --file -
   printf '%s' "$SOURCE" | facet publish --artifact-id <id> --type markdown
   ```

   Use `--watch --file <path>` for operator-led iterative authoring; it streams one publish envelope per changed attempt until Ctrl-C.

4. For every publish response, branch on top-level `ok`. If it is true, separately inspect `data.verdict.status`, `tier`, `artifactId`, and `revisionSha`. `ok: true` only confirms command transport; `status: "error"` is a stored validation result, not a transport refusal.
5. Read back Tier 0/latest by default: `facet read-back --artifact-id <id>`. Omit `--revision-sha` for the latest revision; pass its SHA only to pin reproducible read-back. Request `--tier 1` or `--tier visual` only when browser-backed evidence is needed.

## Execution and evidence

`--execution static|interactive` applies to TSX only. `static` is the default;
`interactive` is for client runtime state or behavior. Verdicts carry execution
only for TSX. Interactive TSX is animation-eligible without probing; static
artifacts become animation-eligible only after live CSS or Web Animations are
detected.

Gallery display defaults to `system`; users may select `dark` or `light`, and
the tab persists that choice. Tier 1 stays dark for deterministic parity.

## Export

Use `facet export <artifactId> --format source` for stored source, or
`--format render` for retained Tier 1 evidence. Exports write local artifact and
mandatory sidecar paths plus byte count by default. Use `--include-bytes` only
when an envelope consumer genuinely needs base64 bytes. Render export preserves
the detected evidence format:

- detected WebP for new captures;
- detected PNG for legacy captures.

## Promotion

Promotion is operator-only. The CLI discovers the token from
`FACET_PROMOTE_TOKEN`, then `FACET_HOME/secrets/promote.token`; never put a
token on argv.

## Error quick reference

| Error                    | Do next                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `invalid_request`        | Correct the command flags, artifact type, or source bytes, then retry.                                           |
| `artifact_not_found`     | List or create the artifact, then use its returned ID.                                                           |
| `revision_not_found`     | Omit the SHA for latest, or replace it with a returned revision SHA.                                             |
| `duplicate_revision`     | Use `error.details.revisionSha` as the existing revision SHA; do not republish identical bytes.                  |
| `evidence_unavailable`   | Request Tier 1 evidence for that revision before a render export, or export source instead.                      |
| `output_unwritable`      | Choose a writable `--out` path, resolve collisions, or use `--force` deliberately.                               |
| `tier0_*`                | Repair the Tier 0 worker or its environment; a returned `status: "error"` is a verdict, not this envelope error. |
| `tier1_*`                | Repair browser-backed validation availability, then retry the requested Tier 1 read-back.                        |
| `screenshot_unavailable` | Inspect `Verdict.screenshotError`; it is a degraded stored verdict field, not an envelope error.                 |

## Boundaries

- Promotion is operator-only. Secrets never enter artifacts, notes, or argv.
- The service is byte-dumb: do not call loopback routes, import renderers, or
  parse artifact bytes outside the documented CLI workflow.
- Do not run `facet open` as an agent: it launches local `xdg-open` for human
  display on the operator's desktop. Ensure the service is active with
  `facet status --start`, then use the documented [Steel/browser workflow](../../docs/guides/agents.md)
  or ask a human to inspect.
- Preserve stdout exactly so callers can parse the versioned envelope.
- With shell access, the CLI is the integration — MCP is for structured-tool-only hosts, even when the host owns an MCP client. On that surface, `facet_open_url` is safe because it always uses `--no-launch`.
- For MCP registration, use `bun add -g @legionworks/facet` and the bare
  `facet-mcp` command, or the no-install fallback `npx -p @legionworks/facet
facet-mcp`. The measured `bunx -p @legionworks/facet facet-mcp` form exited
  with status 1 under Bun `1.3.14` and the available scratch Bun `1.4.0`; treat
  that as an environment-specific caveat, not a universal Bun claim.

## Deeper reference

→ [Agent workflow](../../docs/guides/agents.md) · [CLI](../../docs/reference/cli.md) · [MCP](../../docs/reference/mcp.md) · [Export](../../docs/reference/export.md) · [Validation](../../docs/reference/validation.md) · [HTML](../../docs/reference/html.md) · [TSX](../../docs/reference/tsx.md) · [Security](../../docs/reference/security.md)
