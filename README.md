# Facet

Facet is a local artifact rendering and verification service for agent-generated content. It stores bytes without interpreting them, renders artifacts in a sandboxed gallery, and applies a validation ladder from browser-free parsing to explicit browser display.

## Install

```sh
bun install
```

## Publish and inspect

```sh
facet publish ./artifact.md
facet open
facet read-back --tier visual
```

The CLI is the product contract. Agent workflows and adapter guidance live in
[Agents](docs/guides/agents.md).

Facet's insecure mode is an explicit, boot-only opt-in (`FACET_INSECURE=1|2|3`)
and is never the default. It weakens or skips validation by level, marks every
affected verdict, and speaks loudly at startup, in envelopes, in the CLI, and
in the gallery. Restart after changing the environment.

→ [Agents](docs/guides/agents.md) · [CLI reference](docs/reference/cli.md) · [Architecture](ARCHITECTURE.md) · [Structure](STRUCTURE.md) · [Verification](docs/verification/v1-ship-gate.md) · [Contributing](CONTRIBUTING.md)
