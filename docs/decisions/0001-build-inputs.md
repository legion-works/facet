# ADR 0001 — Build inputs

Six inputs that bound Facet's v1 build are frozen in this record. Each entry
records the resolved value and the reason it is the chosen bound. Renderer
complexity (node counts, nesting depth) is governed by separate guards and
is not folded into these inputs.

## D1: CLI executable

Decision: `facet` is the only executable and command name.

No compatibility alias is shipped. No prior executable name has ever been
released, so there is nothing to alias; introducing an alias would carry a
maintenance burden without a corresponding user-facing reason. The single
name keeps install paths, manpages, and shell completions unambiguous.

## D2: Source cap

Decision: 5 MiB hard cap on artifact source bytes.

Pre-release benchmarks measured 20/20 clean renders through 5 MB with no
latency or resident-set-size cliff. At 10 MB, ingress plus render p95
breaches the 200 ms visibility budget. The 5 MiB bound is the highest value
that stays inside the latency budget across the rendered set, so it is set
as a hard cap rather than a soft target. Renderer-complexity limits — node
counts and nesting depth — are separate guards that run alongside the byte
cap; the byte cap is not a substitute for them.

## D3: Tier-1 distribution and driver

Decision: pinned `chrome-headless-shell` 131.0.6778.204, downloaded and
checksum-pinned in the release manifest. The driver is `puppeteer-core`
initially, isolated behind a `Tier1Browser` interface so a raw
Chrome-DevTools-Protocol implementation can replace it without changing any
caller. Connection uses `--remote-debugging-pipe` rather than the WebSocket
CDP transport.

The pin prevents silent drift to a newer Chrome between releases; a fresh
manifest entry with a verified checksum is the only way the version moves.
The interface isolation keeps driver choice a private implementation detail:
today `puppeteer-core`, tomorrow a direct CDP client, callers do not change.
The pipe transport is required because WebSocket CDP cannot connect inside
a network namespace where loopback is down — the pipe survives that
configuration, which is the default for Facet's egress-isolated runs.

## D4: Operator capability provisioning

Decision: promotion uses a separate promote-capability token, distinct from
the install or agent token. The token is stored mode 0600 outside any
agent-facing path. It is never injected into agent environment variables,
never placed in the agent's current-working-directory token path, and never
exposed through the CLI's agent-facing surface. Promotion requires this
credential; `promoted_by` and `promoted_at` audit fields are mandatory on
every promoted record. A test asserts that an agent-token-only call is
denied.

Documented residual (accepted for v1): on a single-user machine, any process
running as that user can read any 0600 file that user owns. Provisioning
separation plus audit is the v1 boundary, not a cryptographic one. True
separation — an OS keychain, a separate user id, a hardware token, or
interactive-only entry — is deferred to a future `AuthorizationPolicy`
revision that will harden the promote path beyond file permissions.

## D5: Design-token snapshot

Decision: a pinned snapshot of the Legion Works design tokens is vendored
into the repository under `src/gallery-web/styles/` together with a vendored
fonts directory. The snapshot records Legion Cyan `#86E1FC`, IceTea Amber
`#FF966C`, deep navy `#16161E`, and the Space Grotesk, Geist, and JetBrains
Mono font files. There is no runtime CDN and no live token watcher; the
loopback gallery renders fully offline and creates no gallery egress.

Vendoring freezes the visual contract at the recorded snapshot version. A
later design refresh lands as a new vendored snapshot with its own version,
not as a live fetch at runtime. Offline rendering removes a class of egress
from the gallery path and keeps the loopback surface deterministic.

## D6: Netns CI runner

Decision: GitHub-hosted `ubuntu-latest` is the default CI runner. The job
runs an explicit proof step that proves rootless user and network namespaces
are available: `unshare --map-current-user --net -- true`, followed by a
real zero-leak run of the egress penetration harness. The proof step fails
the job — it never skips — if either namespace is unavailable. If a future
GitHub-hosted image change proves the runner cannot provide the namespaces,
the documented fallback is a named self-hosted Linux runner with
unprivileged user namespaces enabled. Branch protection requires the
`security-egress` check; the check executes when relevant paths change and
reports success when they do not, and it is never a check that silently
fails to be created.

The proof step is the contract: an image that loses unprivileged namespaces
fails the build rather than rendering the harness against a broken
environment. The fallback runner carries the same proof step so the
contract is preserved if the default runner is retired.
