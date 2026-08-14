# Gallery Friction Teardown Implementation Plan

> **For agentic workers:** Execute this plan with the `icetea-loop` skill (implement→review→fix per task); for multi-session plans add `plan-checkpoints` for the verification ledger. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the gallery display ceremony with one fresh same-origin unsandboxed iframe per revision, rendered through a direct promise API, while preserving double-buffered failure behavior, data-path continuity, Tier 1 authority, and the shipped scroll/zoom model.

**Architecture:** Each type-specific frame bundle installs `window.__facetFrame.render(payload): Promise<RenderResult>` in its own iframe realm. The shell mounts a fresh hidden iframe, waits for `load`, calls that API directly, transfers view state only after a successful render, swaps visibility, and removes the old iframe last; interactive TSX mounts in that same realm and dies with it. The service remains byte-dumb and continues to own bootstrap/session/lease/source/SSE/verdict data, while the gallery frame route becomes an ordinary same-origin document under a restrictive `self` CSP plus `blob:` only for compiled interactive TSX modules.

**Tech Stack:** Bun 1.3.14, TypeScript, DOM/iframe APIs, Bun.build, React compiled TSX bundles, CDP-pipe acceptance tests, GitHub Actions.

## Global Constraints

- HEAD baseline is `d57a7db46cc87f1a865141f7b0931fb490fd3869`; verify it before execution or re-ground line anchors against the new HEAD.
- Facet is local-only. Remove display-path security ceremony only; loopback bind, Host-header checks, bearer authorization on mutations, bootstrap consumption, gallery leases, and lease renewal remain unchanged.
- Keep the service byte-dumb: no renderer/parser imports under `src/service/**`; `zod` must not enter `src/gallery-web/frame/**`.
- Keep Tier 1's harness, netns, CDP protocol probes, gate-forgery tests, egress tests, stored service-derived verdict, and shell-owned verdict badge unchanged except for renderer-bundle parity imports forced by the gallery runtime split.
- Bun 1.3.14 permits one direct CDP-pipe launch per acceptance test process. Every new acceptance file must contain one `PuppeteerTier1Browser` construction and one `launch()` call at most.
- Preserve templates, stored artifacts, verdicts, evidence, SSE delivery, refresh/session re-attach from `f12d804`, and lease renewal from `0acdd76`/`c72177d`; the display path changes, not the data path.
- Preserve the shipped view model: zoom changes artifact element size; pan changes the frame document's scroll position; never mutate an SVG `viewBox`, CSS-transform the iframe, center the artifact, or cap its size.
- Shell/frame CSP must not contain blanket `'unsafe-inline'`; compiled interactive TSX is the sole reason for `blob:` in `script-src`.
- Run the gate sequence in the order written under every task. The pre-change unit+integration baseline is 1,076 passing tests; later count changes must be explained only by the explicit obsolete-test deletions in Task 7.
- Commit each task separately. Do not combine test deletion with unrelated implementation changes.

## File Structure

- `src/gallery-web/frame/runtime.ts` — new frame-realm API, payload/result contracts, renderer dispatch, page-shim observation, same-realm view-state application, and frame-local gesture binding.
- `src/gallery-web/frame/renderers/tsx.ts` — direct interactive TSX mount and blob-module execution in the artifact iframe; no nested iframe/srcdoc/CSP generation.
- `src/gallery-web/frame/styles/frame.css` — external base document/stage styles formerly emitted inline by `buildFrameDocument`.
- `src/gallery-web/frame/styles/artifact.css` — one built external copy of the vendored artifact vocabulary used by HTML and TSX frame documents.
- `src/gallery-web/frame-html.ts` — deterministic same-origin frame attributes/document HTML; no sandbox, nonce, handshake query, inline styles, or srcdoc bootstrap.
- `src/gallery-web/app.ts` — shell iframe lifecycle, direct API invocation, double-buffered promise swap, shell controls, SSE handoff, and stored-verdict chrome.
- `src/gallery-web/swap.ts` — pure swap ordering without channel-specific steps.
- `scripts/build-gallery.ts` — type-specific runtime bundles plus stable external frame styles.
- `src/service/router.ts` — ordinary restrictive gallery/frame CSP and simplified frame route; API/source/lease/SSE branches remain unchanged.
- `tests/helpers/gallery-live.ts` — same-origin artifact-world, viewport, geometry, and screenshot helpers.
- `tests/fixtures/gallery-geometry/*` — deterministic wide, tall, long, responsive, and canvas fixtures.
- `tests/acceptance/gallery-viewport-geometry.test.ts` — one browser launch covering both required viewports and all five recorded geometry failures.

---

### Task 1: Lock the direct frame contract and failure semantics

**Files:**

- Create: `src/gallery-web/frame/runtime.ts`
- Modify: `src/gallery-web/frame/renderers/registry.ts:22-32,108-232`
- Modify: `src/gallery-web/frame/entries/{markdown,mermaid,svg,chart,html,tsx}.ts:1-6`
- Test: `tests/unit/gallery-frame-runtime.test.ts`
- Test: `tests/integration/gallery-sse.test.ts:394-501,713-1048`

**Interfaces:**

- Consumes: `RendererRegistry`, `dispatchRender(...)`, and `countPageShim()` from `src/gallery-web/frame/renderers/registry.ts`.
- Produces:

```ts
export interface FrameRenderPayload {
  readonly artifactType: string;
  readonly renderer: string;
  readonly bytes: Uint8Array | string;
  readonly execution?: TsxExecutionMode;
}

export interface FrameViewState {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

export interface RenderResult {
  readonly observed: PageShimCounts;
  readonly viewMode: "native" | "css";
  readonly applyViewState: (state: FrameViewState) => void;
  readonly readViewState: () => FrameViewState;
}

export interface GalleryFrameApi {
  render(payload: FrameRenderPayload): Promise<RenderResult>;
}

export function installGalleryFrameApi(registry: RendererRegistry): void;
```

- Produces: `window.__facetFrame: GalleryFrameApi`, installed by every type entry in the iframe's own JavaScript realm.

- [ ] **Step 1: Write the RED contract tests**

Add tests that create a frame-realm DOM, install a one-renderer registry, and assert:

```ts
expect(window.__facetFrame).toBeDefined();
const result = await window.__facetFrame!.render(payload);
expect(result.observed.errorCount).toBe(0);
expect(typeof result.applyViewState).toBe("function");
await expect(window.__facetFrame!.render(payload)).rejects.toThrow(/already rendered/);
```

Mutate the `gallery-sse` swap-plan expectations from channel steps to the new ordering:

```ts
["build-new", "load-new", "render-new", "swap", "apply-view-state", "remove-old"];
```

- [ ] **Step 2: Prove RED against the current architecture**

Run: `bun test tests/unit/gallery-frame-runtime.test.ts tests/integration/gallery-sse.test.ts`

Expected: FAIL because `runtime.ts`, `window.__facetFrame`, and the direct render result do not exist; current swap steps still include `open-new-control` and `close-old-control`.

- [ ] **Step 3: Implement the one-shot direct API in the frame realm**

Move payload decoding and renderer dispatch from `src/gallery-web/frame/bootstrap.ts:48-102,224-260` into `installGalleryFrameApi`. Keep validation byte-dumb/plain-JS: use existing `validateRenderer`, `isTsxExecutionMode`, and `FacetRenderError`; do not import zod. `render()` must reject malformed payloads, reject a second call, append a `data-facet-error` marker on renderer failure, and reject the promise after recording the marker so the shell can keep the previous frame.

Return `countPageShim()` only after `dispatchRender()` settles. Keep the result object realm-owned; do not import a renderer into `app.ts` or pass a cross-document element to a shell-realm renderer.

- [ ] **Step 4: Point all six gallery entries at `installGalleryFrameApi`**

Each entry keeps its current type-specific registry and calls:

```ts
installGalleryFrameApi(createRendererRegistry([["svg", renderSvgDocument]]));
```

Use the corresponding existing renderer for each type. Do not change `src/validation/tier1/entries/*.ts`.

- [ ] **Step 5: Prove GREEN and the one-shot mutation**

