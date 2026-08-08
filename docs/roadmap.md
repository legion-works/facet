# Roadmap

Facet grows by additive extension points. The invariant is fixed: new render
types may extend registries, but artifact code never gains host capabilities.

## v1.x

• Artifact-content secret and PII scanning
• HTML boundary re-review
• Screenshot policy tuning
• Export slot
• Browser pin upgrades
• Performance-budget verification: build a correct perf harness (fresh Tier 1 launches for cold read-back + browser-exit timing, service-process RSS/CPU sampling, warm-only SSE p95) and verify the RSS≤50MiB / CPU<0.5% / SSE-p95≤100ms / publish→visible<300ms / cold-readback<3s / browser-exit≤2s budgets. Deferred from v1: the v1 harness was defective and the budgets are unmeasured, not failed.

## v2

• TypeScript `ArtifactBuilder`
▸ Swappable UI library: let a TSX artifact declare its UI kit (design-system, shadcn, …) and resolve it through a registered provider — another typed registry extension, like `RendererRegistry`. Hard constraint: the kit is vendored/bundled offline (never a runtime CDN pull) and artifact code still gains zero host capabilities — the frozen-CSP + byte-dumb model binds it.
• Forms `FormBridge`
• FTS5 `SearchIndex`
• Trilium `ExportSink`
• UDS `CliTransport`
• Project-scoped `AuthorizationPolicy`
• Annotations, diffs, and garbage collection

Every extension remains behind a typed boundary. Storage stays byte-dumb, and
renderers remain sandboxed.
