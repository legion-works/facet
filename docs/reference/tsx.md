# TSX reference

## Publish

```sh
facet publish --artifact-id <id> --type tsx --file templates/tsx-status-report.tsx
facet publish --artifact-id <id> --type tsx --execution interactive --file templates/tsx-interactive-counter.tsx
```

`static` is the default execution mode. `interactive` is declared with
`--execution`; Facet does not infer it from hooks or handlers.

## Static mode

Static TSX compiles to HTML in Tier 0, then uses the existing HTML prediction
and Tier 1 comparison pipeline. It can earn the same predict-and-compare claim
as an HTML artifact.

## Interactive mode

Interactive TSX is client-rendered observation only. There is no SSR or
hydration expectation. Tier 1 observes structure through CDP snapshot,
`getDocument`, and an isolated-world channel, then repeats the observation
after the bounded one-second stability window. Agreement is an observation that
the artifact ran and held its structure; it is not a server-rendered prediction.

Facet mounts the default export in both modes. Artifacts must export a component
and must not call `createRoot` or self-mount.

## Imports and styling

The compiler accepts only vendored modules: `react`, `react-dom`,
`react-dom/client`, `react/jsx-runtime`, and `react/jsx-dev-runtime`.
Pinned versions are React and React DOM `19.2.8`, TypeScript `5.7.3`.

TSX reuses the [HTML style vocabulary](html.md#vendored-styling-vocabulary):
the shipped Tailwind/daisyUI classes, not JavaScript component kits. There is no
promise of arbitrary npm, Base UI, forms, FormBridge, or animations.

## Publish-time policy

Tier 0 rejects direct `fetch`, `eval`, `new Function`, dynamic `import()`,
`Worker`, `SharedWorker`, `require`, obvious denied-global aliases, and
non-allowlisted imports. Capability errors use `tsx_capability_fetch`,
`tsx_capability_eval`, `tsx_capability_function_constructor`,
`tsx_capability_dynamic_import`, `tsx_capability_worker`,
`tsx_capability_shared_worker`, `tsx_capability_computed_global`,
`tsx_capability_require`, or `tsx_capability_global_alias`; imports report
`tsx_import_denied`. This AST policy is early feedback, not the enforcement
boundary: aliases and indirect JavaScript forms are deliberately not exhaustively
modeled. The nested frame, CSP, and netns runtime controls make denied
capabilities unreachable.

## Execution boundary

Interactive bundles run in a nested opaque-origin `srcdoc` frame. The frozen
CSP is `default-src 'none'` with nonce-only scripts, `connect-src 'none'`,
`worker-src 'none'`, `form-action 'none'`, `object-src 'none'`, `base-uri
'none'`, and `frame-src 'none'`. The artifact code has no host port or service
capability.

## Storage and export

Revision source remains immutable. Compilation creates derived bytes recorded at
the run's `compiled_path`; TSX source export writes the original `.tsx` bytes.
Render export remains the retained Tier 1 screenshot. Evidence retains the last
10 non-retained runs per artifact.

## Verdicts

TSX verdicts carry `execution: "static" | "interactive"`. In interactive mode,
`partial:unstable` means the first observation changed during the stability
re-check. It loses to timeout, channel divergence, channel availability, and
durable errors, but outranks single-snapshot structural claims.

## Measurements and limits

Measured determinism, compiler bytes, and nested-channel observations are in
[TSX measurements](../verification/tsx-measurements.md). Interactive bundles
currently ship development React: about 975 KB per artifact, about 9.3 MiB per
artifact across last-10 evidence retention, and about 46.5% of the 2 MiB output
cap. Switch to a production React build in a follow-up before treating that
payload as settled.

## Starters

- [Static status report](../../templates/tsx-status-report.tsx)
- [Interactive counter](../../templates/tsx-interactive-counter.tsx)
