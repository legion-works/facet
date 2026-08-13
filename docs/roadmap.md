# Roadmap

Facet grows by additive extension points. The invariant is fixed: new render
types may extend registries, but artifact code never gains host capabilities.

## v1.x

• Artifact-content secret and PII scanning
• HTML boundary re-review
✓ DONE — TSX artifacts: declared `static` mode reuses the HTML prediction path;
`interactive` mode is client-rendered observation with a bounded stability
re-check. The import set is vendored React only, source stays immutable, and
compiled evidence retains last-N run bytes. See [TSX reference](reference/tsx.md)
and [measurements](verification/tsx-measurements.md).
✓ DONE — Static `html` artifact type — script-free, no `<style>` block or
`style=` attribute, styling from a vendored Tailwind/daisyUI subset.
Generous element allowlist with a short known-dangerous deny set (D9,
not D4); `<img src="https://…">` is permitted and downgrades to
`partial:external_resources`. Tier 0 is a `parse5` prediction coupled
to Chromium observation through a pinned differential corpus; three
recovery families are rejected (`html_encoding_unsupported`,
`html_recovery_unsupported` for `<select>` with table-scoped markup,
`html_nesting_depth_exceeded`). Export produces byte-identical source
via the frame-owned `data-facet-renderer-root` wrapper. See
[HTML reference](reference/html.md) and
[Structure](../STRUCTURE.md) for the policy / vocabulary / parser /
renderer surface. Executable HTML, React/TSX artifacts, and
artifact-supplied JavaScript remain out of scope and tracked under v2
items below.
✓ DONE — Verdict path for structurally opaque content — the prerequisite for HTML mode,
not a follow-up to it. Every observable a verdict is built from today
(`rendererRootSvgCount`, `graphCount`, `mermaidNodeCount`, `visibleSvgCount`,
`viewBoxes`) is DOM structure read by protocol authority, independent of page JS —
which is exactly why a monkeypatched in-page shim cannot forge a verdict. Content
that renders to an opaque bitmap (`<canvas>`, WebGL) exposes ONE element and no
structure, so a canvas-bearing artifact can never earn a plain `ok`. Shipping HTML
mode admits canvas whether or not we add it deliberately — any HTML artifact may
carry a `<canvas>` and draw to it. Required: classify opaque regions and downgrade
honestly (`partial:opaque_content`, with a mandatory `screenshotPath` or typed
`screenshotError` marker) rather than asserting a structural claim the run could not check.
Same principle as Insecure mode: a verdict must never claim a trust property the run
did not have.
• Screenshot policy tuning
✓ DONE — Export slot — source and stored-render byte exports with a mandatory sidecar.
• Browser pin upgrades
✓ DONE — Insecure mode — explicit opt-in relaxation tiers (`FACET_INSECURE=1|2|3`) with forced-floor composition, loud startup/envelope/CLI/gallery disclosure, and explicit `insecure` verdict markers. L1 removes Tier 1 netns isolation, L2 removes both validator netns layers, and L3 skips validation entirely. Levels are boot-only; no per-request escalation.
• Performance budgets are now measured by `scripts/perf-gate.ts`. Current budgets and purposes:
absolute service RSS ≤80 MiB (catastrophic-growth guard), paired service-minus-Bun-floor
RSS ≤30 MiB (regression detector), idle CPU <0.5% (regression detector),
publish→revision-committed p95 ≤200 ms (validation-inclusive product commitment),
revision-committed→SSE-delivered p95 ≤25 ms (notification regression detector),
publish→visible p95 <300 ms (product commitment), cold read-back max-of-5 <1500 ms
(stable-machine product commitment), and browser exit max-of-20 ≤100 ms (stable-machine
regression detector). Enforcement splits on HOST SENSITIVITY, not on whether a browser is
involved: budgets whose wall-clock is dominated by process spawn or browser launch are
enforced only on a stable machine and recorded in CI, because a 2-core hosted runner measures
publish→revision-committed at 439 ms against 151-159 ms on a 16-core host, and cold read-back
at 2919 ms against 833 ms. Gating those in CI would gate Facet on runner size rather than on
its own regressions. CI enforces the host-invariant budgets — RSS absolute and delta, idle CPU,
dormancy, SSE delivery (1.00 ms on both hosts, since no spawn sits in that path), and zombie
cleanup. Publish→visible remains recorded-not-enforced, but for a DIFFERENT reason than when
that status was set: it is now MET, not missed. The frame code-split (af46b64) cut fresh-frame
load+parse from ~119 ms to ~8 ms and took p95 from 354 ms to 253 ms — 47 ms inside the
commitment. The remaining blocker is measurement, not performance: publish→visible needs a
browser, and on the pinned Bun 1.3.14 the CDP transport wedges every time (3/3), so the number
is only reproducible on the 1.4.0 line. Enforcement is therefore gated on the Bun bump rather
on than any Facet change — re-measure and enforce when 1.4.0 ships stable.
✦ DONE (af46b64) — Code-split the 8.55 MB fresh-frame bootstrap bundle. Type-specific static
entries: markdown 8,553,143 B → 60,788 B initial static graph (140×), svg → 14,326 B (597×);
only chart still carries the Vega runtime, and only chart artifacts pay for it. Gallery and
Tier 1 verifier still execute the SAME renderer modules — enforced by a Bun-metafile parity
check with both divergence directions pinned as tests, so the unfakeable gate keeps verifying
exactly what the operator sees.

