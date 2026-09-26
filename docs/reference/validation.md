# Validation reference

The tiered validation contract every read-back response is bound to.
Covers the `RenderStatus` taxonomy, what evidence each tier persists,
the retention policy, and the revision-binding guarantee.

## Tier taxonomy

`RenderStatus` is the closed enum the verifier assigns to one run. The
verdict is decided in exactly one place (`src/validation/tier1/verdict.ts`).
Every other layer is bound to it through `VerdictSchema.status`.

| status                       | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ok`                         | Counts agree across protocol + shim + isolated worlds, layout observable, no discriminative errors.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `error`                      | Counts disagree with the lexical expectation OR the protocol surfaced a discriminative error.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `partial:layout_unverified`  | Counts agree but the layout pass is unverified (no SVG rendered with a non-degenerate viewBox). Markdown with zero expected renderer roots and opaque regions instead reaches `ok` when protocol and isolated observations agree that its renderer root is non-empty. Empty Markdown remains unverified. MUST carry a screenshot path on the wire.                                                                                                                                                                                               |
| `partial:opaque_content`     | An opaque DOM region was observed, so structural contents were not verified. MUST carry a screenshot path, or a typed `screenshotError` marker when capture fails transiently.                                                                                                                                                                                                                                                                                                                                                                   |
| `partial:external_resources` | The artifact references external HTTPS images the no-egress verifier could not observe. MUST carry a screenshot path, or a typed `screenshotError` marker when capture fails transiently.                                                                                                                                                                                                                                                                                                                                                        |
| `partial:unstable`           | TSX interactive mode: the structure observed at the render barrier differed from the structure observed after a bounded stability window. Deliberately NOT `tampered` — a legitimately animated or async-loading component also changes structure between observations, and branding that a forgery would manufacture the false-verdict class this project has spent three arcs eliminating. `tampered` stays reserved for channel divergence. MUST carry a screenshot path, or a typed `screenshotError` marker when capture fails transiently. |
| `partial:empty_render`       | TSX Tier 1: all authoritative observations agree that the renderer root has no element children and no non-whitespace text. MUST carry a screenshot path, or a typed `screenshotError` marker when capture fails transiently.                                                                                                                                                                                                                                                                                                                    |
| `tampered`                   | Page-shim or isolated-world observation diverges from protocol authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `timeout`                    | The harness did not emit `render-complete` within `TIER1_RENDER_BARRIER_MS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `shim_only`                  | Isolated-world channel missing; only the untrusted page-shim produced usable counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `probe_only`                 | Both the page-shim and the isolated-world channel are missing; only the protocol channel is usable.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `insecure:unvalidated`       | Level 3 intentionally skipped validation. The artifact is not represented as validated.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### External image count

`externalImageCount` counts every external `https:` image reference: an
`<img>` `src`, each `https:` candidate in an `<img>` or `<source>` `srcset`,
and Markdown images. Tier 0 predicts it from the source and Tier 1 counts
it in the rendered document with the same definition:
`countExternalHttpsImageReferences` in `src/shared/html/policy.ts`, built on
`isExternalHttpsImageSource`, which Markdown image links use directly. The
verifier does not model which `srcset` candidate a browser would pick.

The Tier 1 count is compared with the prediction like the other counts. A
mismatch is an `error` (row 4 below) rather than a silent
`partial:layout_unverified` or `ok`. Interactive TSX makes no prediction,
because its runtime code can create images, so its comparison is skipped.
The observed count still drives `partial:external_resources`.

A `partial:*` verdict is a verdict the verifier could not finalize, NOT
a degraded `ok`. The screenshot is mandatory FOR `partial:` so a human
or a re-verifier can see what the verifier saw — it is not a thing
that upgrades the verdict. When capture fails transiently, the typed
`screenshotError` marker records that honest degraded path. A `partial:`
without a screenshot or marker is rejected at the schema parse boundary.

### `partial:unstable` precedence slot

