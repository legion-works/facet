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

## Automated read-back

Authoritative automated read-back remains the pinned Tier 1 browser. Use
`facet read-back --tier 1` for that verdict. Tier 2 display and Tier 1
verification are decoupled: a user's browser displays the sandboxed structured
artifact, while the pinned browser supplies the automated result.