Run: `bun test tests/unit/gallery-frame-runtime.test.ts tests/integration/gallery-sse.test.ts`

Expected: PASS. Then temporarily remove the `rendered` latch in `installGalleryFrameApi`, rerun `tests/unit/gallery-frame-runtime.test.ts`, and verify the second-render assertion FAILS. Restore the latch before committing.

- [ ] **Step 6: Run the task gate**

```bash
bun test tests/unit tests/integration
bun run build
bun scripts/check-renderer-bundle-parity.ts
bun run verify-adapter-size
bun run typecheck
bun run lint
bun run format:check
bun run check:boundaries
bun run perf-gate -- --record
```

Expected: all commands PASS; the first command reports the current post-edit total with no unexplained loss from the 1,076-test baseline; perf output records `publish → visible p95` for the before/after ledger.

- [ ] **Step 7: Commit**

```bash
git add src/gallery-web/frame/runtime.ts src/gallery-web/frame/renderers/registry.ts src/gallery-web/frame/entries tests/unit/gallery-frame-runtime.test.ts tests/integration/gallery-sse.test.ts
git commit -m "refactor(gallery): define direct frame render API"
```

**Implementer trap:** A function imported into the shell and called with `iframe.contentDocument` is not equivalent. Mermaid, Markdown, SVG, and DOMPurify touch realm globals; the renderer call must originate from the frame bundle installed inside that iframe.

---

### Task 2: Mount interactive TSX directly in the artifact iframe

**Files:**

- Modify: `src/gallery-web/frame/renderers/tsx.ts:1-80`
- Modify: `src/shared/tsx/execution.ts:24-32`
- Modify: `src/gallery-web/frame/entries/tsx.ts:1-5`
- Test: `tests/unit/tsx-renderer.test.ts:29-95`
- Test: `tests/acceptance/gallery-interactive-tsx.test.ts:1-58`
- Test: `tests/acceptance/gallery-tsx-styles.test.ts:1-84`
- Test: `tests/acceptance/gallery-tsx-styles-templates.test.ts:1-180`

**Interfaces:**

- Consumes: interactive compiled bytes produced by `compileTsxAtWorkRoot()` in `src/validation/tier0/tsx/compiler.ts:67-154`; those bytes already include React, `createRoot`, and a lookup for `#facet-tsx-mount`.
- Produces: `renderTsx(...)` that creates `<main id="facet-tsx-mount" data-facet-renderer-root="true">` in `ctx.container`, imports one blob module, revokes its URL after module evaluation, and leaves React mounted until iframe removal.

- [ ] **Step 1: Rewrite unit expectations RED-first**

Replace nested-frame assertions with:

```ts
expect(container.querySelector("iframe")).toBeNull();
expect(container.querySelector("#facet-tsx-mount")).not.toBeNull();
expect(container.querySelectorAll("[data-facet-renderer-root='true']")).toHaveLength(1);
```

Add a test hook around `URL.createObjectURL`, dynamic import, and `URL.revokeObjectURL` so the unit proves one module execution and unconditional URL revocation. Remove tests for `buildInteractiveTsxSrcdoc`, nested nonce escaping, nested sandbox attributes, and `TSX_ARTIFACT_FRAME_ATTRIBUTE`.

- [ ] **Step 2: Prove RED**

Run: `bun test tests/unit/tsx-renderer.test.ts`

Expected: FAIL because the current renderer creates one sandboxed nested iframe and no direct mount.

- [ ] **Step 3: Implement direct same-realm interactive execution**

For `execution === "interactive"`:

```ts
const mount = ctx.container.ownerDocument.createElement("main");
mount.id = "facet-tsx-mount";
mount.setAttribute("data-facet-renderer-root", "true");
ctx.container.replaceChildren(mount);
const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
try {
  await import(url);
} finally {
  URL.revokeObjectURL(url);
}
```

Install frame-local `error` and `unhandledrejection` listeners before import; append a `data-facet-error` marker for post-mount runtime failures. Do not call `createRoot` in gallery code—the compiled artifact already does that at `compiler.ts:26-33`.

- [ ] **Step 4: Update gallery acceptance probes to use the artifact frame world**

Replace `nestedArtifactWorld(target)` with `artifactWorld(target)` in the three gallery-only acceptance files. Keep `resolveNestedArtifactFrame` and its Tier 1 callers unchanged: `src/validation/tier1/runner.ts:290`, `tests/acceptance/tsx-measurement.test.ts:336-421`, `tests/acceptance/tsx-nested-frame-selection.test.ts`, and `tests/unit/frame-target.test.ts` still verify the Tier 1 harness.

- [ ] **Step 5: Prove GREEN and nested-frame absence**

```bash
bun test tests/unit/tsx-renderer.test.ts
bun test tests/acceptance/gallery-interactive-tsx.test.ts
bun test tests/acceptance/gallery-tsx-styles.test.ts
bun test tests/acceptance/gallery-tsx-styles-templates.test.ts
```

Expected: all PASS; each acceptance probe executes in `/gallery/frame`, and the shell contains exactly one iframe total.

- [ ] **Step 6: Run the task gate**

```bash
bun test tests/unit tests/integration
bun run build
bun scripts/check-renderer-bundle-parity.ts
bun run verify-adapter-size
bun run typecheck
bun run lint
bun run format:check
bun run check:boundaries
bun run perf-gate -- --record
```

Expected: PASS; non-TSX renderer bundles remain React-free.

- [ ] **Step 7: Commit**

```bash
git add src/gallery-web/frame/renderers/tsx.ts src/shared/tsx/execution.ts src/gallery-web/frame/entries/tsx.ts tests/unit/tsx-renderer.test.ts tests/acceptance/gallery-interactive-tsx.test.ts tests/acceptance/gallery-tsx-styles.test.ts tests/acceptance/gallery-tsx-styles-templates.test.ts
git commit -m "refactor(gallery): mount interactive TSX in artifact frame"
```

**Implementer trap:** Do not evaluate compiled code with `eval`, `Function`, or an inline `<script>`. The settled CSP forbids them. Blob-module import is the narrow execution allowance, and URL revocation must happen after module evaluation—not before React imports finish.

---

### Task 3: Replace nonce/srcdoc frame documents with ordinary same-origin documents

**Files:**

- Create: `src/gallery-web/frame/styles/frame.css`
- Create: `src/gallery-web/frame/styles/artifact.css`
- Modify: `src/gallery-web/frame-html.ts:12-112`
- Modify: `scripts/build-gallery.ts:1-76`
- Modify: `src/service/router.ts:56-77,306-487`
- Modify: `src/gallery-web/app.ts:26-67,331-485`
- Test: `tests/integration/gallery-route.test.ts:110-173`
- Test: `tests/integration/gallery-frame-cold.test.ts:1-126`
- Test: `tests/integration/gallery-sse.test.ts:66-177,224-322,543-604`

**Interfaces:**

- Consumes: type-specific runtime outputs `/gallery/frame/runtime/markdown.js`, `mermaid.js`, `svg.js`, `chart.js`, `html.js`, and `tsx.js`.
- Produces: `buildFrameAttributes(src): { referrerpolicy: "no-referrer"; allow: ""; title: string; src: string }` with no `sandbox` property.
- Produces: `buildFrameDocument({ artifactType, runtimeUrl }): string` containing external stylesheet links, `<main id="artifact">`, and one external module script without nonce.
- Produces: CSP exactly equivalent to:

```text
default-src 'self'; script-src 'self' blob:; style-src 'self'; connect-src 'self'; img-src 'self' data: https:; font-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
```

- [ ] **Step 1: Mutate route/document tests to the new contract**

Assert `/gallery/frame?type=markdown` succeeds without `nonce`, returns the ordinary CSP, references `/gallery/frame/runtime/markdown.js`, has no `sandbox`, `nonce=`, `handshake=`, CSP meta, inline `<style>`, or inline script, and remains source-byte free. Assert HTML and TSX documents each link `/gallery/frame/artifact.css` exactly once; other types do not.

- [ ] **Step 2: Prove RED**

Run: `bun test tests/integration/gallery-route.test.ts tests/integration/gallery-frame-cold.test.ts tests/integration/gallery-sse.test.ts`

