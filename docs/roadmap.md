# Roadmap

Facet grows by additive extension points. The invariant is fixed: new render
types may extend registries, but artifact code never gains host capabilities.

## v1.x

• Artifact-content secret and PII scanning
• HTML boundary re-review
• Verdict path for structurally opaque content — the prerequisite for HTML mode, not a
follow-up to it. Every observable a verdict is built from today
(`rendererRootSvgCount`, `graphCount`, `mermaidNodeCount`, `visibleSvgCount`,
`viewBoxes`) is DOM structure read by protocol authority, independent of page JS —
which is exactly why a monkeypatched in-page shim cannot forge a verdict. Content
that renders to an opaque bitmap (`<canvas>`, WebGL) exposes ONE element and no
structure, so a canvas-bearing artifact can never earn a plain `ok`. Shipping HTML
mode admits canvas whether or not we add it deliberately — any HTML artifact may
carry a `<canvas>` and draw to it. Required: classify opaque regions and downgrade
honestly (`partial:layout_unverified`, which already mandates a non-null
`screenshotPath`) rather than asserting a structural claim the run could not check.
Same principle as Insecure mode: a verdict must never claim a trust property the run
did not have.
• Screenshot policy tuning
• Export slot
• Browser pin upgrades
• Insecure mode — explicit opt-in relaxation tiers for users who accept the risk (e.g. `FACET_INSECURE=1|2|3`): candidate levels — (1) skip Tier 1 netns isolation, (2) run validators without sandboxing, (3) skip validation entirely / trust the artifact. Design lines: never the default, loud on every startup and envelope, and verdicts produced under any relaxed level carry an explicit `insecure` marker — a verdict must never claim a trust property the run did not have. Levels compose downward only (no per-request escalation).
• Performance budgets are now measured by `scripts/perf-gate.ts`. Current budgets and purposes:
absolute service RSS ≤80 MiB (catastrophic-growth guard), paired service-minus-Bun-floor
RSS ≤30 MiB (regression detector), idle CPU <0.5% (regression detector),
publish→revision-committed p95 ≤200 ms (validation-inclusive product commitment),
revision-committed→SSE-delivered p95 ≤25 ms (notification regression detector),
publish→visible p95 <300 ms (product commitment), cold read-back max-of-5 <1500 ms
(stable-machine product commitment), and browser exit max-of-20 ≤100 ms (stable-machine
regression detector). CI enforces browser-free budgets and records browser-dependent results;
stable local runs additionally enforce cold read-back and browser exit. Publish→visible remains
recorded-not-enforced until its measured p95 is below the commitment with headroom.
• Code-split the 8.55 MB fresh-frame bootstrap bundle. It accounts for about 108 ms (36%) of
publish→visible p95 and is the named blocker to enforcing the 300 ms commitment.

## v2

• TypeScript `ArtifactBuilder`
▸ Swappable UI library: let a TSX artifact declare its UI kit and resolve it through a registered provider — another typed registry extension, like `RendererRegistry`. Hard constraint: the kit is vendored/bundled offline (never a runtime CDN pull) and artifact code still gains zero host capabilities — the frozen-CSP + byte-dumb model binds it. Researched defaults (T1, re-verify at design time): **Base UI** for polished/composed work (headless primitives; `CSPProvider` v1.1.0+ threads the per-frame nonce into its 4 style-injecting components) + **daisyUI 5** for quick dashboards (56/58 components pure CSS → CSP-safe by construction; themes are CSS-var sets that slot into the design-token palette). Disqualified: shadcn/ui's default Radix variant — `react-style-singleton` injects scroll-lock `<style>` without nonce propagation in static builds (upstream open since 2023). Charts stay vega-lite (already vendored, SVG, no runtime style injection).
▸ Canvas as a RENDERER BACKEND — never as an artifact type. Rejected as a peer type
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
• Forms `FormBridge`
• FTS5 `SearchIndex`
• Trilium `ExportSink`
• UDS `CliTransport`
• Project-scoped `AuthorizationPolicy`
• Annotations, diffs, and garbage collection

Every extension remains behind a typed boundary. Storage stays byte-dumb, and
renderers remain sandboxed.
