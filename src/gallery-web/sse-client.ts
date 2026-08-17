/**
 * Authenticated SSE client for the gallery shell.
 *
 * The service's `/api/v1/stream` route emits `revision:committed`
 * events for the artifact bound to the current gallery lease. The
 * shell must authenticate every connect with `Authorization: Bearer`
 * + `X-Gallery-Lease` + `X-Gallery-Artifact` headers — EventSource
 * cannot set custom headers, so we use `fetch()` + ReadableStream
 * chunk-by-chunk parsing instead.
 *
 * On a `revision:committed` event the shell:
 *   1. Reacquires a fresh lease via the `open` command (rotated).
 *   2. Fetches the exact revision bytes.
 *   3. Triggers `replaceArtifactFrame` (double-buffered HMR swap).
 *
 * Reconnect: on transient network failure the client retries with a
 * fresh lease. The lease id is rotated on every reconnect so a stale
 * lease cannot leak via the SSE transport.
 */

export interface ConnectRevisionStreamOptions {
  readonly baseUrl: string;
  readonly bearer: string;
  readonly leaseId: string;
  readonly artifactId: string;
  /** Called for every `revision:committed` event. */
  readonly onCommit: (event: {
    readonly artifactId: string;
    readonly revisionSha: string;
    readonly revisionNumber: number;
    readonly artifactType: string;
    readonly at: string;
  }) => void;
  /** Connection lifecycle state for the gallery shell indicator. */
  readonly onState?: (state: "idle" | "connecting" | "live") => void;
  /** Optional: called for `stream:heartbeat` events (used by tests). */
  readonly onHeartbeat?: (event: { readonly streamId: string; readonly at: string }) => void;
  /** Optional: called on `stream:close`. */
  readonly onClose?: (event: {
    readonly streamId: string;
    readonly reason: string;
    readonly at: string;
  }) => void;
  /** Abort signal — caller cancels to tear down the stream. */
  readonly signal?: AbortSignal;
  /** Hostname guard — fires before the fetch. */
  readonly hostname: string;
  /** Inject for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface ConnectRevisionStreamHandle {
  /** Cancels the underlying stream + aborts any in-flight fetch. */
  close(): void;
}

const HEARTBEAT_PREFIX = ":";
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 100;

/**
 * Connect to the revision SSE stream. Returns a handle whose `close()`
 * tears down the connection. The handler MUST run on 127.0.0.1 — a
 * non-loopback hostname is rejected before the fetch starts.
 */
export function connectRevisionStream(
  options: ConnectRevisionStreamOptions,
): ConnectRevisionStreamHandle {
  if (options.hostname !== "127.0.0.1") {
    throw new Error(
      `Refusing to connect SSE: hostname must be 127.0.0.1 (got: ${JSON.stringify(options.hostname)})`,
    );
  }
  const fetcher = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, "")}/api/v1/stream`;
  const controller = new AbortController();
  options.onState?.("connecting");
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let closed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const closeWithReason = (reason: string): void => {
    options.onState?.("idle");
    options.onClose?.({ streamId: "", reason, at: new Date().toISOString() });
  };
  const reconnect = (reason: string): void => {
    if (closed) return;
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      closeWithReason(reason);
      return;
    }
    const delay = RECONNECT_DELAY_MS * 2 ** reconnectAttempt;
    reconnectAttempt += 1;
    options.onState?.("connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };
  const connect = async (): Promise<void> => {
    try {
      const response = await fetcher(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.bearer}`,
          "x-gallery-lease": options.leaseId,
          "x-gallery-artifact": options.artifactId,
          accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      if (response.status !== 200 || response.body === null) {
        const reason = `stream_status_${response.status}`;
        if (response.status === 401) closeWithReason(reason);
        else reconnect(reason);
        return;
      }
      reconnectAttempt = 0;
      options.onState?.("live");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Read chunk-by-chunk; SSE events are `data: <json>\n\n` blocks
      // separated by blank lines. Heartbeats are `: heartbeat\n\n`.
      // The `reader.read()` promise rejects when `close()` aborts the
      // controller, which is the cancellation signal — break out of
      // the loop without setting `closed` from inside.
      for (;;) {
        if (closed) break;
        const next = await reader.read().catch(() => ({ value: undefined, done: true }));
        const value = next.value;
        const done = next.done;
        if (done || value === undefined) break;
        buffer += decoder.decode(value, { stream: true });
        let blockEnd = buffer.indexOf("\n\n");
        while (blockEnd >= 0) {
          const block = buffer.slice(0, blockEnd);
          buffer = buffer.slice(blockEnd + 2);
          blockEnd = buffer.indexOf("\n\n");
          if (block.length === 0) continue;
          if (block.startsWith(HEARTBEAT_PREFIX)) continue;
          if (!block.startsWith("data: ")) continue;
          const payloadText = block.slice("data: ".length).trim();
          if (payloadText.length === 0) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(payloadText);
          } catch {
            continue;
          }
          dispatch(options, parsed);
        }
      }
      if (!closed) reconnect("stream_closed");
    } catch (error) {
      if (controller.signal.aborted) return;
      reconnect(error instanceof Error ? error.message : "stream_error");
    }
  };
  void connect();
  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      try {
        controller.abort();
      } catch {
        // already aborted
      }
      try {
        reader?.cancel().catch(() => undefined);
      } catch {
        // already cancelled
      }
    },
  };
}

function dispatch(options: ConnectRevisionStreamOptions, parsed: unknown): void {
  if (typeof parsed !== "object" || parsed === null) return;
  const record = parsed as Record<string, unknown>;
  if (record["type"] === "revision:committed") {
    options.onCommit({
      artifactId: String(record["artifactId"] ?? ""),
      revisionSha: String(record["revisionSha"] ?? ""),
      revisionNumber: Number(record["revisionNumber"] ?? 0),
      artifactType: String(record["artifactType"] ?? ""),
      at: String(record["at"] ?? new Date().toISOString()),
    });
    return;
  }
  if (record["type"] === "stream:heartbeat") {
    options.onHeartbeat?.({
      streamId: String(record["streamId"] ?? ""),
      at: String(record["at"] ?? new Date().toISOString()),
    });
    return;
  }
  if (record["type"] === "stream:close") {
    options.onClose?.({
      streamId: String(record["streamId"] ?? ""),
      reason: String(record["reason"] ?? ""),
      at: String(record["at"] ?? new Date().toISOString()),
    });
    return;
  }
}