Expected: FAIL on the current nonce requirement, frozen per-frame CSP, sandbox attribute contract, bootstrap URL, and inline styles.

- [ ] **Step 3: Externalize frame styles and build stable assets**

Move the base rules from `buildFrameDocument()` at `frame-html.ts:61-81` into `frame.css`. Build/copy the 234KB vendored sheet once as `artifact.css`; remove the `with { type: "text" }` import from TSX and the CSS side-effect import from the HTML entry. `build-gallery.ts` must remove stale runtime/chunk/style outputs before building so a deleted old bundle cannot survive via mtime or a warm `dist/` directory.

- [ ] **Step 4: Simplify the service frame route without touching data routes**

Remove nonce parsing/substitution and the HTML-only stylesheet read from `router.ts:405-481`. Keep artifact-type validation and path traversal protection. Serve runtime/chunk/style assets same-origin without wildcard CORS; the opaque-origin reason for CORS is gone. Do not alter `ROUTE_BOOTSTRAP`, `ROUTE_RELEASE`, `ROUTE_SOURCE`, `ROUTE_API`, or `ROUTE_STREAM` branches at `router.ts:497-637`.

- [ ] **Step 5: Simplify frame creation**

Remove `nonce`, `handshakeNonce`, `MessageChannel`, transferred ports, and `sandbox` writes from `CreateArtifactFrameOptions`, `CreatedArtifactFrame`, `ShellDom`, and `createArtifactFrame()`. The URL retains only `type` and `renderer`; `assertLoopbackHostname()` remains before element creation.

- [ ] **Step 6: Prove GREEN and stale-dist recovery**

```bash
bun test tests/integration/gallery-route.test.ts
bun test tests/integration/gallery-frame-cold.test.ts
bun test tests/integration/gallery-sse.test.ts
```

Expected: PASS. `gallery-frame-cold` must delete `dist/gallery/frame/artifact.css`, request HTML and TSX frame documents, and prove build recovery without raw stack traces.

- [ ] **Step 7: Run the task gate**

```bash
bun test tests/unit tests/integration
bun run build
bun scripts/check-renderer-bundle-parity.ts
bun run verify-adapter-size
bun run typecheck
bun run lint
bun run format:check
bun run check:boundaries
bun run perf-gate -- --record
```

Expected: PASS; built frame HTML contains no inline executable/style content, and `publish → visible p95` is recorded.

- [ ] **Step 8: Commit**

```bash
git add src/gallery-web/frame/styles src/gallery-web/frame-html.ts scripts/build-gallery.ts src/service/router.ts src/gallery-web/app.ts tests/integration/gallery-route.test.ts tests/integration/gallery-frame-cold.test.ts tests/integration/gallery-sse.test.ts
git commit -m "refactor(gallery): serve ordinary same-origin artifact frames"
```

**Implementer trap:** `FROZEN_CSP_TEMPLATE` is still Tier 1 infrastructure. Remove gallery imports/re-exports of it, but do not delete or weaken `src/shared/security/frozen-csp.ts` or `src/validation/tier1/harness.ts`.

---

### Task 4: Execute the double-buffered swap through direct promises

**Files:**

- Modify: `src/gallery-web/app.ts:382-677,845-1054`
- Modify: `src/gallery-web/swap.ts:1-70`
- Test: `tests/integration/gallery-sse.test.ts:394-501,606-1048`
- Test: `tests/integration/gallery-shell-start.test.ts:7-213,353-410`

**Interfaces:**

- Consumes: `contentWindow.__facetFrame.render(payload)` and its `RenderResult` from Task 1.
- Produces: `CreatedArtifactFrame` with `frameId`, `element`, `awaitLoad(timeoutMs)`, `render(payload, timeoutMs)`, and the successful `RenderResult` handle.
- Produces: `replaceArtifactFrame()` preserving `failedNewFrameReady`, with step order `build-new → load-new → render-new → swap → apply-view-state → remove-old`.

- [ ] **Step 1: Replace simulated-port tests with direct fake-frame promises**

The recording host must supply a fake iframe whose `contentWindow.__facetFrame.render` resolves, rejects, or never settles. Keep assertions that the new frame mounts hidden first, old stays visible on load/render timeout or rejection, new becomes visible before old is hidden, view state applies after render success, and old iframe removal is last.

- [ ] **Step 2: Prove RED**

Run: `bun test tests/integration/gallery-sse.test.ts tests/integration/gallery-shell-start.test.ts`

Expected: FAIL because production still waits on `boot-ready`/`render-complete` MessagePort events and the fakes expose a direct API instead.

- [ ] **Step 3: Implement load and render barriers**

Arm the iframe `load` listener before `mountOffScreen()`. On load, verify `contentWindow?.__facetFrame?.render` is a function, then invoke it with the exact fetched revision payload. Bound load and render independently with the existing 10,000ms default. On failure: show `new revision failed to render; keeping last good revision`, remove only the failed new iframe, and return the current frame.

- [ ] **Step 4: Preserve initial render and SSE swap behavior**

In `startGallery()`, fetch initial source, create/mount/load/render the first frame, show it, apply view state, then mark `displayed`. In `onCommit`, keep `fetchGallerySource(baseUrl, handoff, revisionSha, fetch)` and the existing status/swapbar/verdict transitions; change only the point where fetched bytes enter the new frame.

Immediately before each revision swap, copy `current.renderResult.readViewState()` into the shell-owned `viewState`; after the next frame's render promise resolves, call `next.renderResult.applyViewState(viewState)` before removing the old iframe. This is the direct replacement for control-port view transfer and is required for frame-local wheel/drag state to survive an SSE revision.

- [ ] **Step 5: Prove GREEN and failure mutation**

Run: `bun test tests/integration/gallery-sse.test.ts tests/integration/gallery-shell-start.test.ts`

Expected: PASS. Temporarily move `host.unmount(current.frameId)` before awaiting `next.render(...)`; rerun the `failed new render keeps the last-good frame` case and verify it FAILS. Restore correct ordering.

- [ ] **Step 6: Run the task gate**

```bash
bun test tests/unit tests/integration
bun run build
bun scripts/check-renderer-bundle-parity.ts
bun run verify-adapter-size
bun run typecheck
bun run lint
bun run format:check
bun run check:boundaries
bun run perf-gate -- --record
```

Expected: PASS; stage metrics still report frame-built/load/render/visible timestamps or their renamed direct equivalents.

- [ ] **Step 7: Commit**

```bash
git add src/gallery-web/app.ts src/gallery-web/swap.ts tests/integration/gallery-sse.test.ts tests/integration/gallery-shell-start.test.ts
git commit -m "refactor(gallery): swap revisions through direct frame promises"
```

**Implementer trap:** `iframe.contentWindow` is usable only after `load`. Calling `render` immediately after `appendChild` races the runtime bundle and recreates the old boot flake under a different name.

---

### Task 5: Unify zoom, pan, and gesture handling inside the frame document

**Files:**

- Modify: `src/gallery-web/frame/runtime.ts`
- Modify: `src/gallery-web/app.ts:932-965,976-984,1073-1205`
- Modify: `src/gallery-web/view-state.ts:1-162`
- Modify: `src/gallery-web/styles/app.css:117-149`
- Test: `tests/unit/gallery-view-state.test.ts`
- Test: `tests/integration/gallery-shell-start.test.ts:353-410`
- Test: `tests/acceptance/gallery-mermaid-natural.test.ts:14-113`
- Test: `tests/acceptance/gallery-html-scroll.test.ts:14-90`

**Interfaces:**

- Consumes: `RenderResult.applyViewState()` and `RenderResult.readViewState()`.
- Produces: frame-realm view application that resizes a direct root SVG to `ceil(naturalWidth * zoom)` and sets `document.scrollingElement.scrollLeft/scrollTop`; CSS/HTML/TSX/canvas modes resize their artifact root without transforming the iframe.

- [ ] **Step 1: Write RED assertions for the shipped model**

