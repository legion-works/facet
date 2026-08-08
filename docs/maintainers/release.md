# Release process

Facet releases are driven by Conventional Commits through release-please. The workflow updates `package.json`, changelog, tag, and GitHub release metadata; maintainers merge the generated release pull request rather than editing versions by hand.

Release assets include the source archive, the built CLI and gallery, and a browser manifest for the frozen `chrome-headless-shell` version `131.0.6778.204`. The manifest records the exact Chrome for Testing URL and the SHA-256 computed from that pinned archive. A release must never download an unversioned or latest browser.

## Required checks

`ci` and `security-egress` are required branch-protection checks. The security workflow always creates the `security-egress` status: unrelated changes pass after the path decision, while relevant changes run the full egress and gate-forgery acceptance tests. The job uses the named self-hosted Linux runner with unprivileged user namespaces; inability to prove `unshare --map-current-user --net` is a failure, not a skip.

Any shell, CSP, sandbox, token, or network-boundary change requires evidence from both acceptance gates before merge. Maintainers must not weaken the check to optional because a hosted runner lacks namespaces; provision or repair the named runner instead.

The `security-egress` job requires the named self-hosted Linux runner because hosted CI does not reliably provide user namespaces. If that runner is offline, pull requests touching security paths are correctly blocked until it returns; this is intentional fail-closed behavior. Maintainers must not relabel the check optional to unblock a change — move or repair the runner instead.

## Coverage posture

The release bar is 90% aggregate lines and functions, enforced in CI by summing `coverage/lcov.info`. Bun has no aggregate mode, so its configured 70% lines/statements and 65% functions thresholds are only per-file anti-rot floors. The lower function floor accommodates the cross-process acceptance harness entrypoint while still catching files that rot to near-zero coverage. The five validation files that execute inside the netns subprocess or drive a separate browser process are excluded because Bun's in-process instrumentation cannot observe those instructions: `sandbox/netns.ts`, `tier0/runner.ts`, `tier1/browser-process.ts`, `tier1/cdp-pipe.ts`, and `tier1/runner.ts`. Browser-runtime files `gallery-web/sse-client.ts`, `gallery-web/frame/renderers/mermaid.ts`, and `gallery-web/frame/renderers/registry.ts` are likewise excluded because they execute browser-only streaming/runtime dispatch. These paths remain covered by the required security-egress, gallery-SSE integration, gate-forgery, and adversarial-render acceptance gates. Test helpers are excluded as infrastructure; pure Tier 0 parsers and in-process security code remain measured.

## Operator sequence

1. Use a Conventional Commit and run the local gates in `CONTRIBUTING.md`.
2. Confirm the generated release pull request contains only the intended version and changelog changes.
3. Merge after `ci` and `security-egress` pass.
4. Confirm the GitHub release contains the source, CLI/gallery, and pinned-browser manifest assets.
