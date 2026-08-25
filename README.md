<p align="center">
  <strong>◆ facet</strong>
</p>

<p align="center"><strong>Know whether an artifact rendered — not whether a page said it did.</strong></p>

<p align="center">
  <a href="https://github.com/legion-works/facet/actions/workflows/ci.yml"><img src="https://github.com/legion-works/facet/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE-MIT">MIT</a> OR <a href="LICENSE-APACHE">Apache-2.0</a>
</p>

---

## Problem

An agent can emit a diagram or chart and see something that looks fine in the transcript. That is not evidence that the artifact rendered. A page can also produce a screenshot or page-shim report that says it rendered correctly; the page controls both claims.

Facet stores the source bytes without interpreting them, then asks independent validation layers what they observed. The verdict is bound to the exact revision SHA. Artifact code can influence the page, but it cannot rewrite the protocol observation after the fact.

## What it does

- Publishes `markdown`, `mermaid`, `svg`, `chart`, static `html`, and declared-mode `tsx` artifacts.
- Stores immutable revisions and keeps a ring of up to 50 per artifact.
- Records a stored Tier 0 verdict in every publish response; Tier 1 isolated browser validation and Tier 2 display-only inspection are explicit follow-up work.
- Compares lexical expectations with protocol, isolated-world, and page-shim observations.
- Serves a sandboxed, loopback gallery with revision-bound evidence and SSE updates.
- Retains Tier 1 WebP captures of the whole artifact, console output, and protocol observations under an owner-only evidence directory. Interactive TSX declares animated WebP eligibility; static artifacts become eligible only when live CSS or Web Animations are detected.
- Defaults the gallery theme to `system`; users can choose `dark` or `light` and the tab keeps that choice.
- File-mode export returns local artifact and required sidecar paths with byte counts; `--include-bytes` opts into base64 in the envelope.
- Keeps the service byte-dumb: renderers and parsers stay outside `src/service/**`.

<p align="center">
  <img src="design/screenshots/gallery-mermaid.png" alt="facet gallery — current Mermaid fixture in the resolved dark theme" width="820">
</p>

<p align="center">
  <img src="design/screenshots/gallery-chart.png" alt="facet gallery — current chart fixture in the resolved light theme" width="820">
</p>

Current gallery captures use the Mermaid fixture in resolved dark and the chart fixture in resolved light. They are 3840×2160 PNG display assets; Tier 1 evidence is WebP for the whole artifact.

## Verdict language

The gallery and CLI use the same wire enum, glyph, hue, and treatment.

| enum (wire, verbatim)        | glyph | hue       | treatment                        |
| ---------------------------- | ----- | --------- | -------------------------------- |
| `ok`                         | `✓`   | `#c3e88d` | outline — proof, not celebration |
| `error`                      | `✗`   | `#ff757f` | outline                          |
| `partial:layout_unverified`  | `◐`   | `#ffc777` | outline; screenshot required     |
| `partial:opaque_content`     | `◐`   | `#ffc777` | outline; screenshot required     |
| `partial:external_resources` | `◐`   | `#ffc777` | outline; screenshot required     |
| `partial:unstable`           | `◐`   | `#ffc777` | outline; screenshot required     |
| `tampered`                   | `⊘`   | `#ff757f` | filled alarm badge               |
| `timeout`                    | `◌`   | `#737aa2` | dim outline                      |
| `shim_only`                  | `◇`   | `#737aa2` | dim outline                      |
| `probe_only`                 | `◈`   | `#737aa2` | dim outline                      |

`partial:external_resources` means an artifact references external HTTPS images the no-egress verifier could not load. An `ok` verdict can still carry `Verdict.screenshotError.code: "screenshot_unavailable"` when whole-artifact capture cannot be produced; it records the limit without changing the validation result. `insecure:unvalidated` means level 3 intentionally skipped validation. A missing verdict is `UNVERIFIED` with no tier.

## Why not just screenshot it?

| Approach                    | What it can establish                                                                                    | Trust boundary                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Page-shim claim             | Counts reported by JavaScript in the artifact page                                                       | Untrusted; a forged report becomes `shim_only` when the other channels are absent and `tampered` when it diverges |
| Tier 1 protocol observation | DOM and renderer observations from the verifier, compared with an isolated-world probe and the page shim | Independent of the artifact's own claim; disagreement is `tampered`                                               |
| Tier 2 display-only view    | What a human sees in the user's browser                                                                  | No validation verdict; useful for inspection, not proof                                                           |

A screenshot is evidence of pixels. It is not evidence that the page's own report was honest.

## What's in the box