Assert shell iframe `style.transform === ""`, zoom changes artifact root width, pan changes frame-document scroll offsets, reset restores zoom 1 and scroll offsets 0, and the frame remains top-left with unconstrained overflow. Remove `ViewIntent`, `validateViewIntent`, `validateViewMode`, `clampCssPan`, and `clampNativeSvgPan` tests that existed only for cross-frame forwarding/camera modes; retain `clampZoom`, `resetViewState`, and `zoomAtPoint` if still used by shell controls.

- [ ] **Step 2: Prove RED**

Run: `bun test tests/unit/gallery-view-state.test.ts tests/integration/gallery-shell-start.test.ts`

Expected: FAIL because current shell CSS-transforms non-native frames and current frame receives view state over a control port.

- [ ] **Step 3: Move view application into `RenderResult`**

After renderer completion, cache the direct artifact root and its natural geometry in the frame realm. `applyViewState` must use frame-realm constructors and globals. Bind `wheel`, pointer drag, and keyboard-independent gesture listeners directly on the frame document; update the result's internal state and scroll the document. The shell's toolbar/keyboard controls call `result.applyViewState(nextState)` directly.

- [ ] **Step 4: Remove shell transform/cross-frame forwarding code**

Delete `viewModes`, `bindFrameMode`, `bindFrameIntents`, `sendControl(viewStateMessage(...))`, and iframe transform writes from `startGallery()`. Keep the shell's zoom buttons, reset button, fullscreen control, revision badge, and status chrome. Update `#facet-canvas`/iframe CSS so the iframe fills the stage and the frame document—not the shell stage—owns overflow.

- [ ] **Step 5: Prove GREEN and camera-model mutation**

```bash
bun test tests/unit/gallery-view-state.test.ts tests/integration/gallery-shell-start.test.ts
bun test tests/acceptance/gallery-mermaid-natural.test.ts
bun test tests/acceptance/gallery-html-scroll.test.ts
```

Expected: PASS. Temporarily set `iframe.style.transform = scale(...)` in the shell and rerun `gallery-mermaid-natural.test.ts`; verify its geometry/scroll assertion FAILS, then revert.

- [ ] **Step 6: Run the task gate**

```bash
bun test tests/unit tests/integration
bun run build
bun scripts/check-renderer-bundle-parity.ts
bun run verify-adapter-size
bun run typecheck
bun run lint
bun run format:check
bun run check:boundaries
bun run perf-gate -- --record
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/gallery-web/frame/runtime.ts src/gallery-web/app.ts src/gallery-web/view-state.ts src/gallery-web/styles/app.css tests/unit/gallery-view-state.test.ts tests/integration/gallery-shell-start.test.ts tests/acceptance/gallery-mermaid-natural.test.ts tests/acceptance/gallery-html-scroll.test.ts
git commit -m "fix(gallery): keep zoom and pan in the frame document"
```

**Implementer trap:** The document scroller may be `document.scrollingElement`, not `#artifact`. Pin one owner and test it at both viewports; mixing the two produces scrollHeight values that look correct while wheel/pan moves the wrong element.

---

### Task 6: Remove dead channel, nonce, handshake, and nested-frame production machinery

**Files:**

- Delete: `src/gallery-web/frame/channels.ts`
- Delete: `src/gallery-web/frame/bootstrap.ts`
- Modify: `src/gallery-web/frame-html.ts`
- Modify: `src/gallery-web/app.ts`
- Modify: `src/validation/tier1/harness.ts:47-125`
- Create: `src/validation/tier1/nonce.ts`
- Modify: `src/shared/tsx/execution.ts:24-32`
- Test: `tests/unit/boundaries.test.ts`
- Test: `tests/integration/gallery-sse.test.ts`

**Interfaces:**

- Consumes: no gallery callers of `createChannelPair`, `freshFrameNonce`, `startGalleryFrame`, `buildInteractiveTsxSrcdoc`, or `TSX_ARTIFACT_FRAME_ATTRIBUTE` after Tasks 1-5.
- Produces: Tier 1-local `freshHarnessNonce(): string` used only by `src/validation/tier1/harness.ts`; no gallery security ceremony remains.

- [ ] **Step 1: Confirm callers before deletion**

Run the call-graph checks:

```text
createChannelPair → no production caller
freshFrameNonce → Tier 1 harness only
buildInteractiveTsxSrcdoc → no caller
TSX_ARTIFACT_FRAME_ATTRIBUTE → Tier 1 frame selection must not depend on the shared gallery constant
```

If any production caller remains, stop and finish the preceding task rather than preserving a compatibility shim.

- [ ] **Step 2: Move nonce generation to Tier 1 and delete dead files/symbols**

`freshHarnessNonce()` keeps the existing 16-byte cryptographic format for frozen CSP substitution. Remove gallery exports/comments mentioning opaque origins, nonce windows, transferred ports, source ingress, control ports, handshakes, and srcdoc.

- [ ] **Step 3: Add negative source assertions**

In `gallery-sse.test.ts`, scan `src/gallery-web/**` and assert absence of `MessageChannel`, `facetHandshake`, `handshakeNonce`, `frameIngressPort`, `frameControlPort`, `srcdoc`, `allow-scripts`, and `TSX_ARTIFACT_FRAME_ATTRIBUTE`. Scope the scan to gallery production files so Tier 1's independent harness machinery is not falsely prohibited.

- [ ] **Step 4: Verify deletion**

Run: `bun test tests/integration/gallery-sse.test.ts tests/unit/boundaries.test.ts`

Expected: PASS and no import-resolution diagnostics.

- [ ] **Step 5: Run the task gate**

```bash
bun test tests/unit tests/integration
bun run build
bun scripts/check-renderer-bundle-parity.ts
bun run verify-adapter-size
bun run typecheck
bun run lint
bun run format:check
bun run check:boundaries
bun run perf-gate -- --record
```

Expected: PASS; `check:boundaries` prints `service boundary clean`.

- [ ] **Step 6: Commit**

```bash
git add -A src/gallery-web src/validation/tier1 src/shared/tsx tests/integration/gallery-sse.test.ts tests/unit/boundaries.test.ts
git commit -m "refactor(gallery): remove display channel ceremony"
```

**Implementer trap:** Do not delete `src/shared/security/frozen-csp.ts`, `resolveNestedArtifactFrame`, or Tier 1's nested interactive TSX harness. Similar words do not mean the same trust boundary.

---

### Task 7: Delete obsolete architecture tests and mutate surviving contracts

**Files:**

- Delete: `tests/acceptance/nested-frame-denials.test.ts`
- Delete: `tests/acceptance/tsx-interactive-isolation.test.ts`
- Modify: `tests/integration/gallery-sse.test.ts`
- Modify: `tests/integration/gallery-route.test.ts`
- Modify: `tests/integration/gallery-frame-cold.test.ts`
- Modify: `tests/integration/gallery-shell-start.test.ts`
- Modify: `tests/acceptance/gallery-render.test.ts:31-174`
- Modify: `tests/helpers/gallery-live.ts:21-127`
- Modify: `.github/workflows/ci.yml:273-319`

**Interfaces:**

- Consumes: direct same-origin frame and one-iframe TSX contract from Tasks 1-6.
- Produces: an explicit test inventory with no assertions for machinery that no longer exists.

- [ ] **Step 1: Delete only tests whose subject was removed**

Delete `nested-frame-denials.test.ts` because its entire subject is the removed nested sandbox/srcdoc CSP boundary. Delete `tsx-interactive-isolation.test.ts` because its subject is nonce/handshake rejection and opaque nested TSX isolation. Remove both matrix entries from `ci.yml`. Record this justification in the commit body; these are not deletions made to silence failures.

- [ ] **Step 2: Mutate surviving tests to the new contract**

