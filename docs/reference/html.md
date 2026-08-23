# HTML reference

Static, script-free HTML artifacts. The verifier predicts structural counts
from the source bytes with a no-egress WHATWG parser, observes the rendered
DOM through Chromium, and binds the verdict to the revision SHA.

## Publish

```sh
facet publish --artifact-id <id> --type html --file templates/html-status-report.html
facet read-back --artifact-id <id> --revision-sha <sha> --tier 1
```

`--type html` is a first-class type on `publish`; `--renderer` stays chart-only.

## Static, script-free contract

The artifact has no script, no event handler, no `<style>` block, no `style=`
attribute, and no Facet marker bytes. The frame wraps the parsed body in a
single element carrying `data-facet-renderer-root` so protocol probes can
scope their observations — the marker is frame-owned, never artifact-owned.

Source export returns the published bytes byte-for-byte; the wrapper is
frame-only and never reaches storage or export. `export <artifactId>
--format source` against an HTML revision produces the exact source the
operator published.

## Accepted semantic HTML

Every element and attribute an HTML report or dashboard reasonably uses is
permitted:

- text, headings, lists, tables, sectioning (`<section>`, `<article>`,
  `<nav>`, `<header>`, `<footer>`, `<main>`, `<aside>`)
- figures, `<details>`, `<summary>`, `<mark>`, `<time>`, `<abbr>`, `<cite>`,
  `<q>`, `<dfn>`
- inline semantics (`<span>`, `<em>`, `<strong>`, `<code>`, `<kbd>`,
  `<samp>`, `<var>`, `<br>`, `<wbr>`)
- images (`<img>`), source (`<source>`), anchors (`<a>`)
- canvases (`<canvas>`)

## Denied elements and attributes

| kind            | refused                                                               |
| --------------- | --------------------------------------------------------------------- |
| script-tagged   | `script`, `iframe`, `object`, `embed`, `form`, `link`, `meta`, `base` |
| styling surface | `style`, `style=` (no CSS-injection surface anywhere)                 |
| event handlers  | every `on*=` attribute                                                |
| bad URL schemes | `http:`, protocol-relative (`//host/...`), `javascript:`              |

`cleartext http:`, protocol-relative, and `javascript:` URLs fail closed
with `html_denied_url_scheme`. Image anchors accept `https:` and `data:`;
regular anchors accept `https:` and `mailto:`.

## Verdict claim

`ok` on an HTML artifact means: counts agree across the Tier 0 parse5
prediction and the Tier 1 Chromium observation, every count group is
exercised, no discriminative error fired, and the layout pass is
observable. The observable is a structural count vector:

| key                  | what it counts                                                     |
| -------------------- | ------------------------------------------------------------------ |
| `rendererRootCount`  | frame-owned `data-facet-renderer-root` wrappers in the document    |
| `headingCount`       | `<h1>`–`<h6>`                                                      |
| `tableCount`         | `<table>`                                                          |
| `listCount`          | `<ul>`, `<ol>`                                                     |
| `imageCount`         | `<img>`                                                            |
| `canvasCount`        | `<canvas>`                                                         |
| `externalImageCount` | `<img>` and `<source>` whose `src` / `srcset` resolves to `https:` |

