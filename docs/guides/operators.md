# Operators

## Display an artifact

`facet open` is **Tier 2 DISPLAY**. It opens one loopback-only gallery URL in
the user's default browser through `xdg-open`. Facet does not start a browser
process, and the user's browser is not an automated verifier.

The URL carries a one-time bootstrap hand-off only. The install token never
appears in the URL, shell history, or browser history. After the gallery shell
exchanges the hand-off, stream and API requests use an `Authorization` header
and the `X-Gallery-Lease` header. Lease capabilities are never accepted from
query parameters.

Closing the gallery releases the display lease. When no other work holds the
service open, the idle controller may exit the service.

## Promote a revision

Promotion is operator-only. Discover the token from `FACET_PROMOTE_TOKEN`; if
it is unset, read `FACET_HOME/secrets/promote.token`. Never pass the token on
argv or place it in source, notes, fixtures, or shell history.

Promotion records operator identity and timestamp and changes retention and
audit state, not validation trust or sandbox trust. A promoted revision is not
more valid because it was promoted. See [Security](../reference/security.md)
for the capability boundary.

## Automated read-back

Authoritative automated read-back remains the pinned Tier 1 browser. Use
`facet read-back --tier 1` for that verdict. Tier 2 display and Tier 1
verification are decoupled: a user's browser displays the sandboxed structured
artifact, while the pinned browser supplies the automated result.

## Gallery and evidence

Gallery display defaults to the system theme. The dark/light toggle persists
per tab and session; Tier 1 remains dark for deterministic parity.

New render evidence is WebP; legacy evidence remains PNG. File-mode export
writes the artifact and sidecar and reports their paths and sizes. Use
`--include-bytes` only when an envelope consumer needs base64 bytes. See the
[export reference](../reference/export.md) for overwrite and error behavior.

When a successful result contains `screenshot_unavailable`, the artifact and
verdict may still be valid. Inspect the nested screenshot marker and do not
describe that result as screenshot-backed.