- **CLI contract** — `create`, `publish`, `list`, `read-back`, `status`, `open`, `promote`, `instantiate`, `pin`, and `export` (source/render with a mandatory sidecar).
- **Artifact types** — Markdown, Mermaid, SVG, Vega-Lite chart specs, static HTML, and static or interactive TSX. Chart data must be inline; external `data.url` forms are rejected. HTML is script-free, has no `<style>` block or `style=` attribute, and styles from a vendored Tailwind/daisyUI vocabulary ([reference](docs/reference/html.md)).
- **Gallery** — an offline-built shell with a direct-frame render API, a restrictive per-artifact CSP, zoom controls, and revision SSE.
- **Validation** — a 5 MiB source cap, up to 64 Mermaid blocks and 10,000 Mermaid nodes, and a 1 MiB SVG cap with 16 roots. Tier 1 uses pinned `chrome-headless-shell` `151.0.7922.77`; v9 evidence-format metadata is documented in the [Export reference](docs/reference/export.md).
- **Templates** — eleven checked-in starting points in [`templates/`](templates/), documented in [`templates/README.md`](templates/README.md).

## Quickstart

Requires Bun `1.4.0` or newer. Bun 1.4.0 fixes oven-sh/bun#37230, the fd-reuse bug that affected CDP-pipe browser runs.

```sh
bun install

export FACET_HOME="$(mktemp -d)"
SOURCE='# Facet quickstart'
bun ./src/cli/main.ts status --start
ARTIFACT_ID="$(bun ./src/cli/main.ts create --project-id demo --slug chart --title "Chart" | bun -e 'const x=JSON.parse(await Bun.stdin.text()); if(!x.ok) throw new Error(x.error.code); console.log(x.data.artifact.id)')"
PUBLISH="$(printf '%s' "$SOURCE" | bun ./src/cli/main.ts publish --artifact-id "$ARTIFACT_ID" --type markdown)"
printf '%s\n' "$PUBLISH" | bun -e 'const x=JSON.parse(await Bun.stdin.text()); if(!x.ok || !x.data.verdict) throw new Error("publish failed"); console.log(JSON.stringify(x.data.verdict))'
REVISION_SHA="$(printf '%s\n' "$PUBLISH" | bun -e 'const x=JSON.parse(await Bun.stdin.text()); console.log(x.data.revision.sha256)')"
bun ./src/cli/main.ts read-back --artifact-id "$ARTIFACT_ID" --tier 0
bun ./src/cli/main.ts read-back --artifact-id "$ARTIFACT_ID" --revision-sha "$REVISION_SHA" --tier visual
EXPORT_DIR="$(mktemp -d)"
bun ./src/cli/main.ts export "$ARTIFACT_ID" --format source --out "$EXPORT_DIR/artifact.md"
```

This checkout invocation needs no global link. It uses disposable runtime and export directories. The read-back without `--revision-sha` uses the latest revision; pass the SHA returned by publish when reproducibility matters. Tier 0 is browser-free; visual read-back is explicit Tier 1 escalation. Each verb writes one JSON envelope to stdout; `ok` confirms command transport, so inspect `data.verdict` in the publish envelope, including a stored `status: "error"`.

Facet's insecure mode is an explicit, boot-only opt-in (`FACET_INSECURE=1|2|3`) and is never the default. It weakens or skips validation by level, marks every affected verdict, and speaks loudly at startup, in envelopes, in the CLI, and in the gallery. `FACET_INSECURE_AUTO=1` permits startup probe fallback but never selects level 3. Restart after changing either environment variable.

## MCP

On harnesses with shell access, the CLI is the integration; the MCP adapter is for structured-tool-only environments. The source archive includes a stdio MCP adapter with five CLI-backed tools: publish, read-back, status, export, and a no-launch frame URL lookup. It requires Bun `1.4.0` and a checkout or source archive; Facet releases do not ship an MCP binary. See the [MCP reference](docs/reference/mcp.md) for OpenCode, Claude Code, and Codex registration.

## Documentation

- [Agents](docs/guides/agents.md) — the CLI workflow and adapter boundary.
- [CLI reference](docs/reference/cli.md) · [MCP reference](docs/reference/mcp.md) · [Export](docs/reference/export.md) · [HTML reference](docs/reference/html.md) · [TSX reference](docs/reference/tsx.md) · [HTTP surface](docs/reference/http.md) · [Storage reference](docs/reference/storage.md) · [Validation reference](docs/reference/validation.md) · [Security](docs/reference/security.md)
- [Architecture](ARCHITECTURE.md) · [Structure](STRUCTURE.md) · [v1 ship gate](docs/verification/v1-ship-gate.md) · [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md)

## Status

Facet is a young, single-maintainer project. It targets local and single-operator workflows: the service binds to loopback, has no user-account authentication by design, and still protects routes with install/operator bearer capabilities. Interfaces may shift before 1.0. Bun 1.4.0 includes the verified fd-reuse fix for CDP-pipe browser runs. Current TSX compiler and runtime evidence lives in [TSX measurements](docs/verification/tsx-measurements.md).

## License

MIT OR Apache-2.0, at your option. See [LICENSE-MIT](LICENSE-MIT) or [LICENSE-APACHE](LICENSE-APACHE).

---

<p align="center">
  <img src="design/assets/legion-mark.svg" alt="Legion Works" width="16" valign="middle">
  &nbsp;A <strong>Legion Works</strong> product. Many programs. One consensus.
</p>
