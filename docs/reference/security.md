# Security reference

Facet uses two bearer capabilities:

• The install token authorizes ordinary agent/service commands.
• The distinct operator promote capability authorizes `promote`.

Promotion requires the operator token and records the operator identity and timestamp. Structured logs contain request, artifact, revision, and timestamp identifiers only; source bytes and bearer tokens are redacted and never logged.

TTY presence is not authorization. An agent can allocate a PTY; only the distinct operator token can promote. Promotion changes retention and audit state, not validation tier or sandbox trust.

## Insecure mode

Insecure mode is never enabled by default. It is boot-only: set `FACET_INSECURE=1`,
`2`, or `3`, then restart the service. Environment changes do not alter a live
service.

| level | contract                                                                                      |
| ----: | --------------------------------------------------------------------------------------------- |
|   `0` | Secure defaults. Tier 0 and Tier 1 use their normal isolation.                                |
|   `1` | Removes Tier 1 network-namespace isolation only. Real Tier 0 and Tier 1 validators still run. |
|   `2` | Removes Tier 0 and Tier 1 network-namespace isolation. Real validators still run.             |
|   `3` | Performs no validation and records `insecure:unvalidated`.                                    |

Levels compose as a forced floor: the effective level is never below the
operator's `FACET_INSECURE` value. `FACET_INSECURE_AUTO=1` may raise a level when
startup probes fail, but it never selects level 3. With auto mode off, hard
`tier*_unavailable` errors remain hard errors.

L1 and L2 statuses are real validator results and must be read with their
`Verdict.insecure` marker. Do not call them unvalidated; only L3 owns
`insecure:unvalidated`. Startup, the service-ready envelope, CLI output, and
gallery badge are intentionally loud. The CLI emits an `INSECURE` line.