`partial:unstable` splits the error paths in two, because `error` is not a
single tier. The discriminating question is whether a status rests on ONE
observation or on something a structure change cannot invalidate. The full
ordering, top to bottom:

1. `timeout` — lifecycle failed at the render barrier (`renderComplete === false`).
2. `tampered` — channel divergence; the page contradicts protocol authority.
3. `probe_only` / `shim_only` — channel availability (meta-claim about the channels, not the page).
4. `error` — discriminative errors are non-empty, or observed counts disagree with the lexical expectation. Both survive a structure change: a parse error is a parse error whenever it was observed, and a count that never matched the source's expectation never matches.
5. **`partial:unstable`** — TSX interactive mode; structure changed between the render barrier and the stability window.
6. `partial:empty_render` — TSX root emptiness, after instability and before other single-snapshot partials.
7. `error` (declared-opaque, observed-zero) — the artifact declared opaque regions and none were seen.
8. `partial:opaque_content` — single-snapshot claim: structure has opaque regions.
9. `partial:external_resources` — single-snapshot claim: structure has external HTTP references.
10. `partial:layout_unverified` — single-snapshot claim: visible SVG with zeroed viewBoxes; it also applies to empty Markdown, while diagram-free Markdown with matching non-empty observations has no layout to verify.
11. `ok`.

The rule generalizing rows 4 and 6: a claim that depends on ONE observation
loses to `partial:unstable`; a claim that holds regardless of when it was
observed outranks it.

The reasoning: when structure is changing between two observation snapshots, the verifier cannot honestly claim "this artifact has structure X" — every single-snapshot claim (opaque, external, layout) is moot. `partial:unstable` is a meta-claim about the page's runtime behavior that dominates the single-snapshot structural claims. `tampered` stays above it because channel divergence (the page contradicting protocol authority) is the more catastrophic reading of the page's behavior. The decision is pinned by `tests/unit/verdict.test.ts` (unstable outranks opaque, external, layout-unverified; unstable loses to tampered, timeout, and channel-availability).

## Evidence captured per tier

| tier | evidence retained                                                                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | DB row only (expected + observed JSON, status, timing). No on-disk evidence.                                                                                                                                                                                                                                          |
| 1    | DB row + per-run directory under `<evidence>/tier1/<revisionSha>/<runId>/`: `screenshot.webp` for new captures, legacy `screenshot.png` when retained, `console.txt`, and `protocol-observation.json`. Captures cover the whole artifact within the 4096-pixel axis, 8,388,608-pixel total, and 8 MiB encoded limits. |

The evidence root is the XDG state path `paths.evidence` (or the
`FACET_HOME/evidence` override). Every directory the runner creates is
mode 0700 — the canonical secret-bearing layout matches the DB file
permissions.

The Tier 1 run, including evidence capture, has a 60 s total deadline.
On expiry the verifier kills the browser before bounded teardown (3 s)
and returns a typed `tier1_timeout` error rather than a `timeout` render
status. The total and teardown budgets fit inside the CLI's 75 s client
timeout.

Tier 1 capture happens AFTER the verdict is derived so the
`partial:layout_unverified`, `partial:opaque_content`, `partial:external_resources`, `partial:unstable`, and `partial:empty_render` screenshot mandates are honored. The runner
measures the whole artifact, bounds each axis at 4096 pixels and the total at
8,388,608 pixels, and encodes evidence under the 8 MiB cap. New captures are
WebP; legacy PNG evidence remains readable and exportable. Before static
capture it emulates `prefers-reduced-motion: reduce` and awaits
`document.fonts.ready`; these pre-flights keep repeated captures byte-identical.

If resizing the capture viewport makes the artifact grow, Tier 1 restores the
1280×800 evidence viewport and captures the artifact's scroll area in tiles.
The tiles form one still WebP image, including for interactive or animated
artifacts. This avoids changing viewport-sized elements such as `100vh` while
retaining content below and to the right. Fixed and sticky elements repeat in
each tile. Content that grows while the tiles are captured gets
`screenshot_unavailable` instead of an incomplete image.

