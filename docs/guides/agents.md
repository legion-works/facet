# Agents

Facet is a CLI contract. Agents should not call its loopback routes directly.

## Workflow

```sh
facet status
facet create --project-id demo --slug chart --title "Chart"
printf '%s' "$SOURCE" | facet publish --artifact-id <id> --type markdown --file -
facet read-back --artifact-id <id> --revision-sha <sha> --tier 0
facet read-back --artifact-id <id> --revision-sha <sha> --tier visual
facet open --artifact-id <id> --revision-sha <sha>
```

Use the SHA returned by the publish envelope. Tier 0 is the default; visual
read-back is an explicit escalation. `open` asks a human to inspect the
sandboxed gallery.

The adapters in `src/harness-adapters/` forward argv and stdin to this CLI and
return stdout unchanged. The same rule applies to tool wrappers.

Refuse to publish when source content contains secrets or credentials. Do not
put tokens in artifacts, notes, shell history, or generated fixtures. Promotion
requires the operator capability and is never an agent action.

→ [CLI reference](../reference/cli.md) → [Architecture](../../ARCHITECTURE.md) → [Validation](../reference/validation.md) · [Storage](../reference/storage.md) · [Security](../reference/security.md) · [HTTP](../reference/http.md)
