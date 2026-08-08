/**
 * Resource caps for the Tier 1 verifier.
 *
 * Each cap is named and exposed so the runner, the harness builder,
 * and the penetration test agree on a single value. A failing cap
 * produces a typed `FacetError` with the matching `tier1_*` code.
 */

/** Wall-clock budget for one Tier 1 verifier invocation. */
export const TIER1_TIMEOUT_MS = 5_000;

/**
 * Path to the pinned `chrome-headless-shell` distribution. The release
 * manifest pins a specific revision; the default resolves the first
 * match under `~/.cache/puppeteer/chrome-headless-shell/`. Tests inject
 * a custom resolver so the path does not become load-bearing on a
 * specific dev workstation.
 */
export const TIER1_PINNED_VERSION = "131.0.6778.204";

/** Network namespace label recorded with each Tier 1 run. */
export const TIER1_NETWORK_NAMESPACE = "facet-tier1-egress-isolated";

/** Lifetime of the ephemeral browser user-data directory (mode 0700). */
export const TIER1_USER_DATA_DIR_MODE = 0o700;

/**
 * Stderr/console cap for the verifier harness bundle. The bundle is
 * small (mermaid + harness); 256 KiB bounds anything pathological.
 */
export const TIER1_HARNESS_BUNDLE_CAP_BYTES = 256 * 1024;

/**
 * Per-render timeout the verifier waits for the trusted
 * `render-complete` barrier before classifying the run as `timeout`.
 */
export const TIER1_RENDER_BARRIER_MS = 4_000;