Tier 1 uses the same artifact-type layout rules as the gallery frame: Mermaid,
SVG, and chart roots are safely centered on both axes, with oversized content
remaining reachable by scrolling; Markdown is top-aligned in a horizontally
centered column capped at about 92ch; HTML and TSX use top-aligned document
flow, where a fixed-width layout can center itself with `mx-auto`. The renderer-parity gate
compares both the gallery and verifier renderer-module sets and CSS/stylesheet
sets.

Interactive TSX declares animated-capture eligibility; it does not imply that
the component is always visibly changing. CSS/Web Animations are probed, and
eligible captures may contain multiple WebP frames. Static artifacts retain a
single frame. Whole-artifact capture is downscaled to fit the axis,
decoded-pixel, and encoded-size bounds; it is never clipped. If the complete
image cannot fit the encoded cap, the verdict remains honest with
`screenshotError.code = screenshot_unavailable` rather than claiming a partial
capture.

Levels 0–2 record Tier 0 on publish. A Tier 1 run is explicit: visual
read-back records it on demand, then reuses the revision-bound result. A
browser or network-namespace failure records a Tier 1 `error` verdict with its
typed `tier1_*` code; it does not erase the Tier 0 verdict or turn visual
read-back into `revision_not_found`.

Tier 0 `ok` means the source passed structural checks; rendering is not
verified. The TTY presenter says `structure checked · rendering not verified`
and includes a visual read-back command. TSX Tier 0 reports `ok · compiled`.
The JSON envelope is unchanged. A malformed Mermaid fence returns `error` with
`mermaid_parse_error`, the parser message, and a zero-based `mermaid fence <i>`
location.

Tier 0 grammar-checks Mermaid fences but does not sanitize Mermaid label HTML;
it never renders a diagram. Sanitization happens in Tier 1, when Mermaid runs
in the real browser.

## Observed fields and renderer expectations

For Vega-Lite charts, Facet supplies 640×360 view defaults through
`config.view` only when the spec omits `autosize`, `config.view`, and both
top-level `width` and `height`. A supplied width or height is preserved while
the other dimension receives its default. An authored `config.view` or
`autosize` prevents defaulting. The composite-view defaults reach facet,
concat, and repeat children; author sizing is not replaced.

The canonical observed fields include `rendererRootSvgCount`, `graphCount`,
`mermaidNodeCount`, `visibleSvgCount`, `opaqueRegionCount`, `viewBoxes`,
`errorCount`, and `discriminativeErrors`. `opaqueRegionCount` counts DOM
regions whose contents are not structurally observable. This fixed observed
shape is carried by every artifact type; diagram counters are zero for types
without diagrams. HTML and static TSX report structure through `observed.html`.
Interactive TSX adds those counts after a visual check; Tier 0 does not predict
its interactive structure.

Renderer literals are `svg` and `canvas`. The `canvas` renderer is chart-only:
a canvas chart expects `rendererRootSvgCount = 0` and `opaqueRegionCount = 1`;
SVG renderers retain their structural root expectations.

HTML artifacts carry their own structural observable — `HtmlStructureCounts` —
anchored on the frame-owned `data-facet-renderer-root` wrapper. The fields
are `rendererRootCount`, `headingCount`, `tableCount`, `listCount`,
`imageCount`, `canvasCount`, and `externalImageCount`. The first is the
HTML analogue of `rendererRootSvgCount`; the rest are scoped beneath the
marker. See the [HTML reference](html.md) for the verdict claim these
counts support and the precedence over `partial:opaque_content` and
`partial:external_resources`.

## Tier 0 vs Tier 1 channels for HTML

Tier 0 is a WHATWG parser (`parse5@8.0.1`, `scriptingEnabled: false`)
running in the existing netns worker with no egress. It produces the
structural prediction that is stored with the revision SHA and forwarded
to Tier 1. The parser handles every recovery family that the differential
corpus accepts; three families — UTF-8 encoding ambiguity, `<select>`
containing table-scoped markup, and nesting depth beyond the cap — are
rejected before Tier 1 ever runs.

