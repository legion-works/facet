# Operators

Install `@legionworks/facet` with `bun add -g` (recommended), `npm i -g`, or
`pnpm add -g`. Bun `1.4.0` or newer is the required runtime; npm and pnpm are
distribution channels only. For a one-shot command, use
`bunx @legionworks/facet <verb>`. The pinned browser downloads on the first
visual read-back.

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

Facet targets one operator on a local machine. It keeps the last
`EVIDENCE_LAST_N_PER_ARTIFACT` Tier 1 runs per artifact plus retained runs. There
is no evidence quota.

## Gallery and evidence

Gallery display defaults to the system theme. The dark/light toggle persists
per tab and session; Tier 1 remains dark for deterministic parity.

Runtime errors after a gallery artifact's initial render appear in a status
region announced through `aria-live="polite"`. The signal does not alter the
stored verdict and clears when the revision changes or the gallery theme
changes.
A resource that fails to load, such as a remote image when there is no network
or an unreachable URL, does not trigger this runtime-error signal.

New render evidence is WebP; legacy evidence remains PNG. File-mode export
writes the artifact and sidecar and reports their paths and sizes. Use
`--include-bytes` only when an envelope consumer needs base64 bytes. See the
[export reference](../reference/export.md) for overwrite and error behavior.

When a successful result contains `screenshot_unavailable`, the artifact and
verdict may still be valid. Inspect the nested screenshot marker and do not
describe that result as screenshot-backed.
