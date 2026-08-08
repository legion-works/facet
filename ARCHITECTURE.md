# Architecture

## Trust boundaries

Facet separates byte storage, validation, rendering, and display. The service is byte-dumb: it hashes, stores, lexically counts, and serves bytes. It never imports renderers or parsers. Artifact code runs in a sandbox and never gains host capabilities.

The service-boundary guard (`scripts/check-boundaries.ts`) is the single source of truth for that rule. It is a static regex scan over the import specifiers of every file under `src/service/**` and `src/gallery-web/frame/**`, and it fails the gate on any forbidden package (`marked`, `mermaid`, `puppeteer-core`, `vega`, `vega-lite`, `jsdom`, `happy-dom`, `linkedom`) or any cross-import into `src/validation/**` or `src/gallery-web/frame/**`. The scanner covers every realistic import form — `import x from "..."`, `import { x } from "..."`, `import * as x from "..."`, `import "..."` (bare), dynamic `import("...")`, `require("...")`, AND every re-export form (`export * from`, `export { x } from`, `export type { x } from`, `export * as ns from`) — so a hostile addition cannot sneak past via an alternate syntax. The only file under `src/service/` that is permitted to exist outside the store is `src/service/lexical/expectations.ts` — it counts fenced blocks lexically (no parser import) and feeds the verifier's expected-vs-observed comparison. The script's pure scan logic is exported and exercised by `tests/unit/boundaries.test.ts` so the guard itself cannot silently regress.

## Lifecycle and data flow

An artifact enters through a one-shot source channel, is hashed and stored, then passes the validation ladder. Tier 0 is the default browser-free parser worker in a network namespace with no egress. Tier 1 is explicit: an ephemeral pinned chrome-headless-shell connects over a CDP pipe inside a no-egress network namespace. Tier 2 is the user's browser and is display-only.

The gallery uses opaque-origin iframe frames with `sandbox="allow-scripts"` and a frozen CSP. Two MessageChannels separate one-shot source ingress from closure-held control. Every revision receives a fresh frame. Double-buffered hot swap preserves shell view state while replacing the artifact frame.

Facet is lazy: dormant means zero processes, watchers, and ports. Extensions may register render types, but artifact code never receives host capabilities.

## Public contract surface

All cross-process and cross-language communication travels through a single envelope type defined in `src/shared/contracts/envelope.ts`:

- `FACET_SCHEMA_VERSION = "facet.v1"`. Any envelope carrying a different value is rejected with `unknown_schema_version`.
- `FacetEnvelope<T>` is the discriminated `{ ok: true, data: T } | { ok: false, error: FacetErrorBody }` shape. Both arms are `z.object(...).strict()` and joined via a single zod `discriminatedUnion`, so an envelope carrying `ok:true` plus an `error` key (or any extra top-level key) is REJECTED, and the envelope round-trips cleanly through `JSON.parse(JSON.stringify(...))` because `FacetErrorBody.details` only accepts JSON-safe primitives.
- Every command verb (create, publish, list, readBack, status, open, promote, instantiate, pin) has a request and a result schema split across `src/shared/contracts/commands/requests.ts` and `src/shared/contracts/commands/results.ts`, joined into a single `CommandRequestSchema` and `CommandResultSchema` discriminated union and re-exported through `src/shared/contracts/commands/index.ts` (the documented public surface).
- Two names are reserved rather than implemented: `command: "export"` parses but the dispatcher returns `reserved_not_implemented`, and `artifactType: "html"` parses but the publisher returns `unsupported_reserved_type`. Both are caught at the contract layer rather than the handler layer so the dispatcher never has to guess whether a verb is supported.
- The read-back tier accepts `0 | 1 | "visual"` at the public surface (where `"visual"` is sugar for `1`); the verifier only ever sees the normalized numeric tier.
- A single canonical `VerdictSchema` in `src/shared/contracts/validation.ts` is the source of truth for every read-back response, every Tier 0 result, and every Tier 1 result. Tier results extend it (Tier 0 adds `expected`; Tier 1 adds screenshot/console paths); the read-back response embeds it directly. `RenderStatusSchema` is a closed enum so a forged `status: "kinda_ok"` is rejected, not silently accepted as a Tier 1 verdict.
- Stream events (`src/shared/contracts/events.ts`) and validation results share the same primitive-only details contract so a single error-body serializer covers every surface.
- Gallery bootstrap, lease-gated source reads, release, and revision SSE use loopback-only routes; source reads return bytes plus the latest stored verdict for the bound revision; lease and artifact capabilities remain headers.

Untrusted boundaries (worker stdout, HTTP bodies, SSE frames, CLI argv) parse via `parseEnvelope` and `.safeParse`; the typed `FacetError` (`src/shared/errors/facet-error.ts`) is the only error class that ever crosses the boundary. Renderer complexity limits and the source-byte cap live in `src/shared/config/limits.ts` (the `SOURCE_CAP_BYTES` value is the ADR 0001 D2 hard cap); XDG-style runtime paths live in `src/shared/config/paths.ts`.

`zod` is the wire-format source of truth inside the service. It MUST NOT cross into `src/gallery-web/frame/**` — the boundary guard enforces that today, and any code added to the frame bundle must never `import "zod"`. The frame bundle speaks the same `FacetEnvelope<T>` shape but in plain JavaScript.
