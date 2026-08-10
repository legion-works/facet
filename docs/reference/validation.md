# Validation reference

The tiered validation contract every read-back response is bound to.
Covers the `RenderStatus` taxonomy, what evidence each tier persists,
the retention policy, and the revision-binding guarantee.

## Tier taxonomy

`RenderStatus` is the closed enum the verifier assigns to one run. The
verdict is decided in exactly one place (`src/validation/tier1/verdict.ts`).
Every other layer is bound to it through `VerdictSchema.status`.

| status                       | meaning                                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                         | Counts agree across protocol + shim + isolated worlds, layout observable, no discriminative errors.                                                                                       |
| `error`                      | Counts disagree with the lexical expectation OR the protocol surfaced a discriminative error.                                                                                             |
| `partial:layout_unverified`  | Counts agree but the layout pass is unverified (no SVG rendered with a non-degenerate viewBox). MUST carry a screenshot path on the wire.                                                 |
| `partial:opaque_content`     | An opaque DOM region was observed, so structural contents were not verified. MUST carry a screenshot path, or a typed `screenshotError` marker when capture fails transiently.            |
| `partial:external_resources` | The artifact references external HTTPS images the no-egress verifier could not observe. MUST carry a screenshot path, or a typed `screenshotError` marker when capture fails transiently. |
| `tampered`                   | Page-shim or isolated-world observation diverges from protocol authority.                                                                                                                 |
| `timeout`                    | The harness did not emit `render-complete` within `TIER1_RENDER_BARRIER_MS`.                                                                                                              |
| `shim_only`                  | Isolated-world channel missing; only the untrusted page-shim produced usable counts.                                                                                                      |
| `probe_only`                 | Both the page-shim and the isolated-world channel are missing; only the protocol channel is usable.                                                                                       |
| `insecure:unvalidated`       | Level 3 intentionally skipped validation. The artifact is not represented as validated.                                                                                                   |

A `partial:*` verdict is a verdict the verifier could not finalize, NOT
a degraded `ok`. The screenshot is mandatory FOR `partial:` so a human
or a re-verifier can see what the verifier saw — it is not a thing
that upgrades the verdict. When capture fails transiently, the typed
`screenshotError` marker records that honest degraded path. A `partial:`
without a screenshot or marker is rejected at the schema parse boundary.

## Evidence captured per tier

| tier | evidence retained                                                                                                                                                                                                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | DB row only (expected + observed JSON, status, timing). No on-disk evidence.                                                                                                                                                                                                                                                       |
| 1    | DB row + per-run directory under `<evidence>/tier1/<revisionSha>/<runId>/`: `screenshot.png`, `console.txt`, `protocol-observation.json`. Screenshots use a deterministic 1280×800 viewport; capture requests the full artifact with `captureBeyondViewport`, then falls back to viewport-only when the PNG exceeds the 8 MiB cap. |

The evidence root is the XDG state path `paths.evidence` (or the
`FACET_HOME/evidence` override). Every directory the runner creates is
mode 0700 — the canonical secret-bearing layout matches the DB file
permissions.

Tier 1 capture happens AFTER the verdict is derived so the
`partial:layout_unverified`, `partial:opaque_content`, and `partial:external_resources` screenshot mandates are honored. The runner
uses a deterministic 1280×800 viewport, requests full-artifact capture
with `captureBeyondViewport`, and falls back to viewport-only when the
PNG exceeds the 8 MiB cap. Before capture it emulates
`prefers-reduced-motion: reduce` and awaits `document.fonts.ready`; these
pre-flights keep repeated captures byte-identical (perf-spike finding).

## Observed fields and renderer expectations

The canonical observed fields include `rendererRootSvgCount`, `graphCount`,
`mermaidNodeCount`, `visibleSvgCount`, `opaqueRegionCount`, `viewBoxes`,
`errorCount`, and `discriminativeErrors`. `opaqueRegionCount` counts DOM
regions whose contents are not structurally observable.

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

The differential corpus at `tests/acceptance/html-differential.test.ts`
is the live gate that keeps the two parsers in agreement over a body
of real documents. Any divergence in the corpus is a design input
(shrink the accepted input set), never a verdict-comparison weakening.

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
shared/contracts/validation.ts   canonical VerdictSchema + RenderStatus
                                 + Tier1Result refine (partial-screenshot)
shared/contracts/artifact.ts     RenderRunSchema adds `retained` and `screenshotErrorJson`
 service/store/schema.ts      V2_SCHEMA_FRAGMENT, V3_SCHEMA_FRAGMENT, V4_SCHEMA_FRAGMENT, V5_SCHEMA_FRAGMENT
 service/store/migrations.ts      additive v2, v3, v4, and v5 migrations
service/store/evidence-retention.ts
                                 last-N cleanup + 0700 directory ensure
service/store/repository.ts      recordRenderRun wires retention + cleanup-on-failure
service/dispatcher.ts            passes screenshotPath/consolePath through
validation/tier1/runner.ts       emits paths; captures post-verdict
```