- `gallery-sse.test.ts`: keep fresh-frame, render-before-swap, old-frame-on-failure, view-state transfer, no-zod, loopback-hostname, and SSE publish tests; remove channel lifecycle, nonce freshness, control-event validation, and handshake source-shape tests.
- `gallery-route.test.ts`: keep path traversal, artifact-type validation, source lease/auth, bootstrap, and route recovery; replace nonce/CORS assertions with same-origin runtime/CSP assertions.
- `gallery-frame-cold.test.ts`: keep cold-dist/no-stack-leak behavior; key recovery to external `frame.css`/`artifact.css`, not nonce-bound HTML.
- `gallery-shell-start.test.ts`: keep verdict chrome, refresh-preserving unload behavior, controls, first render, and stream closure; replace fake MessageChannels with fake iframe API promises.
- `gallery-render.test.ts`: rename “opaque frame” to “same-origin artifact frame”; assert `iframe.sandbox.length === 0`, `iframe.contentDocument` is readable, one iframe exists, and canvas is rendered in that document.
- `gallery-live.ts`: remove `nestedArtifactWorld`; keep `artifactFrame` and `artifactWorld`.

- [ ] **Step 3: Mark tests that MUST NOT change**

Do not edit behavior or expected verdicts in:

```text
tests/acceptance/csp-consumer-baseline.test.ts
tests/acceptance/gate-forgery.test.ts
tests/acceptance/egress.test.ts
tests/acceptance/tsx-runtime-egress.test.ts
tests/acceptance/tsx-measurement.test.ts
tests/acceptance/tsx-nested-frame-selection.test.ts
tests/unit/frame-target.test.ts
src/validation/tier1/**
```

Parity-import adjustments are handled in Task 9, not by weakening these tests.

- [ ] **Step 4: Run affected acceptance files individually**

```bash
bun test tests/acceptance/gallery-render.test.ts
bun test tests/acceptance/gallery-interactive-tsx.test.ts
bun test tests/acceptance/gallery-static-tsx.test.ts
bun test tests/acceptance/gallery-tsx-styles.test.ts
bun test tests/acceptance/gallery-tsx-styles-templates.test.ts
bun test tests/acceptance/csp-consumer-baseline.test.ts
bun test tests/acceptance/gate-forgery.test.ts
bun test tests/acceptance/egress.test.ts
bun test tests/acceptance/tsx-runtime-egress.test.ts
bun test tests/acceptance/tsx-measurement.test.ts
bun test tests/acceptance/tsx-nested-frame-selection.test.ts
```

Expected: all PASS; deleted files are absent from the CI matrix.

- [ ] **Step 5: Run the task gate**

```bash
bun test tests/unit tests/integration
bun run build
bun scripts/check-renderer-bundle-parity.ts
bun run verify-adapter-size
bun run typecheck
bun run lint
bun run format:check
bun run check:boundaries
bun run perf-gate -- --record
```

Expected: PASS; the reduced unit+integration count is explainable by the enumerated removed `gallery-sse` architecture cases only.

- [ ] **Step 6: Commit**

```bash
git add -A tests .github/workflows/ci.yml
git commit -m "test(gallery): replace sandbox ceremony with direct-frame contracts" -m "Deletes only nested-frame and handshake isolation gates whose production machinery was removed; Tier 1 authority, forgery, egress, and consumer baselines remain intact."
```

**Implementer trap:** A failing Tier 1 or egress test is not obsolete merely because it mentions frames or CSP. Delete only the two display-only tests named above.

---

### Task 8: Make every gallery browser leg unconditional in CI

**Files:**

- Modify: `tests/acceptance/gallery-{contrast,daisyui-library,geometry,html-scroll,interactive-tsx,mermaid-natural,refresh,render,static-tsx,tsx-styles,tsx-styles-templates}.test.ts`
- Create: `tests/unit/gallery-acceptance-registration.test.ts`
- Modify: `.github/workflows/ci.yml:342-346`
- Test: `tests/unit/acceptance-browser-launch-budget.test.ts:5-27`

**Interfaces:**

- Consumes: existing one-file-per-matrix-leg CI at `.github/workflows/ci.yml:270-319`.
- Produces: gallery acceptance files that run with plain `bun test` and contain no `FACET_LIVE_GALLERY`, `test.skipIf`, or warning-only skip branch.

- [ ] **Step 1: Add a RED source-registration gate**

`gallery-acceptance-registration.test.ts` must enumerate every `gallery-*.test.ts`, assert each appears in the CI matrix, and reject these patterns:

```ts
/FACET_LIVE_GALLERY/
/test\.skipIf/
/SKIP gallery-/
```

Also assert the two deleted files from Task 7 are not registered.

- [ ] **Step 2: Prove RED**

Run: `bun test tests/unit/gallery-acceptance-registration.test.ts`

Expected: FAIL on all eleven currently conditional gallery files and the conditional environment expression in CI.

- [ ] **Step 3: Remove opt-in conditionals and simplify CI invocation**

Change each gallery file to `test(...)`. Replace line 346's conditional environment assignment with:

```yaml
bun test "tests/acceptance/${{ matrix.test }}" --coverage --coverage-reporter=lcov --reporter=junit --reporter-outfile="test-results/acceptance-${{ matrix.test }}.xml"
```

- [ ] **Step 4: Prove GREEN and launch budget**

```bash
bun test tests/unit/gallery-acceptance-registration.test.ts
bun test tests/unit/acceptance-browser-launch-budget.test.ts
```

Expected: PASS; every acceptance file remains within one direct CDP-pipe launch.

- [ ] **Step 5: Run every changed gallery leg individually**

```bash
for test in gallery-contrast gallery-daisyui-library gallery-geometry gallery-html-scroll gallery-interactive-tsx gallery-mermaid-natural gallery-refresh gallery-render gallery-static-tsx gallery-tsx-styles gallery-tsx-styles-templates; do bun test "tests/acceptance/${test}.test.ts" || exit 1; done
```

Expected: all eleven PASS without setting `FACET_LIVE_GALLERY`.

- [ ] **Step 6: Run the task gate**

```bash
bun test tests/unit tests/integration
bun run build
bun scripts/check-renderer-bundle-parity.ts
bun run verify-adapter-size
bun run typecheck
bun run lint
bun run format:check
bun run check:boundaries
bun run perf-gate -- --record
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/acceptance tests/unit/gallery-acceptance-registration.test.ts tests/unit/acceptance-browser-launch-budget.test.ts .github/workflows/ci.yml
git commit -m "ci(gallery): run live browser acceptance unconditionally"
```

**Implementer trap:** Do not merge gallery files to reduce matrix length. Bun 1.3.14's poisoned CDP-pipe descriptor is process-scoped; one file per leg is the containment boundary.

---

### Task 9: Add the two-viewport geometry and screenshot gate

**Files:**

- Create: `tests/fixtures/gallery-geometry/wide-flowchart.mmd`
- Create: `tests/fixtures/gallery-geometry/tall-state.mmd`
- Create: `tests/fixtures/gallery-geometry/long-report.md`
- Create: `tests/fixtures/gallery-geometry/responsive-dashboard.tsx`
- Create: `tests/fixtures/gallery-geometry/canvas-chart.vl.json`
- Create: `tests/acceptance/gallery-viewport-geometry.test.ts`
- Modify: `tests/helpers/gallery-live.ts:12-144`
- Modify: `tests/unit/acceptance-browser-launch-budget.test.ts:5-27`
- Modify: `tests/unit/gallery-acceptance-registration.test.ts`
- Modify: `.github/workflows/ci.yml:273-319,377-390`

**Interfaces:**

- Consumes: one gallery browser launch, one service, repeated real `publishArtifact` + `open` navigations, `artifactWorld()`, and CDP `Emulation.setDeviceMetricsOverride`/`Page.captureScreenshot`.
- Produces: `setGalleryViewport(target, width, height)`, `readArtifactGeometry(target)`, and `captureGalleryScreenshot(target, path)` helpers.
- Produces: ten PNGs under `test-results/gallery-geometry/`—five fixtures at 1280×720 and 1920×1080.

- [ ] **Step 1: Create deterministic fixtures matching the recorded failures**

- `wide-flowchart.mmd`: left-to-right Mermaid flowchart whose natural SVG is approximately 4,000×400.
- `tall-state.mmd`: top-to-bottom Mermaid state diagram approximately 600×5,000.
- `long-report.md`: enough headings, tables, lists, and paragraphs to exceed both viewport heights without generated/random content.
- `responsive-dashboard.tsx`: interactive grid whose column count changes between 1280 and 1920 and whose controls remain visible.
- `canvas-chart.vl.json`: inline-data Vega-Lite chart rendered with `renderer: "canvas"`.

