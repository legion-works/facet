# Roadmap

Facet grows by additive extension points. The invariant is fixed: new render
types may extend registries, but artifact code never gains host capabilities.

## v1.x

• Artifact-content secret and PII scanning
• HTML boundary re-review
• Screenshot policy tuning
• Export slot
• Browser pin upgrades

## v2

• TypeScript `ArtifactBuilder`
• Forms `FormBridge`
• FTS5 `SearchIndex`
• Trilium `ExportSink`
• UDS `CliTransport`
• Project-scoped `AuthorizationPolicy`
• Annotations, diffs, and garbage collection

Every extension remains behind a typed boundary. Storage stays byte-dumb, and
renderers remain sandboxed.
