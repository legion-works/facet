# v1 ship gate

Date: 2026-08-08

Pre-commit HEAD: `dde2d7518dcbc9aebcba50f3f938c1d9b84e3b85` · this document is
part of the following commit.

Runtime: Bun 1.3.14 · pinned browser `chrome-headless-shell 131.0.6778.204`

## Gates

All commands were run from the repository root.

```text
bun install --frozen-lockfile                         pass
bun run format:check                                  pass · 184 files
bun run lint                                          pass
bun run typecheck                                     pass · full tree
bun run check:boundaries                              pass · service boundary clean
bun test                                              pass · 486 tests, 1474 expects
bun test --coverage --coverage-reporter=lcov          pass · 486 tests, 0 fail
bun run build                                         pass · gallery built
bun scripts/verify-adapter-size.ts                    pass · 3 adapters
bun scripts/check-coverage.ts                         pass · lines 93.71%, functions 94.86%
```

Security acceptance:

```text
bun test tests/acceptance/adversarial-render.test.ts  pass · 1 test, 1 expect
bun test tests/acceptance/gate-forgery.test.ts        pass · 2 tests, 2 expects
bun test tests/acceptance/egress.test.ts              pass · 1 test, 3 expects
gitleaks detect --redact --no-banner                   pass · 49 commits, no leaks
```

The egress acceptance observed zero HTTP/WS/event sink hits and zero UDP
packets. Forgery acceptance observed `tampered`; nested SVG could not forge the
count. Database and evidence paths are hardened to `0600` and `0700`; the
permissions paths are covered by the store, token, and acceptance test suite.

Durability and lifecycle:

```text
bun test tests/integration/crash-safety.test.ts tests/integration/lifecycle.test.ts tests/integration/read-back.test.ts
pass · 24 tests, 82 expects
```

The released v1 gate was defective: its dormancy checks used a fresh home where no service had
ever run, it sampled the Bun test runner rather than the detached service, and its “cold read-back”
read a stored verdict instead of launching Chrome. Those green results were vacuous. The v1.x
harness starts real detached services, samples `/proc` for their PIDs, opens a warm SSE stream,
launches a fresh netns-wrapped browser for every cold read-back and exit sample, and baseline-diffs
browser PIDs and profile directories after real cycles.

Measured on the 16-core development host (Bun 1.3.14):

| Measurement                        | Min / median / p95 / max             | Budget and purpose                                                                                            |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Bare `Bun.serve` RSS floor         | 36.47 / 37.53 / — / 37.97 MiB        | Same-run baseline                                                                                             |
| Facet service RSS, 1 s idle        | 61.97 / 62.17 / — / 62.91 MiB        | ≤80 MiB absolute guard                                                                                        |
| Facet RSS minus Bun floor          | 24.20 / 25.25 / — / 25.50 MiB        | ≤30 MiB regression detector                                                                                   |
| Idle CPU, five 5 s windows         | 0 / 0.20 / 0.20 / 0.20%              | <0.5%; `/proc` tick quantization is ~0.2%, so the limit catches the third tick without flapping on one or two |
| Tier 0 netns runner                | 135.34 / 140.41 / 145.97 / 148.42 ms | Attribution only                                                                                              |
| Publish → revision committed       | — / — / ~153 / — ms                  | ≤200 ms validation-inclusive commitment                                                                       |
| Revision committed → SSE delivered | — / — / ~1 / — ms                    | ≤25 ms notification regression detector                                                                       |
| Publish → visible, N=20            | 286.73 / ~292 / 300.73 / 311.99 ms   | <300 ms commitment; currently not met, recorded-not-enforced                                                  |
| Cold read-back, N=5                | 678.77 / 775.67 / — / 906.50 ms      | <1500 ms, stable-machine enforcement                                                                          |
| Browser exit, N=20                 | 9.03 / 12.79 / 18.33 / 26.60 ms      | ≤100 ms, stable-machine enforcement                                                                           |

The old 50 MiB RSS figure was written before the system existed and was never reachable as
implemented. A bare runtime costs about 38 MiB; importing `src/service/server.ts` without starting
it costs about 58 MiB; the running service costs about 63 MiB. Import attribution bounds were
13.43 MiB for contracts, 11.82 MiB for store plus `bun:sqlite`, and 19.91 MiB for the non-store
service surface; these overlap through transitive imports. Eager Zod schema construction is the
largest identifiable component. Lazy schema state in the verdict-validation boundary is consciously
declined: saving roughly 13 MiB is not worth making unforgeable validation conditional on schema
initialization order.

The original combined “SSE p95” budget also hid the guarded behavior: about 146 ms is the required
fresh Tier 0 netns process, while delivery after commit is about 1 ms. It is split so a 20× stream
regression cannot pass behind validation time. Publish→visible is likewise staged: commit ~153 ms,
frame built ~156 ms, 8.55 MB bootstrap loaded/parsed ~258 ms, and visible ~300 ms. Fresh-frame bundle
load and parse accounts for about 108 ms (36%) and is the named remediation before enforcement.

CI enforces browser-free budgets. Hosted-runner browser measurements are recorded but never labeled
as passing gates; stable local runs enforce cold read-back and browser exit. Publish→visible remains
recorded on every machine until code-splitting creates enough headroom for a credible non-flapping gate.

## Roadmap freeze

The additive roadmap is recorded in [roadmap](../roadmap.md). New render types
may extend registries, but artifact code never gains host capabilities.

## Known untested platforms

GitHub CI is unproven: no remote is configured in this checkout. Workflow files
are syntactically checked locally with the repository gates, but execution on
GitHub is deferred.

## Verdict

`SHIP (v1) — trust core verified; performance-budget verification deferred to v1.x.`
