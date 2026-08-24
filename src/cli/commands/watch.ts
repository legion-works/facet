import { createHash } from "node:crypto";
import { dirname, basename } from "node:path";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";

import type { FacetEnvelope } from "../../shared/contracts/envelope";

export interface WatchFileEvent {
  readonly eventType: "rename" | "change";
  readonly filename?: string | null;
}

export interface WatchHandle {
  close(): void;
}

export interface WatchPublishOptions {
  readonly filePath: string;
  readonly debounceMs?: number;
  readonly signal?: AbortSignal;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  readonly watchDirectory?: (
    directory: string,
    callback: (event: WatchFileEvent) => void,
  ) => WatchHandle;
  readonly hash?: (bytes: Uint8Array) => string | Promise<string>;
  readonly publish: (bytes: Uint8Array) => Promise<FacetEnvelope<unknown>>;
  readonly emit: (envelope: FacetEnvelope<unknown>) => void;
  readonly diagnostic?: (message: string) => void;
}

export interface WatchExit {
  readonly code: 0;
}

const defaultReadFile = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(path));

const defaultWatchDirectory = (
  directory: string,
  callback: (event: WatchFileEvent) => void,
): WatchHandle => {
  const watcher = watch(directory, (eventType, filename) => {
    callback(filename == null ? { eventType } : { eventType, filename: filename.toString() });
  });
  return { close: () => watcher.close() };
};

const defaultHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Keep the directory descriptor alive instead of the file descriptor: editors
 * commonly replace the inode during an atomic save.
 */
export async function watchPublishFile(options: WatchPublishOptions): Promise<WatchExit> {
  const read = options.readFile ?? defaultReadFile;
  const watchDirectory = options.watchDirectory ?? defaultWatchDirectory;
  const hash = options.hash ?? defaultHash;
  const target = basename(options.filePath);
  const debounceMs = options.debounceMs ?? 100;
  const signal = options.signal ?? new AbortController().signal;
  let lastHash: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const finish = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    handle.close();
    resolveExit?.();
  };

  const publishAttempt = async (): Promise<void> => {
    if (signal.aborted || running) return;
    running = true;
    try {
      const bytes = await read(options.filePath);
      const nextHash = await hash(bytes);
      if (nextHash === lastHash) {
        options.diagnostic?.("unchanged bytes — skipped publish");
        return;
      }
      lastHash = nextHash;
      options.emit(await options.publish(bytes));
    } catch (error) {
      options.diagnostic?.(
        `watch publish failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      running = false;
      if (pending && !signal.aborted) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    pending = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void publishAttempt();
    }, debounceMs);
  };

  const handle = watchDirectory(dirname(options.filePath), (event) => {
    if (event.filename !== undefined && event.filename !== null && event.filename !== target)
      return;
    schedule();
  });
  const abort = () => finish();
  signal.addEventListener("abort", abort, { once: true });
  await publishAttempt();
  if (signal.aborted) finish();
  await exited;
  signal.removeEventListener("abort", abort);
  return { code: 0 };
}