The marker-anchored structure is the smallest claim that catches blank
renders, truncated trees, or structure the source never declared — and
the largest claim that survives legitimate parse5-versus-Chromium
recovery differences (see [unsupported recovery families](#unsupported-recovery-families)).

## Verdict precedence

Status is decided in exactly one place (`src/validation/tier1/verdict.ts`).
For HTML specifically:

1. `tampered` — predicted counts disagree with the Tier 1 observation.
2. `error` — discriminative error fired (`html_denied_element`,
   `html_denied_attribute`, `html_denied_url_scheme`,
   `html_encoding_unsupported`, `html_nesting_depth_exceeded`,
   `html_recovery_unsupported`).
3. `partial:opaque_content` — a `<canvas>` exists; structure beneath it
   is unobservable. MUST carry a screenshot or typed `screenshotError`.
4. `partial:external_resources` — an HTTPS image was referenced; the
   no-egress verifier never loaded it. MUST carry a screenshot or typed
   `screenshotError`.
5. `ok` — counts agree, no discriminative error, no opaque region, no
   external image.

`partial:` is not a degraded `ok`. The screenshot is mandatory evidence
so a human or re-verifier can see what the verifier saw.

## HTTPS image and the no-connect rule

The frozen CSP widened from `img-src data:` to `img-src data: https:` to
let reports link real screenshots without inflating the source cap. The
no-connect and no-script rules are unchanged:

| directive     | value                       | verdict or display?  |
| ------------- | --------------------------- | -------------------- |
| `script-src`  | `'nonce-<BOOTSTRAP_NONCE>'` | verdict              |
| `connect-src` | `'none'`                    | verdict              |
| `frame-src`   | `'none'`                    | verdict              |
| `object-src`  | `'none'`                    | verdict              |
| `base-uri`    | `'none'`                    | verdict              |
| `form-action` | `'none'`                    | verdict              |
| `worker-src`  | `'none'`                    | verdict              |
| `img-src`     | `data: https:`              | display-time privacy |
| `font-src`    | `data:`                     | display-time privacy |

The first six protect the VERDICT — a page that can run attacker code
or open a network socket can forge a verdict or exfiltrate, so they stay
closed. `img-src` and `font-src` protect PRIVACY at display time only;
the verifier never follows the URLs, so widening `img-src` to `https:`
cannot weaken the verdict.

→ [Security reference](security.md) for the full frozen-CSP contract.

## Vendored styling

Styling comes exclusively from the frame's offline-vendored stylesheet.
certain gallery frames map resolved light/dark themes to daisyUI's `winter` and
`night` themes. The gallery preference defaults to `system` and resolves from
the user's light/dark preference; Tier 1 deliberately fixes dark/night parity
for deterministic structural comparison. Artifact-authored HTML still cannot
supply `<style>` or `style=`; gallery theming does not widen that policy.
Tailwind utilities come from a deterministic corpus that
covers the templates, this reference, and common layout, spacing, typography,
and color classes.

`HTML_TAILWIND_CLASSES` and `HTML_DAISY_COMPONENTS` in
`src/shared/html/style-vocabulary.ts` are recommendations, not a styling
ceiling. Use them for predictable artifact output. A valid daisyUI class or
an included Tailwind utility outside this list can still render.

<!-- VOCABULARY:START -->

### Recommended Tailwind utilities

`block`, `flex`, `grid`, `inline-flex`, `flex-col`, `flex-wrap`, `items-center`, `justify-between`, `justify-center`, `grid-cols-1`, `grid-cols-2`, `grid-cols-3`, `gap-2`, `gap-3`, `gap-4`, `gap-6`, `p-2`, `p-3`, `p-4`, `p-6`, `px-3`, `px-4`, `py-2`, `py-3`, `m-0`, `mt-2`, `mt-4`, `mb-2`, `mb-4`, `w-full`, `max-w-prose`, `max-w-2xl`, `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl`, `text-2xl`, `font-medium`, `font-semibold`, `font-bold`, `leading-relaxed`, `text-left`, `text-center`, `text-right`, `text-legion-ink`, `text-legion-muted`, `text-legion-cyan`, `bg-legion-paper`, `bg-legion-ink`, `bg-legion-cyan`, `border`, `border-2`, `border-legion-line`, `rounded`, `rounded-box`, `overflow-x-auto`, `table`, `table-zebra`.

59 recommended utilities.

### Recommended daisyUI components

`alert`, `badge`, `btn`, `card`, `stat`, `table`.

6 recommended components · 64 documented recommendations.

<!-- VOCABULARY:END -->

### Unknown classes

No error, no `partial:`, no trust downgrade. A class that is neither a real
daisyUI class nor present in the Tailwind corpus has no styling effect.

## Pinned styling packages

| package            | version | loaded under `script-src 'nonce-…'`? |
| ------------------ | ------- | ------------------------------------ |
| `@tailwindcss/cli` | 4.3.3   | no (build-time only)                 |
| `tailwindcss`      | 4.x     | no (vendored stylesheet, no runtime) |
| `daisyui`          | 5.7.16  | no (vendored CSS, no runtime JS)     |

Tailwind is bundled at build time (`bun scripts/build-html-styles.ts`)
against the deterministic build corpus in `src/shared/html/style-vocabulary.ts`;
no Tailwind runtime runs in the frame. `daisyui` 5.7.16 ships CSS-var themes
and components only — the vendored bundle contains zero `<script>` and zero
`javascript:` URLs. The `img-src` and `font-src` widenings do not load any
runtime JS because the packages carry none.

## Starter template

A neutral status / report page that uses only the shipped vocabulary:

```sh
facet publish --artifact-id <id> --type html --file templates/html-status-report.html
```

→ [`templates/html-status-report.html`](../../templates/html-status-report.html) ·
[`templates/README.md`](../../templates/README.md) for the starter index.

## Unsupported recovery families

The differential corpus (parse5 prediction vs Chromium observation over real
documents) discovered three recovery shapes where the WHATWG parser and
Chromium disagree. Static HTML reports do not need these, so the accepted
input set shrinks instead of weakening the comparison:

| family                                                                                                                                                                                                                                                                  | rejected as                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| UTF-8 encoding ambiguity (`0xFF` mid-stream)                                                                                                                                                                                                                            | `html_encoding_unsupported` |
| `<select>` containing `<table>` / `<tr>` / `<td>` / `<th>` / `<tbody>` / `<thead>` / `<tfoot>` / `<caption>` / `<colgroup>` / `<col>` (including the two-`<select>` variant where the second `<select>` carries the table markup, and any `<noscript>`-nested instance) | `html_recovery_unsupported` |

A fourth bound — `html_nesting_depth_exceeded` — fires when source nesting
exceeds the cap in `MAX_HTML_NESTING_DEPTH`. The cap protects Tier 0 and
Tier 1 from pathological inputs.

These error codes are stable wire values; downstream tooling can match on
them without parsing message text.

## Tier 0 prediction source

Tier 0 parses the source bytes with `parse5@8.0.1` (`scriptingEnabled:
false`, matching Chromium's `DOMParser`) inside the existing netns worker.
No CSS sanitizer, no DOM mutation, no event-loop. The structural counts
that come out of Tier 0 are bound to the revision SHA and never mutate.

→ [Validation reference](validation.md) for tier evidence and the
revision-binding guarantee.