- [ ] **Step 2: Write the RED acceptance matrix**

Launch the browser exactly once. For each viewport and fixture, publish/open through `FacetClient`, wait for `displayed`, probe inside `/gallery/frame`, and assert:

```ts
scrollWidth >= visibleRect.width;
scrollHeight >= visibleRect.height;
wideFlowchart.scrollWidth > visibleRect.width;
tallState.scrollHeight > visibleRect.height;
longMarkdown.scrollHeight > visibleRect.height;
responsiveDashboard.columnCount === (width === 1280 ? 2 : 3);
canvasChart.canvasCount === 1;
```

For every case, activate zoom-in, prove artifact dimensions increase while iframe dimensions do not change, activate reset, then prove zoom is 1 and frame-document scrollLeft/scrollTop return to 0. Capture a screenshot after reset.

- [ ] **Step 3: Prove RED against the pre-gate helpers/geometry**

Run: `bun test tests/acceptance/gallery-viewport-geometry.test.ts`

Expected: FAIL because fixtures/helpers do not exist; after scaffolding, at least the old transform/nested-frame behavior must fail the zoom/reset or geometry assertions.

- [ ] **Step 4: Implement helpers and register the leg**

Add `gallery-viewport-geometry.test.ts` to the acceptance matrix and upload `test-results/gallery-geometry/**` on both success and failure with 14-day retention. Keep one constructor and one `launch()` in the file; navigate the same target for every case.

- [ ] **Step 5: Prove GREEN and gate sensitivity**

```bash
bun test tests/unit/acceptance-browser-launch-budget.test.ts tests/unit/gallery-acceptance-registration.test.ts
bun test tests/acceptance/gallery-viewport-geometry.test.ts
```

Expected: PASS and ten non-empty PNGs. Temporarily add `max-width: 100%` to the root SVG rule in `frame.css`; rerun the acceptance file and verify the 4,000px flowchart assertion FAILS. Restore the rule and rerun to PASS.

- [ ] **Step 6: Run the task gate**

```bash
bun test tests/unit tests/integration
bun run build
bun scripts/check-renderer-bundle-parity.ts
bun run verify-adapter-size
bun run typecheck
bun run lint
bun run format:check
bun run check:boundaries
bun run perf-gate -- --record
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/fixtures/gallery-geometry tests/acceptance/gallery-viewport-geometry.test.ts tests/helpers/gallery-live.ts tests/unit/acceptance-browser-launch-budget.test.ts tests/unit/gallery-acceptance-registration.test.ts .github/workflows/ci.yml
git commit -m "test(gallery): gate viewport geometry at two sizes"
```

**Implementer trap:** Do not call `probeAvailability()` and then `launch()` in this file; the budget counts both and Bun 1.3.14 can poison the process on the second CDP-pipe spawn.

---

### Task 10: Reconcile renderer parity, boundaries, and performance instrumentation

**Files:**

- Modify: `scripts/check-renderer-bundle-parity.ts:10-25,48-170`
- Modify: `tests/integration/renderer-bundle-parity.test.ts:5-`
- Modify: `scripts/perf/gallery-stages.ts:5-110`
- Modify: `scripts/perf/browser-metrics.ts:30-42,293-390`
- Modify: `scripts/perf-gate.ts:324-381`
- Modify: `scripts/check-boundaries.ts:22-292` only if the new `runtime.ts` path needs explicit coverage
- Test: `tests/unit/boundaries.test.ts`
- Test: `tests/integration/perf-harness.test.ts`

**Interfaces:**

- Consumes: type entries now rooted at `frame/runtime.ts`; renderer module sets remain markdown `[markdown, mermaid, svg]`, mermaid `[mermaid, svg]`, svg `[svg]`, chart `[chart, svg]`, html `[html]`, and tsx `[html, tsx]` unless Bun's metafile proves a deterministic import-set change.
- Produces: parity expectations updated once to the actual gallery/Tier 1 sets; no broad exclusions.
- Produces: direct stages `frameBuiltAt`, `frameLoadedAt`, `renderStartedAt`, `renderCompleteAt`, `visibleAt` and derived load/render timings.

- [ ] **Step 1: Run parity before editing expectations**

Run: `bun scripts/check-renderer-bundle-parity.ts`

Expected: either PASS unchanged or FAIL with an exact set mismatch caused by the runtime import move. Capture the actual metafile sets in the task receipt; do not guess.

- [ ] **Step 2: Update parity narrowly and prove its mutation guards**

Adjust only `EXPECTED_RENDERERS`/`EXPECTED_INITIAL_RENDERERS` entries forced by the new runtime graph. Keep `assertLegacyBundleIsolation()` rejecting TSX/React imports for non-TSX bundles. Run:

```bash
bun test tests/integration/renderer-bundle-parity.test.ts
FACET_TEST_RENDERER_PARITY_MUTATION=markdown=svg bun scripts/check-renderer-bundle-parity.ts
FACET_TEST_RENDERER_STATIC_MUTATION=markdown bun scripts/check-renderer-bundle-parity.ts
```

Expected: test PASS; both mutation commands FAIL with `renderer bundle parity mismatch` or `initial renderer load mismatch`.

- [ ] **Step 3: Rename performance stages without changing the metric**

Remove `bootstrapLoadedAt`/`bootReadyAt` assumptions from the display path. Instrument iframe construction, iframe load, direct render start/completion, and visibility. Keep `publishVisible.totalMs` and the 300ms record-only budget unchanged so before/after values are comparable.

- [ ] **Step 4: Capture the after measurement**

Run: `FACET_PERF_JSON=test-results/gallery-friction-after.json bun run perf-gate -- --record`

Expected: PASS and JSON contains `publish → visible p95` plus direct frame stage samples. Compare it with the Task 1 baseline; record both values and delta in the implementation receipt. Do not raise the 300ms budget if the result regresses—investigate the new load/render path.

- [ ] **Step 5: Run boundaries and prove the service stays byte-dumb**

```bash
bun run check:boundaries
bun test tests/unit/boundaries.test.ts
```

Expected: `service boundary clean`; no `zod`, renderer, Mermaid, Markdown, SVG parser, Vega, React, or DOMPurify package enters `src/service/**`; no zod enters `src/gallery-web/frame/**`.

- [ ] **Step 6: Run the task gate**

```bash
bun test tests/unit tests/integration
bun run build
bun scripts/check-renderer-bundle-parity.ts
bun run verify-adapter-size
bun run typecheck
bun run lint
bun run format:check
bun run check:boundaries
bun run perf-gate -- --record
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-renderer-bundle-parity.ts tests/integration/renderer-bundle-parity.test.ts scripts/perf/gallery-stages.ts scripts/perf/browser-metrics.ts scripts/perf-gate.ts scripts/check-boundaries.ts tests/unit/boundaries.test.ts tests/integration/perf-harness.test.ts
git commit -m "chore(gallery): align parity and perf with direct frames"
```

**Implementer trap:** Parity is gallery-versus-verifier renderer equivalence, not full bundle equality. Do not add `runtime.ts` itself to `EXPECTED_RENDERERS`; the helper intentionally extracts only `frame/renderers/*` basenames.

---

### Task 11: Verify migration continuity and complete the real CLI/browser teardown gate

**Files:**

- Modify only if failures expose a real regression: `tests/acceptance/gallery-refresh.test.ts`, `tests/integration/gallery-session*.test.ts`, `tests/integration/gallery-sse.test.ts`, `tests/integration/gallery-route.test.ts`
- Evidence output: `test-results/gallery-friction-teardown/`
- Plan receipt: append a `## Verification log` section to this plan during execution

**Interfaces:**

- Consumes: real `facet create`, `facet publish`, and `facet open` CLI paths; real service bootstrap/session/lease/source/SSE data path; Steel browser screenshots at 1280×720 and 1920×1080.
- Produces: twelve final screenshots—six artifact types at two viewports—and a gate log with exact commands/results and before/after publish→visible p95.

- [ ] **Step 1: Verify unchanged migration/data-path tests before manual display checks**

