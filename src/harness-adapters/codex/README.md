# Facet adapter for Codex

Install the adapter where Codex can invoke local tools, then point it at
`facet.sh`. The adapter forwards argv and stdin to the Facet CLI and returns
stdout unchanged.

Use `facet status` before a workflow. Publish source through stdin; keep
secrets out of artifacts. Promotion remains operator-only.

→ [Facet agent skill](../../../skills/facet/SKILL.md) · [CLI reference](../../../docs/reference/cli.md)
