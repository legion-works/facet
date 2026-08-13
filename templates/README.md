# Artifact templates

Styled starting points for every type Facet renders. Each is self-contained:
inline data, fragment-only references, no remote fonts — a source that
reaches outside the sandbox fails closed by design.

| file                          | type       | publish                                                                                                            |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `status-report.md`            | `markdown` | `facet publish --artifact-id <id> --type markdown --file templates/status-report.md`                               |
| `legion-flow.mmd`             | `mermaid`  | `facet publish --artifact-id <id> --type mermaid --file templates/legion-flow.mmd`                                 |
| `legion-sequence.mmd`         | `mermaid`  | `facet publish --artifact-id <id> --type mermaid --file templates/legion-sequence.mmd`                             |
| `metric-card.svg`             | `svg`      | `facet publish --artifact-id <id> --type svg --file templates/metric-card.svg`                                     |
| `system-map.svg`              | `svg`      | `facet publish --artifact-id <id> --type svg --file templates/system-map.svg`                                      |
| `timeseries.vl.json`          | `chart`    | `facet publish --artifact-id <id> --type chart --file templates/timeseries.vl.json`                                |
| `bar-compare.vl.json`         | `chart`    | `facet publish --artifact-id <id> --type chart --file templates/bar-compare.vl.json`                               |
| `decision-record.md`          | `markdown` | `facet publish --artifact-id <id> --type markdown --file templates/decision-record.md`                             |
| `legion-boundaries.mmd`       | `mermaid`  | `facet publish --artifact-id <id> --type mermaid --file templates/legion-boundaries.mmd`                           |
| `legion-state.mmd`            | `mermaid`  | `facet publish --artifact-id <id> --type mermaid --file templates/legion-state.mmd`                                |
| `exemplar.md`                 | `markdown` | `facet publish --artifact-id <id> --type markdown --file templates/exemplar.md`                                    |
| `html-status-report.html`     | `html`     | `facet publish --artifact-id <id> --type html --file templates/html-status-report.html`                            |
| `html-release-ledger.html`    | `html`     | `facet publish --artifact-id <id> --type html --file templates/html-release-ledger.html`                           |
| `tsx-status-report.tsx`       | `tsx`      | `facet publish --artifact-id <id> --type tsx --file templates/tsx-status-report.tsx`                               |
| `tsx-interactive-counter.tsx` | `tsx`      | `facet publish --artifact-id <id> --type tsx --execution interactive --file templates/tsx-interactive-counter.tsx` |

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
- HTML: static, script-free. No `<script>`, no `on*=` handlers, no
  `<style>` block, no `style=` attribute, no `<meta>` / `<link>` /
  `<form>` / `<iframe>`. Styling comes from the shipped class
  vocabulary (`docs/reference/html.md`); a class outside that set
  renders the element unstyled with no error and no trust
  downgrade. `<img src="https://…">` is permitted and downgrades
  the verdict to `partial:external_resources`; `http:`,
  protocol-relative, and `javascript:` URLs fail closed.
- TSX: `static` is the default and enters the HTML pipeline. `interactive`
  observes client-rendered structure twice; it has no SSR or hydration claim.
  Use only vendored React imports and the HTML class vocabulary. Facet mounts
  the default export, so templates must not self-mount. See
  [TSX reference](../docs/reference/tsx.md).