Tier 1 is `chrome-headless-shell` `151.0.7922.77` inside its netns,
rendering the artifact through the gallery's vendored HTML renderer. It
observes the rendered DOM through CDP protocol authority, not the page
shim, and computes its own `HtmlStructureCounts` from the snapshot.
Agreement on every field is `ok`; disagreement is `tampered`.

The two channels are independent: one parses bytes with no egress, the
other renders in a browser. Their expected-vs-observed comparison is
what makes an HTML verdict a real prediction rather than a self-claim.

An HTML Tier 0 response is a normal publish/read-back verdict, for example:

```json
{
  "status": "ok",
  "tier": 0,
  "artifactId": "art-123",
  "revisionSha": "<sha256>",
  "observed": { "htmlElementCount": 4, "htmlTextNodeCount": 2 }
}
```

The differential corpus at `tests/acceptance/html-differential.test.ts`
is the live gate that keeps the two parsers in agreement over a body
of real documents. Any divergence in the corpus is a design input
(shrink the accepted input set), never a verdict-comparison weakening.

## TSX modes

Tier 0 compiles TSX after direct AST-policy checks. Static output enters the
HTML pipeline above. Interactive output runs in the nested artifact frame and
is observed through CDP snapshot, `getDocument`, and isolated-world channels at
the render barrier and after the one-second stability window. There is no SSR or
hydration expectation. `partial:unstable` records a changed structure; channel
divergence remains `tampered`.

Theme switching affects gallery Tier 2 display only. Tier 1 structural
verdicts and captures remain dark-theme parity behavior so counts and layout
comparisons are stable across display preferences.

## Retention policy

Last-N retention runs INSIDE `recordRenderRun`'s write path. The
canonical knob is `EVIDENCE_LAST_N_PER_ARTIFACT` (default 10); the
policy keeps the N most recent non-retained runs per artifact and
unlinks the on-disk evidence of everything older.

Retained-evidence carve-out: a row marked `retained: true` is exempt
from the cutoff. Pin and template call sites set the flag (Task 14
wires them); the cleanup walker skips `retained = 1` rows.

Cleanup is best-effort: a row is the authoritative state, a stale
file is recoverable by the next orphan sweep. A failed `INSERT` runs
the converse cleanup — any caller-supplied `screenshotPath` /
`consolePath` is unlinked so no orphan pixels accumulate.

Retention controls evidence files, not read-back payload history. Read-back
reconstructs a revision-bound verdict from its stored render-run row; an
evicted screenshot or console path is intentionally not returned as bytes.

## Revision-binding guarantee

Every `read-back` response is bound to the EXACT `(artifactId,
revisionSha)` the caller supplied. The lookup
(`repository.getRevisionBySha`) is keyed on both columns; a stale or
mismatched sha returns `revision_not_found` BEFORE any verdict row is
read, so two revisions to the same artifact can never cross-pollinate
their verdicts.

The dispatcher enriches every Tier 1 verdict with the real
`artifactId` + `revisionSha` it is committing (the worker runs out of
process and does not know the artifactId). Read-back returns the
enriched verdict — never the worker's placeholder identity.

## Layering

Insecure execution conditions are metadata: every insecure-level verdict carries a `Verdict.insecure` marker with the effective level and reason, but verdict derivation never consumes that marker.
Level 3 additionally produces the `insecure:unvalidated` status.

```
shared/contracts/validation.ts   VerdictSchema, RenderStatus, and Tier 1 refinements
shared/contracts/artifact.ts     RenderRunSchema and screenshot error metadata
service/store/schema.ts          additive v2–v9 schema fragments
service/store/migrations.ts      transactional migration application
service/store/evidence-retention.ts
                                  last-N cleanup and 0700 directory enforcement
service/store/repository.ts      render-run persistence and cleanup-on-failure
service/dispatcher.ts            revision binding and screenshot-path handoff
validation/tier1/runner.ts       post-verdict capture and evidence paths
```
