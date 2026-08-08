# Roadmap

Facet grows by additive extension points. The invariant is fixed: new render
types may extend registries, but artifact code never gains host capabilities.

## v1.x

• Artifact-content secret and PII scanning
• HTML boundary re-review
• Screenshot policy tuning
• Export slot
• Browser pin upgrades
• Insecure mode — explicit opt-in relaxation tiers for users who accept the risk (e.g. `FACET_INSECURE=1|2|3`): candidate levels — (1) skip Tier 1 netns isolation, (2) run validators without sandboxing, (3) skip validation entirely / trust the artifact. Design lines: never the default, loud on every startup and envelope, and verdicts produced under any relaxed level carry an explicit `insecure` marker — a verdict must never claim a trust property the run did not have. Levels compose downward only (no per-request escalation).
• Performance-budget verification: build a correct perf harness (fresh Tier 1 launches for cold read-back + browser-exit timing, service-process RSS/CPU sampling, warm-only SSE p95) and verify the RSS≤50MiB / CPU<0.5% / SSE-p95≤100ms / publish→visible<300ms / cold-readback<3s / browser-exit≤2s budgets. Deferred from v1: the v1 harness was defective and the budgets are unmeasured, not failed.

## v2

• TypeScript `ArtifactBuilder`
▸ Swappable UI library: let a TSX artifact declare its UI kit and resolve it through a registered provider — another typed registry extension, like `RendererRegistry`. Hard constraint: the kit is vendored/bundled offline (never a runtime CDN pull) and artifact code still gains zero host capabilities — the frozen-CSP + byte-dumb model binds it. Researched defaults (T1, re-verify at design time): **Base UI** for polished/composed work (headless primitives; `CSPProvider` v1.1.0+ threads the per-frame nonce into its 4 style-injecting components) + **daisyUI 5** for quick dashboards (56/58 components pure CSS → CSP-safe by construction; themes are CSS-var sets that slot into the design-token palette). Disqualified: shadcn/ui's default Radix variant — `react-style-singleton` injects scroll-lock `<style>` without nonce propagation in static builds (upstream open since 2023). Charts stay vega-lite (already vendored, SVG, no runtime style injection).
• Forms `FormBridge`
• FTS5 `SearchIndex`
• Trilium `ExportSink`
• UDS `CliTransport`
• Project-scoped `AuthorizationPolicy`
• Annotations, diffs, and garbage collection

Every extension remains behind a typed boundary. Storage stays byte-dumb, and
renderers remain sandboxed.
