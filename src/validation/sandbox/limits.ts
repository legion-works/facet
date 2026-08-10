/**
 * Resource caps applied to the Tier 0 parse worker.
 *
 * Each cap is named and exposed so tests, the runner, and the netns
 * wrapper can agree on a single value. A failing cap produces a typed
 * Tier 0 failure (timeout, output cap, …) that the parent maps to a
 * `Tier0Result` (or, when the worker cannot even start, a typed
 * `FacetError`).
 */

/** Wall-clock budget for one Tier 0 worker invocation. */
export const TIER0_TIMEOUT_MS = 5_000;

/**
 * Maximum number of bytes the worker may write to STDOUT before the
 * parent truncates the stream and records a typed protocol error.
 * 64 KiB is well above the bounded `Tier0Result` JSON size (a few
 * hundred bytes for the four supported artifact types) so the cap
 * only fires for a misbehaving worker.
 */
export const TIER0_OUTPUT_CAP_BYTES = 64 * 1024;

/** Maximum NDJSON request line accepted by the long-lived Tier 0 worker. */
export const TIER0_INPUT_CAP_BYTES = 8 * 1024 * 1024;

/**
 * Linux `setrlimit` cap on the worker's resident memory. Enforced via
 * `bash -c 'ulimit -v …; exec "$@"'` inside the netns wrapper so the
 * Bun process inherits the limit on startup. 512 MiB is generous for
 * `marked`/`mermaid`/`vega-lite` `compile()` on the 5 MiB source cap;
 * a hostile artifact that allocates past this cap is killed by SIGKILL
 * and surfaced as `tier0_worker_died`.
 */
export const TIER0_MEMORY_CAP_BYTES = 512 * 1024 * 1024;
