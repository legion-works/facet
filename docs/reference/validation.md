# Validation reference

The tiered validation contract every read-back response is bound to.
Covers the `RenderStatus` taxonomy, what evidence each tier persists,
the retention policy, and the revision-binding guarantee.

## Tier taxonomy

`RenderStatus` is the closed enum the verifier assigns to one run. The
verdict is decided in exactly one place (`src/validation/tier1/verdict.ts`).
Every other layer is bound to it through `VerdictSchema.status`.

| status                      | meaning                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ok`                        | Counts agree across protocol + shim + isolated worlds, layout observable, no discriminative errors.                                                                            |
| `error`                     | Counts disagree with the lexical expectation OR the protocol surfaced a discriminative error.                                                                                  |
| `partial:layout_unverified` | Counts agree but the layout pass is unverified (no SVG rendered with a non-degenerate viewBox). MUST carry a screenshot path on the wire.                                      |
| `partial:opaque_content`    | An opaque DOM region was observed, so structural contents were not verified. MUST carry a screenshot path, or a typed `screenshotError` marker when capture fails transiently. |
| `tampered`                  | Page-shim or isolated-world observation diverges from protocol authority.                                                                                                      |
| `timeout`                   | The harness did not emit `render-complete` within `TIER1_RENDER_BARRIER_MS`.                                                                                                   |
| `shim_only`                 | Isolated-world channel missing; only the untrusted page-shim produced usable counts.                                                                                           |
| `probe_only`                | Both the page-shim and the isolated-world channel are missing; only the protocol channel is usable.                                                                            |

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
`partial:layout_unverified` and `partial:opaque_content` screenshot mandates are honored. The runner
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

```
shared/contracts/validation.ts   canonical VerdictSchema + RenderStatus
                                 + Tier1Result refine (partial-screenshot)
shared/contracts/artifact.ts     RenderRunSchema adds `retained` and `screenshotErrorJson`
service/store/schema.ts          V2_SCHEMA_FRAGMENT, V3_SCHEMA_FRAGMENT, V4_SCHEMA_FRAGMENT
service/store/migrations.ts      additive v2, v3, and v4 migrations
service/store/evidence-retention.ts
                                 last-N cleanup + 0700 directory ensure
service/store/repository.ts      recordRenderRun wires retention + cleanup-on-failure
service/dispatcher.ts            passes screenshotPath/consolePath through
validation/tier1/runner.ts       emits paths; captures post-verdict
```
