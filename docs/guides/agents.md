# Agents

Facet is a CLI contract. Agents should not call its loopback routes directly.

## Safe automation workflow

1. Run `facet status`. Use `facet status --start` only when activation is
   intended.
2. Choose an artifact type from the [canonical skill table](../../skills/facet/SKILL.md#choose-the-artifact-type).
3. Create the artifact once, then publish source bytes from a file or stdin:

   ```sh
   facet create --project-id demo --slug chart --title "Chart"
   facet publish --artifact-id <id> --type markdown --file path/to/source.md
   printf '%s' "$SOURCE" | facet publish --artifact-id <id> --type markdown
   ```

4. Parse the top-level `ok`. When it is true, inspect `data.verdict.status`
   separately and retain `data.verdict.revisionSha`. A successful envelope can
   contain a verdict with `status: "error"`.
5. Read back Tier 0/latest with `facet read-back --artifact-id <id>`. Omit the
   SHA for the latest revision; pass the exact SHA when the task must bind to a
   specific revision.
6. Request Tier 1 or visual read-back only when browser evidence is required.
7. Never promote. Never put secrets or credentials in source, notes, fixtures,
   artifacts, or shell history.

The adapters in `src/harness-adapters/` forward argv and stdin to this CLI and
return stdout unchanged. The same rule applies to tool wrappers.

Agents must never run `facet open`; it is Tier 2 human display. Ensure the
service is active with `facet status --start`, then use the documented
[Steel/browser workflow](../../skills/facet/SKILL.md#boundaries) or request human inspection.

→ [CLI reference](../reference/cli.md) → [Architecture](../../ARCHITECTURE.md) → [Validation](../reference/validation.md) · [Storage](../reference/storage.md) · [Security](../reference/security.md) · [HTTP](../reference/http.md)
