# Release process

Facet releases are driven by Conventional Commits through release-please. The workflow updates `package.json`, changelog, tag, and GitHub release metadata; maintainers merge the generated release pull request rather than editing versions by hand.

Release assets include the source archive, the built CLI and gallery, and a browser manifest for the frozen `chrome-headless-shell` version `131.0.6778.204`. The manifest records the exact Chrome for Testing URL and the SHA-256 computed from that pinned archive. A release must never download an unversioned or latest browser.

## Required checks

`ci` and `security-egress` are required branch-protection checks. The security workflow always creates the `security-egress` status: unrelated changes pass after the path decision, while relevant changes run the full egress and gate-forgery acceptance tests. The job uses the named self-hosted Linux runner with unprivileged user namespaces; inability to prove `unshare --map-current-user --net` is a failure, not a skip.

Any shell, CSP, sandbox, token, or network-boundary change requires evidence from both acceptance gates before merge. Maintainers must not weaken the check to optional because a hosted runner lacks namespaces; provision or repair the named runner instead.

## Operator sequence

1. Use a Conventional Commit and run the local gates in `CONTRIBUTING.md`.
2. Confirm the generated release pull request contains only the intended version and changelog changes.
3. Merge after `ci` and `security-egress` pass.
4. Confirm the GitHub release contains the source, CLI/gallery, and pinned-browser manifest assets.
