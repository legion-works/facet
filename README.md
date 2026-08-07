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

The CLI examples are the product contract; the CLI ships in a later release stage.

→ [Architecture](ARCHITECTURE.md) · [Structure](STRUCTURE.md) · [Contributing](CONTRIBUTING.md)
