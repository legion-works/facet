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

Observed full performance gate output:

```text
dormant process=0 · dormant port=0 · dormant watcher=0
tier-0 status latency=0.12ms · zombie profile/process cleanup=true
active RSS=163.79MiB · methodology caveat — sampled the in-process Bun runner,
  not an isolated service process
active CPU=2.00% · methodology caveat — same process-scope limitation
publish SSE p95=519.74ms, n=20 · unmeasured — the probe included an
  unisolated startup/stream setup path and was not accepted as warm-only p95
cold read-back p50=0.18ms, n=12 · unmeasured — `readBack` reads the stored
  verdict; it does not launch a fresh Tier 1 browser
browser-exit wall p95=1.98ms, n=12 · unmeasured — no isolated teardown timer;
  the probe did not prove a browser launch/exit cycle
```

The discrete browser teardown measurement is deferred: the current harness
does not expose teardown-to-process-exit separately, and the read-back probe
does not launch a browser. No performance pass is claimed from these probes.

Gallery-display timings are deferred for v1: publish→visible p50 and
replacement-begins p95 require an automated browser rendering the Tier 2
gallery shell; the available harness verifies the Tier 1 path, not display-tier
timing.

## Roadmap freeze

The additive roadmap is recorded in [roadmap](../roadmap.md). New render types
may extend registries, but artifact code never gains host capabilities.

## Known untested platforms

GitHub CI is unproven: no remote is configured in this checkout. Workflow files
are syntactically checked locally with the repository gates, but execution on
GitHub is deferred.

## Verdict

`BLOCKED-ON-PERF-VERIFICATION` — the solid security, durability, lifecycle,
coverage, and static gates pass. Performance budgets remain unverified because
the available probe did not isolate the service process, warm-only SSE path, or
fresh Tier 1 launch/teardown. The capstone commit records the evidence without
claiming a ship.
