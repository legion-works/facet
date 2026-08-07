# Architecture

## Trust boundaries

Facet separates byte storage, validation, rendering, and display. The service is byte-dumb: it hashes, stores, lexically counts, and serves bytes. It never imports renderers or parsers. Artifact code runs in a sandbox and never gains host capabilities.

## Lifecycle and data flow

An artifact enters through a one-shot source channel, is hashed and stored, then passes the validation ladder. Tier 0 is the default browser-free parser worker in a network namespace with no egress. Tier 1 is explicit: an ephemeral pinned chrome-headless-shell connects over a CDP pipe inside a no-egress network namespace. Tier 2 is the user's browser and is display-only.

The gallery uses opaque-origin iframe frames with `sandbox="allow-scripts"` and a frozen CSP. Two MessageChannels separate one-shot source ingress from closure-held control. Every revision receives a fresh frame. Double-buffered hot swap preserves shell view state while replacing the artifact frame.

Facet is lazy: dormant means zero processes, watchers, and ports. Extensions may register render types, but artifact code never receives host capabilities.