```bash
bun test tests/integration/gallery-session.test.ts
bun test tests/integration/gallery-session-bootstrap.test.ts
bun test tests/acceptance/gallery-refresh.test.ts
bun test tests/integration/gallery-sse.test.ts
bun test tests/integration/gallery-route.test.ts
```

Expected: PASS. Refresh re-attaches from `sessionStorage`, lease stays valid, SSE commits fetch the exact revision SHA, stored verdicts/evidence remain service-derived, and failed new renders retain the old frame.

- [ ] **Step 2: Start the real CLI/service and publish all six artifact types**

Use the built CLI (`bun src/cli/main.ts`) with an isolated `FACET_HOME`. This non-interactive script parses each JSON envelope into shell variables, publishes the fixture, opens the exact revision, and prints the six real loopback URLs:

```bash
export FACET_HOME="$(mktemp -d)"
json_field() {
  local path="$1"
  PATH_EXPR="$path" bun -e 'const path = process.env.PATH_EXPR ?? ""; const value = path.split(".").reduce((node, key) => node?.[key], JSON.parse(await Bun.stdin.text())); if (typeof value !== "string") process.exit(1); console.log(value);'
}
publish_open() {
  local key="$1" type="$2" file="$3" renderer="$4" execution="$5"
  local create_json artifact_id publish_json revision_sha open_json frame_url
  create_json="$(bun src/cli/main.ts create --project-id gallery-teardown --slug "$key" --title "$key" --json)"
  artifact_id="$(printf '%s' "$create_json" | json_field data.artifact.id)"
  local publish_args=(publish --artifact-id "$artifact_id" --type "$type" --file "$file" --json)
  [[ -n "$renderer" ]] && publish_args+=(--renderer "$renderer")
  [[ -n "$execution" ]] && publish_args+=(--execution "$execution")
  publish_json="$(bun src/cli/main.ts "${publish_args[@]}")"
  revision_sha="$(printf '%s' "$publish_json" | json_field data.revision.sha256)"
  open_json="$(bun src/cli/main.ts open --artifact-id "$artifact_id" --revision-sha "$revision_sha" --json)"
  frame_url="$(printf '%s' "$open_json" | json_field data.frameUrl)"
  printf -v "${key^^}_ARTIFACT_ID" '%s' "$artifact_id"
  printf -v "${key^^}_REVISION_SHA" '%s' "$revision_sha"
  printf -v "${key^^}_URL" '%s' "$frame_url"
  printf '%s_URL=%s\n' "${key^^}" "$frame_url"
}
publish_open markdown markdown templates/pipeline-audit.md "" ""
publish_open mermaid mermaid tests/fixtures/gallery-geometry/wide-flowchart.mmd "" ""
publish_open svg svg templates/observability-map.svg "" ""
publish_open chart chart tests/fixtures/gallery-geometry/canvas-chart.vl.json canvas ""
publish_open html html templates/fleet-dashboard.html "" ""
publish_open tsx tsx tests/fixtures/gallery-geometry/responsive-dashboard.tsx "" interactive
```

- [ ] **Step 3: Use Steel for two-viewport visual evidence**

Load the `steel-browser` skill. For each of the six real CLI URLs:

1. Set viewport 1280×720, navigate, wait for `#facet-status-line` = `displayed`, verify exactly one unsandboxed iframe, verify the frame document is readable, and exercise zoom-in/pan/reset.
2. Repeat at 1920×1080.
3. For TSX, click an interactive control and verify state changes in the artifact iframe.
4. For Mermaid/Markdown/HTML, scroll to the right/bottom edge and verify content remains reachable.
5. For canvas, verify one visible canvas; for SVG, verify a visible direct root SVG.

Expected: twelve screenshots, one frame per page, shell chrome unaffected by vendored artifact CSS, no nested TSX frame, no clipped wide/tall content, and reset returns 100% with zero scroll offsets.

The exact screenshot paths are:

```text
test-results/gallery-friction-teardown/markdown-1280x720.png
test-results/gallery-friction-teardown/markdown-1920x1080.png
test-results/gallery-friction-teardown/mermaid-1280x720.png
test-results/gallery-friction-teardown/mermaid-1920x1080.png
test-results/gallery-friction-teardown/svg-1280x720.png
test-results/gallery-friction-teardown/svg-1920x1080.png
test-results/gallery-friction-teardown/chart-1280x720.png
test-results/gallery-friction-teardown/chart-1920x1080.png
test-results/gallery-friction-teardown/html-1280x720.png
test-results/gallery-friction-teardown/html-1920x1080.png
test-results/gallery-friction-teardown/tsx-1280x720.png
test-results/gallery-friction-teardown/tsx-1920x1080.png
```

- [ ] **Step 4: Run every affected acceptance leg individually**

```bash
for test in gallery-contrast gallery-daisyui-library gallery-geometry gallery-html-scroll gallery-interactive-tsx gallery-mermaid-natural gallery-refresh gallery-render gallery-static-tsx gallery-tsx-styles gallery-tsx-styles-templates gallery-viewport-geometry; do bun test "tests/acceptance/${test}.test.ts" || exit 1; done
bun test tests/acceptance/csp-consumer-baseline.test.ts
bun test tests/acceptance/gate-forgery.test.ts
bun test tests/acceptance/egress.test.ts
bun test tests/acceptance/tsx-runtime-egress.test.ts
bun test tests/acceptance/tsx-measurement.test.ts
bun test tests/acceptance/tsx-nested-frame-selection.test.ts
```

Expected: all PASS individually.

- [ ] **Step 5: Run the final ordered gate**

```bash
bun test tests/unit tests/integration
bun run build
bun scripts/check-renderer-bundle-parity.ts
bun run verify-adapter-size
bun run typecheck
bun run lint
bun run format:check
bun run check:boundaries
FACET_PERF_JSON=test-results/gallery-friction-teardown/performance.json bun run perf-gate -- --record
```

Expected: every command PASS; parity prints all six renderer sets; adapter-size passes; boundaries prints `service boundary clean`; performance JSON records publish→visible p95 and the direct load/render stage breakdown.

- [ ] **Step 6: Append the verification log and commit evidence-producing test changes**

The log must state: unit+integration pass count, every individual acceptance result, build/parity/adapter/typecheck/lint/format/boundary/perf results, baseline p95, after p95, delta, screenshot paths, and any unverified item. Do not commit generated PNGs unless the repository's existing evidence policy explicitly tracks `test-results/`; retain them as CI/operator artifacts otherwise.

```bash
git add .opencode/plans/2026-08-14-gallery-friction-teardown.md
git commit -m "docs(plan): record gallery teardown verification"
```

**Implementer trap:** Steel is final visual evidence, not a substitute for the CDP acceptance gates. Conversely, Tier 1 screenshots are verifier evidence and do not prove the user's gallery geometry; keep those two evidence classes separate.

## Test Inventory Decision Record

### Tests that die because their production machinery dies

- `tests/acceptance/nested-frame-denials.test.ts` — nested srcdoc sandbox/CSP boundary removed.
- `tests/acceptance/tsx-interactive-isolation.test.ts` — nested TSX sandbox plus nonce/handshake rejection removed.
- Channel lifecycle, handshake, per-frame nonce, control-event forwarding, and one-shot ingress cases inside `tests/integration/gallery-sse.test.ts` — their exact mechanisms are removed.

### Tests that mutate to assert the new contract

- `tests/integration/gallery-sse.test.ts` — direct promise ordering and failure retention.
- `tests/integration/gallery-route.test.ts` — ordinary frame CSP/runtime assets, no nonce/CORS ceremony.
- `tests/integration/gallery-frame-cold.test.ts` — external style/runtime cold recovery.
- `tests/integration/gallery-shell-start.test.ts` — direct frame API fake and no iframe transforms.
- `tests/unit/tsx-renderer.test.ts` — direct mount/blob execution, no nested iframe.
- `tests/acceptance/gallery-render.test.ts` — readable same-origin unsandboxed frame and direct canvas.
- `tests/acceptance/gallery-interactive-tsx.test.ts`, `gallery-tsx-styles.test.ts`, `gallery-tsx-styles-templates.test.ts` — artifact-frame world instead of nested world.
- All `gallery-*.test.ts` conditional wrappers — unconditional CI gates.

