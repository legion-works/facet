# First-class product contracts

Operator-ratified contract decisions for the installable-product arc
(binary distribution, `facet doctor`, MCP adapter, watch mode). Consumed by
the tasks in `.opencode/plans/2026-08-24-first-class-product.md`.

## Decisions

- binaryFallback: embedded-self-dispatch
- npmPublish: disabled
- doctorDormant: dormant-pass, missing-db-fail
- mcpDistribution: release-binary
- watchStdout: tty-text-and-ndjson-machine

## Rationale and rejected alternatives

### binaryFallback: embedded-self-dispatch

The compiled executable dispatches hidden service and Tier 0 worker roles
through argv self-dispatch, so one downloaded file is the whole product.
If the Bun 1.4.0 compile proof shows embedded self-dispatch cannot work,
the fallback is **no-standalone-binary for this arc**: the release keeps
its source archive and the workflow never labels a Bun-dependent binary
"standalone". Rejected: `companion-source-payload` (a binary that extracts
TypeScript sources beside itself) — more moving parts than the honesty it
buys; revisit as its own arc if embedded dispatch fails. Rejected: shipping
a binary that silently requires a Bun install — misleads the exact user a
binary exists for.

### npmPublish: disabled

Publishing requires an operator-provisioned `NPM_TOKEN` and a scope/name
decision (`@legion-works/facet` is the candidate). Neither exists today,
and the release binary covers the install story without any registry
dependency. Rejected for now, not forever: enable in a follow-up when the
operator provisions the token; the release workflow is structured so the
npm job can be added without reshaping the asset job.

### doctorDormant: dormant-pass, missing-db-fail

Dormant with no lock is the designed idle state ("zero processes, zero
ports") and passes. A stale, dead, or cross-version lock fails with the
reclaim guidance. A missing database fails with fix `facet status --start`
because migration parity cannot be measured against a database that does
not exist. Rejected: treating missing-DB as pass ("it would be created on
first start") — doctor's job is to verify the install can run, and an
unprovable migration state is not a verified state.

### mcpDistribution: release-binary

Releases carry a separate `facet-mcp-linux-x64` asset. The adapter finds
the CLI via `FACET_CLI` when set, defaulting to a sibling `facet` binary
in its own directory, falling back to PATH. Rejected: npm-only (npmPublish
is disabled); source-archive-only (excludes the binary-download user the
arc exists for).

### watchStdout: tty-text-and-ndjson-machine

`publish --watch` prints presenter lines on a TTY and emits one strict
versioned envelope per publish attempt as NDJSON when stdout is not a TTY
or `--format json` is passed. The documented one-envelope-per-command
guarantee gains a named exception scoped to `--watch`. Rejected:
ndjson-always (unreadable for the human iterating on an artifact, and the
human is watch mode's primary user); a single terminal envelope on exit
(defeats the purpose — consumers need per-publish verdicts as they land).
