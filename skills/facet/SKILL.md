---
name: facet
description: Use when creating, publishing, rendering, validating, or inspecting artifacts, diagrams, charts, SVG, Markdown, or gallery output with Facet.
---

# Facet

Facet is the CLI seam for artifact storage and verification. Keep artifact
bytes separate from host capabilities.

## Workflow

1. Run `facet status` before work. Dormant is healthy; `--start` is explicit.
2. Create with `facet create --project-id <id> --slug <slug> --title <title>`.
3. Publish bytes through stdin:

   ```sh
   printf '%s' "$SOURCE" | facet publish --artifact-id <id> --type markdown --file -
   ```

4. Read back at default Tier 0. Escalate with `facet read-back --tier visual`.
5. Use `facet open --artifact-id <id> --revision-sha <sha>` for human inspection.
6. Read back the exact `revision.sha256` returned by publish. Never substitute a
   latest revision lookup.

Tier 0 is the default. Tier 1 is explicit and browser-backed. `open` is Tier 2
display, not automated verification.

## Envelope

Success:

```json
{
  "schemaVersion": "facet.v1",
  "requestId": "req-…",
  "ok": true,
  "data": { "command": "status", "state": "dormant" }
}
```

Refusal:

```json
{
  "schemaVersion": "facet.v1",
  "requestId": "req-…",
  "ok": false,
  "error": { "code": "invalid_request", "message": "…", "retryable": false }
}
```

Branch on `ok` and `error.code`. A typed refusal is still a valid envelope and
normally exits 0. Exit 64 means the invocation could not be parsed; exit 70
means an unhandled internal failure.

## Boundaries

• Never inline secrets into artifact content, notes, commands, or fixtures.
• Promotion is operator-only; do not attempt to bypass its capability check.
• Keep adapter logic CLI-only. Do not call HTTP routes or read runtime paths.
• Preserve stdout exactly so callers can parse the versioned envelope.

→ [Agent workflow](../../docs/guides/agents.md) · [CLI reference](../../docs/reference/cli.md)
