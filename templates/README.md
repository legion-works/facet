# Artifact templates

Styled starting points for every type Facet renders. Each is self-contained:
inline data, fragment-only references, no remote fonts — a source that
reaches outside the sandbox fails closed by design.

| file                    | type       | publish                                                                                  |
| ----------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `status-report.md`      | `markdown` | `facet publish --artifact-id <id> --type markdown --file templates/status-report.md`     |
| `legion-flow.mmd`       | `mermaid`  | `facet publish --artifact-id <id> --type mermaid --file templates/legion-flow.mmd`       |
| `legion-sequence.mmd`   | `mermaid`  | `facet publish --artifact-id <id> --type mermaid --file templates/legion-sequence.mmd`   |
| `metric-card.svg`       | `svg`      | `facet publish --artifact-id <id> --type svg --file templates/metric-card.svg`           |
| `timeseries.vl.json`    | `chart`    | `facet publish --artifact-id <id> --type chart --file templates/timeseries.vl.json`      |
| `bar-compare.vl.json`   | `chart`    | `facet publish --artifact-id <id> --type chart --file templates/bar-compare.vl.json`     |
| `decision-record.md`    | `markdown` | `facet publish --artifact-id <id> --type markdown --file templates/decision-record.md`   |
| `legion-boundaries.mmd` | `mermaid`  | `facet publish --artifact-id <id> --type mermaid --file templates/legion-boundaries.mmd` |
| `legion-state.mmd`      | `mermaid`  | `facet publish --artifact-id <id> --type mermaid --file templates/legion-state.mmd`      |
| `exemplar.md`           | `markdown` | `facet publish --artifact-id <id> --type markdown --file templates/exemplar.md`          |

`exemplar.md` is the reference artifact for the current surface: one publish
carrying tables, checklists, a JSON fence, and three themed diagrams — and
its three mermaid fences ARE the lexical expectation the verifier checks.
Publish it, read it back at `--tier visual`, open the gallery.

Read back what you published, then promote a good revision into a service
template (operator token required, provisioned out of band):

```sh
facet read-back --artifact-id <id> --revision-sha <sha256>
facet promote --revision-id <id> --name status-report --promoted-by <operator>
facet instantiate --name status-report --new-slug q3-report
```

## The Legion diagram theme

Every mermaid template opens with the same `%%{init}%%` block — the house
diagram theme. Reuse it verbatim in docs and new diagrams:

- transparent background; the gallery stage provides the ground
- node fill `#1e2030`, border `#3b4261`, text `#c8d3f5`, edges `#545c7e`
- labels in the mono stack — diagram text is machine truth
- hue is semantic only: green `#c3e88d` ok · amber `#ffc777` warn ·
  red `#ff757f` fail · cyan `#86e1fc` accent, via `classDef`, sparingly

## Constraints worth knowing

- Charts: inline `data.values` only. A `data.url` spec is rejected before
  render; zero-mark specs are an error, not an ok.
- SVG: `use`, `image`, scripts, SMIL, and non-fragment URLs are stripped.
  Keep paint refs as `url(#id)`. Cap 1 MiB, 16 roots.
- Markdown: GFM. Raw HTML renders as visible text, not elements — keep
  templates structural. Base typography inside the frame is currently
  browser-default; a vendored artifact stylesheet is a tracked follow-up.
- Mermaid: at most 64 fenced blocks and 10,000 nodes per artifact.
