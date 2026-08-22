/**
 * Resource caps for the Tier 1 verifier.
 *
 * Each cap is named and exposed so the runner, the harness builder,
 * and the penetration test agree on a single value. A failing cap
 * produces a typed `FacetError` with the matching `tier1_*` code.
 */

/**
 * Wall-clock budget for one Tier 1 verifier invocation. The harness
 * bundles the REAL renderers (mermaid + marked + vega, ~8 MB inline);
 * parse + first render of a 40-node fixture needs real headroom.
 */
export const TIER1_TIMEOUT_MS = 60_000;

/**
 * Path to the pinned `chrome-headless-shell` distribution. The release
 * manifest pins a specific revision; the default resolves the first
 * match under `~/.cache/puppeteer/chrome-headless-shell/`. Tests inject
 * a custom resolver so the path does not become load-bearing on a
 * specific dev workstation.
 */
export { TIER1_PINNED_VERSION } from "../../shared/config/limits";

/** Network namespace label recorded with each Tier 1 run. */
export const TIER1_NETWORK_NAMESPACE = "facet-tier1-egress-isolated";

/** Lifetime of the ephemeral browser user-data directory (mode 0700). */
export const TIER1_USER_DATA_DIR_MODE = 0o700;

/**
 * Per-render timeout the verifier waits for the trusted
 * `render-complete` barrier before classifying the run as `timeout`.
 * Sized for the real mermaid runtime: first-render initialization of
 * the bundled runtime plus a 40-node layout must fit inside.
 */
export const TIER1_RENDER_BARRIER_MS = 30_000;

/**
 * Time between the first interactive TSX observation and its bounded
 * stability re-check. It stays below the headroom after the render barrier so
 * a typed `partial:unstable` verdict remains observable before Tier 1 times out.
 */
export const TSX_STABILITY_WINDOW_MS = 1_000;

/**
 * Ceiling for any single CDP call. Every protocol round-trip in a
 * healthy session completes in well under a second; a call that
 * outlives this budget means the pipe transport silently wedged
 * (observed: a browser spawned immediately after another browser's
 * teardown can have its devtools pipe torn down while the process
 * stays alive — every subsequent call pends forever). The runner
 * treats the typed rejection as retryable and relaunches once.
 */
export const TIER1_CDP_CALL_WATCHDOG_MS = 10_000;

/** Screenshot evidence has a tighter deadline than the verifier transport watchdog. */
export const TIER1_SCREENSHOT_CAPTURE_TIMEOUT_MS = 2_000;
export const TIER1_SCREENSHOT_CAPTURE_ATTEMPTS = 2;

/** Deterministic viewport used for Tier 1 layout and screenshot evidence. */
export const TIER1_VIEWPORT_WIDTH = 1280;
export const TIER1_VIEWPORT_HEIGHT = 800;

/** Maximum CSS axis length for a whole-artifact evidence image. */
export const TIER1_SCREENSHOT_MAX_AXIS_PX = 4096;

/** Maximum decoded pixel count for a whole-artifact evidence image. */
export const TIER1_SCREENSHOT_MAX_PIXELS = 8_388_608;

/** Static evidence uses WebP at this quality. */
export const TIER1_SCREENSHOT_WEBP_QUALITY = 82;

/** Animated evidence samples four frames at fixed browser-time intervals. */
export const TIER1_ANIMATION_FRAME_COUNT = 4;
export const TIER1_ANIMATION_FRAME_INTERVAL_MS = 150;
export const TIER1_ANIMATION_WEBP_QUALITIES = [TIER1_SCREENSHOT_WEBP_QUALITY, 70, 55] as const;

/** Whole-artifact evidence above this cap after scaling and quality fallback is screenshot_unavailable. */
export const TIER1_SCREENSHOT_CAP_BYTES = 8 * 1024 * 1024;
