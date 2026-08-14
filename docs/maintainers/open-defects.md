# Open defects

None open. See "Fixed defects" for resolved issues with their root cause on
record.

# Fixed defects

## Mermaid labels missing inside markdown fences (fixed)

A ` ```mermaid ` fence inside a `markdown` artifact rendered shapes and edges
with no text labels. A standalone `.mmd` artifact rendered labels correctly in
the same gallery, same frame, same renderer module. Structure was correct and
every verdict passed: the gallery reported `nodes 6 · errors 0`, verdict `ok`.
Only the label text was absent, so no count- or status-based gate could see
it.

### Refuted — kept for history, do not re-test

Five hypotheses were tried and refuted before the root cause was found. All
of them assumed the bug lived in OUR code — the renderer, the sanitizer, or
the markdown round-trip. None of them considered the build pipeline that
produces the renderer bundle in the first place.

| #   | Hypothesis                                                     | Evidence against                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Render captured mid-flight, before labels are inserted         | `<text>` count 0 immediately AND 0 after 500 ms                                                                                                                                                                                                                                   |
| 2   | `htmlLabels` effectively true, `<foreignObject>` then stripped | `foreignObjectCount: 0`; `mermaid.initialize()` sets `htmlLabels:false` at root, flowchart, and class level (`mermaid.ts:47-53`) and both paths call the same `ensureMermaidInitialized()`                                                                                        |
| 3   | The SVG sanitizer removes `<text>`                             | `sanitizeSvgDocument` strips by denylist (`STRIPPED_TAGS`, `svg.ts:39-53`); `text` is not a member                                                                                                                                                                                |
| 4   | The scratch host is detached, so mermaid cannot measure text   | Attaching the scratch to the live `ownerDocument.body` changed nothing. `renderMermaidInto` calls `mermaid.render()` _before_ `importSanitizedSvgText` appends to the container, so the container cannot affect measurement — mermaid measures inside its own `d<id>` sandbox div |
| 5   | The markdown round-trip mangles the fence source               | `marked.parse` escapes to `&quot;` entities and `code.textContent` decodes them back; the fence is byte-identical after decode and the `%%{init:...}%%` directive survives. The standalone templates carry the same directive                                                     |

A sixth working hypothesis from the same investigation — that
`markdown.ts`'s `<template>` forces an implicit cross-document adopt when
`pre.replaceWith(svg)` runs, and that adopt drops the label subtree — was
also tested directly and refuted: swapping `<template>` for a private
`DOMParser` document (so the SVG crosses via an explicit `importNode` instead
of an implicit adopt) left the defect unchanged. The raw `mermaid.render()`
output already had zero `<text>` elements before any of the renderer's own
DOM assembly ran.

### Root cause

`scripts/build-gallery.ts` built each frame entry (`chart`, `html`,
`markdown`, `mermaid`, `svg`, `tsx`) through a **separate `Bun.build()` call**
in a loop, each with `splitting: true`. Mermaid is reached from two of those
entries: `mermaid.ts`'s own top-level static import, and `markdown.ts`'s
dynamic `import("./mermaid")` (kept lazy so plain markdown without a fence
never pays Mermaid's multi-megabyte load cost — that contract is pinned by
`tests/integration/renderer-bundle-parity.test.ts`).

Because each entry point ran through its own independent `Bun.build()`
invocation, Mermaid's dependency graph — including its own internal
lazy-loaded per-diagram-type modules (the `flowDiagram-*.js` /
`sequenceDiagram-*.js` style chunks bun's `splitting` mode extracts) — was
tree-shaken and re-bundled **twice**, once per invocation. The two resulting
copies were not byte-identical. The copy reached through `markdown.ts`'s
build silently dropped every flowchart label in `mermaid.render()`'s own
returned SVG string — confirmed live by capturing the raw SVG via a patched
`DOMParser.prototype.parseFromString` before any of the renderer's own
sanitize/import code ran. The copy reached through `mermaid.ts`'s own entry
did not. A sequence diagram in the same markdown document was unaffected in
either build, which is why the original "control" comparisons (standalone
`.mmd` vs. fenced) never caught it — the wrong pair of artifact types was
being compared. The correct control is diagram TYPE (flowchart vs.
sequence) within the SAME markdown document, not artifact type (markdown vs.
mermaid).

This was proven, not inferred: swapping the dynamic import for a static one
(same two independent `Bun.build()` calls, no lazy boundary) still failed
the same way, ruling out dynamic-vs-static import as the cause. Removing
`marked` entirely from `markdown.ts` and calling `renderMermaidInto` directly
(bypassing every line of the markdown-specific renderer) still failed the
same way, ruling out the markdown assembly code, the `<template>`/DOMParser
choice, and the `marked` dependency (which, incidentally, Mermaid also
bundles at a different pinned version in its own nested `node_modules`).
Adding a fixed delay before the call ruled out a load-order race. The single
variable that flipped the result was which `Bun.build()` invocation produced
the Mermaid dependency graph the call executed against.

### Fix

`scripts/build-gallery.ts` now builds all frame entries through **one**
`Bun.build()` call (`buildFrameEntries`, multiple `entrypoints`) instead of
one call per artifact type. `splitting: true` still applies — the lazy
`import("./mermaid")` boundary in `markdown.ts` is untouched, and plain
markdown without a fence still does not load Mermaid — but Mermaid's shared
dependency graph now gets exactly one tree-shaking pass and one set of lazy
diagram-type chunks, reused by both entries that reach it. There is nothing
left to diverge because there is only one build of the shared code.

`src/gallery-web/frame/renderers/markdown.ts` is unchanged from before the
fix (verified byte-identical); the defect was entirely in the build
pipeline, not the renderer.

### Discriminating test

`tests/acceptance/gallery-markdown-mermaid-labels.test.ts`, registered in the
`acceptance` matrix (`.github/workflows/ci.yml`). It renders a markdown
artifact with TWO fences — a flowchart (the discriminator; its labels are
plain bracket text, so it is not a markdown-formatting edge case) and a
sequence diagram (the control; it stayed correct even at the broken commit)
— through the real gallery service (`dist/gallery`, not the Tier 1 harness
bundle, which never reproduced this defect because its own `Bun.build`
invocation is unaffected by per-artifact-type splitting). It asserts the
actual label TEXT CONTENT of each rendered `<text>` element, not a count or
verdict status — the broken render already reported `nodes 6 · errors 0 ·
ok`.