### Tests that must not change in meaning

- Tier 1 harness/runner/frame-target suites, including interactive TSX nested selection.
- `tests/acceptance/csp-consumer-baseline.test.ts`.
- `tests/acceptance/gate-forgery.test.ts`.
- `tests/acceptance/egress.test.ts` and `tests/acceptance/tsx-runtime-egress.test.ts`.
- Stored verdict/evidence/read-back tests.
- Gallery session/bootstrap/refresh/lease/SSE data-path tests except their final frame handoff seam.

## Open Decisions

No Legion decision remains open. The settled design fixes the isolation unit, API shape, swap semantics, CSP prohibition on unsafe-inline, view model, CI behavior, and migration boundaries. This plan selects blob-module import only as the minimal implementation required to execute already-compiled interactive TSX bytes under that fixed CSP; changing that mechanism is permitted only if the replacement remains direct, same-realm, promise-observable, and does not broaden CSP.

## Verification log

Recorded by Task 11a (general-implementer subagent), 2026-08-14, on branch `gallery-teardown` at HEAD after T1-T10.

### Step 1 — migration/data-path tests (individual)

| test                                                  | result       | duration   |
| ----------------------------------------------------- | ------------ | ---------- |
| `tests/integration/gallery-session.test.ts`           | PASS (6/6)   | 10.00ms    |
| `tests/integration/gallery-session-bootstrap.test.ts` | PASS (4/4)   | n/a (fast) |
| `tests/acceptance/gallery-refresh.test.ts`            | PASS (1/1)   | 242.00ms   |
| `tests/integration/gallery-sse.test.ts`               | PASS (57/57) | 159.00ms   |
| `tests/integration/gallery-route.test.ts`             | PASS (5/5)   | n/a (fast) |

Refresh re-attach, lease validity, exact-SHA SSE fetch, service-derived verdicts, and old-frame-on-failure all confirmed passing.

### Step 3 — Steel two-viewport visual evidence

**Pending orchestrator visual pass.** Not run by this subagent per dispatch scope (Steel/gateway access denied to this task). Expected paths, to be filled in by the orchestrator's Steel run:

```text
test-results/gallery-friction-teardown/markdown-1280x720.png    — pending orchestrator visual pass
test-results/gallery-friction-teardown/markdown-1920x1080.png   — pending orchestrator visual pass
test-results/gallery-friction-teardown/mermaid-1280x720.png     — pending orchestrator visual pass
test-results/gallery-friction-teardown/mermaid-1920x1080.png    — pending orchestrator visual pass
test-results/gallery-friction-teardown/svg-1280x720.png         — pending orchestrator visual pass
test-results/gallery-friction-teardown/svg-1920x1080.png        — pending orchestrator visual pass
test-results/gallery-friction-teardown/chart-1280x720.png       — pending orchestrator visual pass
test-results/gallery-friction-teardown/chart-1920x1080.png      — pending orchestrator visual pass
test-results/gallery-friction-teardown/html-1280x720.png        — pending orchestrator visual pass
test-results/gallery-friction-teardown/html-1920x1080.png       — pending orchestrator visual pass
test-results/gallery-friction-teardown/tsx-1280x720.png         — pending orchestrator visual pass
test-results/gallery-friction-teardown/tsx-1920x1080.png        — pending orchestrator visual pass
```

### Step 4 — every acceptance leg, individually (one CDP launch per process)

| test                           | result                  | duration | retries |
| ------------------------------ | ----------------------- | -------- | ------- |
| `gallery-contrast`             | PASS (1/1)              | 196.00ms | 0       |
| `gallery-daisyui-library`      | PASS (1/1)              | 187.00ms | 0       |
| `gallery-geometry`             | PASS (1/1)              | 197.00ms | 0       |
| `gallery-html-scroll`          | PASS (1/1)              | 199.00ms | 0       |
| `gallery-interactive-tsx`      | PASS (1/1)              | 482.00ms | 0       |
| `gallery-mermaid-natural`      | PASS (1/1)              | 342.00ms | 0       |
| `gallery-refresh`              | PASS (1/1)              | 242.00ms | 0       |
| `gallery-render`               | PASS (1/1)              | 353.00ms | 0       |
| `gallery-static-tsx`           | PASS (1/1)              | 423.00ms | 0       |
| `gallery-tsx-styles`           | PASS (1/1)              | 472.00ms | 0       |
| `gallery-tsx-styles-templates` | PASS (1/1)              | 479.00ms | 0       |
| `gallery-viewport-geometry`    | PASS (1/1, 120 expects) | 5.03s    | 0       |
| `csp-consumer-baseline`        | PASS (2/2)              | 2.89s    | 0       |
| `gate-forgery`                 | PASS (6/6)              | 3.45s    | 0       |
| `egress`                       | PASS (1/1)              | 4.25s    | 0       |
| `tsx-runtime-egress`           | PASS (1/1)              | 1.59s    | 0       |
| `tsx-measurement`              | PASS (1/1, 343 expects) | 12.29s   | 0       |
| `tsx-nested-frame-selection`   | PASS (1/1)              | 210.00ms | 0       |

All 18 legs pass individually. Zero retries needed for the acceptance sweep.

### Step 5 — final ordered gate

| gate                                                                                                    | result                                                                                      |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `bun test tests/unit tests/integration`                                                                 | PASS — 1082 pass, 0 fail, 3259 expect() calls, 97 files, 45.50s                             |
| `bun run build`                                                                                         | PASS — `{"event":"gallery.built",...}`                                                      |
| `bun scripts/check-renderer-bundle-parity.ts`                                                           | PASS — all six renderer sets printed (`markdown`, `mermaid`, `svg`, `chart`, `html`, `tsx`) |
| `bun run verify-adapter-size`                                                                           | PASS — `3 adapters ≤ 50 lines with CLI-only bodies`                                         |
| `bun run typecheck`                                                                                     | PASS — clean, 2.80s                                                                         |
| `bun run lint`                                                                                          | PASS — `Found 0 warnings and 0 errors` (318 files, 125 rules)                               |
| `bun run format:check`                                                                                  | PASS — `All matched files use the correct format` (398 files)                               |
| `bun run check:boundaries`                                                                              | PASS — `service boundary clean`                                                             |
| `FACET_PERF_JSON=test-results/gallery-friction-teardown/performance.json bun run perf-gate -- --record` | PASS on 2nd attempt (1 retry; see Bun#37230 note below)                                     |

**Bun#37230 retry count: 1.** First perf-gate attempt failed with `tier1: puppeteer launch failed: Connection closed.` at the `browser-exit` phase (the known chrome-headless-shell flaky-launch class). Re-ran once per the one-retry authorization; the retry passed clean.

Perf-gate detail (2nd/passing run), all `[ENFORCED]` metrics PASS:

- service RSS absolute: 68.40 MiB · service RSS delta over Bun floor: 27.66 MiB · service CPU idle: 0.00%
- service dormancy cleanup: clean (no surviving workers)
- publish → revision committed p95: 1.00 ms · revision committed → SSE delivered p95: 1.00 ms
- cold read-back: 422.59 ms · browser exit: 11.61 ms · zombie browser/profile cleanup: clean

**publish → visible p95: baseline (T1) 56.21ms → after (T11) 55.29ms — delta -0.92ms (improved, within noise).**

Direct stage breakdown (median of 20 instrumented replacements, ms): commit=2.00 · SSE=2.00 · handled=3.00 · frame=4.00 · load=10.00 · render=50.00 · swap=51.00 · visible=51.00 · frameLoad+parse=6.00.

Full JSON recorded at `test-results/gallery-friction-teardown/performance.json` (gitignored, not committed — evidence artifact only).

### Unverified items (named honestly)

- Steel two-viewport visual evidence (Step 3, twelve screenshots) is **not run by this subagent** — out of scope per the T11a dispatch; the orchestrator runs it directly and will fill in the screenshot paths above.
- No semantic acceptance-leg failure was encountered; no production-code fix was required or attempted.