## v2

• TypeScript `ArtifactBuilder`
▸ Swappable UI library: let a TSX artifact declare its UI kit and resolve it through a registered provider — another typed registry extension, like `RendererRegistry`. Hard constraint: the kit is vendored/bundled offline (never a runtime CDN pull) and artifact code still gains zero host capabilities — the frozen-CSP + byte-dumb model binds it. Researched defaults (T1, re-verify at design time): **Base UI** for polished/composed work (headless primitives; `CSPProvider` v1.1.0+ threads the per-frame nonce into its 4 style-injecting components) + **daisyUI 5** for quick dashboards (56/58 components pure CSS → CSP-safe by construction; themes are CSS-var sets that slot into the design-token palette). Disqualified: shadcn/ui's default Radix variant — `react-style-singleton` injects scroll-lock `<style>` without nonce propagation in static builds (upstream open since 2023). Charts stay vega-lite (already vendored, SVG, no runtime style injection).
✓ DONE — Canvas as a RENDERER BACKEND — never as an artifact type. Rejected as a peer type
(`artifactType: "canvas"`): a raw canvas yields no structural observable, so its
verdict would rest on the page's own claim about what it drew — the precise forgery
vector the trust core exists to close. Legitimate instead: verify at the SPEC layer,
render at the PIXEL layer. Vega-Lite is already compiled and structurally validated
in Tier 0, and Vega ships both SVG and canvas renderers, so a canvas backend for
large-series charts leaves the trust anchor untouched — the spec is what we verify,
the pixels are only how it is drawn. Gate it on measured need (SVG node counts where
headless render time actually degrades), and it inherits the CSP constraint that
already forced `@vega/vega-interpreter`: no `unsafe-eval`, offline, bundle-local.
**Requires no new dependency** — researched (2026-08-09): Vega is the only surveyed
library that switches one compiled spec between SVG and canvas AND clears strict
nonce-only CSP, via the AST interpreter we already vendor. Disqualified on CSP
grounds, recorded so this is not re-litigated: full D3 ships `new Function`; Plotly's
renderer is trace-specific rather than one switch, with unresolved nonce/inline-style
behavior; ECharts has dual output but its CSP admission is unproven against our
pinned Chromium (would need a smoke test before it could be considered).
The finding that settles canvas-as-a-type: **no permissively licensed library
maintains a per-mark DOM mirror beside the bitmap** (Highcharts is the nearest prior
art and is commercially licensed), so there is no structural surface for protocol
probes to observe — the rejection above is a measured conclusion, not an assumption.
• Animations — sequenced after HTML/React artifacts ship. Animated artifacts
(CSS/SVG animation, transitions, animated charts) on top of the HTML/TSX mode.
Verification note for design time: verdicts observe structure at a point in time,
so an animated artifact verifies its static structure; animation fidelity is
display-layer only unless a timeline probe is designed.
• Forms `FormBridge`
• Arbitrary npm for TSX artifacts
• Split `src/validation/tier0/tsx/ast-policy.ts` and
`src/validation/tier0/worker-entry.ts`; both exceed the focused-file target.
• FTS5 `SearchIndex`
• Trilium `ExportSink`
• UDS `CliTransport`
• Project-scoped `AuthorizationPolicy`
• Annotations, diffs, and garbage collection

Every extension remains behind a typed boundary. Storage stays byte-dumb, and
renderers remain sandboxed.
