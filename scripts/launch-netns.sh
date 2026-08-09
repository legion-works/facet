#!/bin/sh
#
# Tier 1 production netns launcher.
#
# Wraps the PINNED `chrome-headless-shell` (ADR 0001 D3) inside a
# rootless network namespace so every egress channel (HTTP, WS,
# EventSource, sendBeacon, anchor ping, DNS, WebRTC STUN, raw IP,
# future IP APIs) has no reachable interface or route.
#
# The boundary is the `unshare --map-current-user --net` namespace,
# not any flag passed to the shell. The egress penetration harness
# (scripts/egress-penetration.ts) is the regression test for this
# boundary; the spike at .facet-build/phase-0-spikes/egress/
# demonstrated that 12 of 12 attempted channels block under this
# wrapper on the same chromium-build family.
#
# Sandbox-flag trade (pinned chrome-headless-shell 151.0.7922.77):
#
#   We DELIBERATELY keep Chromium's browser sandbox (`--no-sandbox` is
#   NOT added). The fidelity spike ran with `--no-sandbox` because it
#   was an isolated disposable experiment. The production tier keeps
#   the sandbox because:
#
#     1. `unshare --map-current-user` keeps the user uid (no root
#        transition), so Chromium does not require `--no-sandbox` to
#        start under the new userns.
#     2. A compromised renderer reaching the netns (no interfaces)
#        still benefits from the Chromium sandbox's syscall filter.
#
#   If a future shell release regresses this, the wrapper surfaces a
#   typed `tier1_launcher_missing` / `tier1_unavailable` and the
#   runner falls back to erroring — NEVER to running un-sandboxed.
#
# Usage: this script is invoked by puppeteer-core with `pipe: true`;
# it must `exec` so the unshare PID is reused (otherwise signals
# targeting the shell PID bypass the namespace).

set -eu

if [ -z "${FACET_TIER1_BROWSER_CACHE:-}" ]; then
  FACET_TIER1_BROWSER_CACHE="${HOME}/.cache/puppeteer/chrome-headless-shell"
fi

if [ -z "${FACET_TIER1_PINNED_VERSION:-}" ]; then
  FACET_TIER1_PINNED_VERSION="151.0.7922.77"
fi

# Resolve the pinned shell binary inside the cache. The wrapper does
# not hard-code the layout because the cache directory can be relocated
# via env var (CI runners, vendored copies).
candidate_a="${FACET_TIER1_BROWSER_CACHE}/${FACET_TIER1_PINNED_VERSION}/chrome-headless-shell-linux64/chrome-headless-shell"
candidate_b="${FACET_TIER1_BROWSER_CACHE}/linux-${FACET_TIER1_PINNED_VERSION}/chrome-headless-shell-linux64/chrome-headless-shell"

if [ -x "${candidate_a}" ]; then
  SHELL_BIN="${candidate_a}"
elif [ -x "${candidate_b}" ]; then
  SHELL_BIN="${candidate_b}"
else
  echo "tier1 launcher: pinned chrome-headless-shell ${FACET_TIER1_PINNED_VERSION} not found in ${FACET_TIER1_BROWSER_CACHE}" >&2
  exit 127
fi

# Hand off to unshare. The `--` terminates unshare's option parsing so
# a flag-shaped argv from puppeteer-core cannot be mistaken for a
# wrapper flag. `exec` replaces the shell process so the unshare PID
# is the chrome PID (signals reach the namespace directly).
exec unshare --map-current-user --net -- "${SHELL_BIN}" "$@"
