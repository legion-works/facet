import { createHash } from "node:crypto";
import { dirname, basename } from "node:path";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";

import { errEnvelope, type FacetEnvelope } from "../../shared/contracts/envelope";
import { FacetError } from "../../shared/errors/facet-error";
import { generateRequestId } from "../../shared/util/time";

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
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
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
  const setTimer =
    options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let lastHash: string | undefined;
  let timer: unknown;
  let running = false;
  let pending = false;
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const finish = () => {
    if (timer !== undefined) clearTimer(timer);
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
      const response = await options.publish(bytes);
      lastHash = nextHash;
      options.emit(response);
    } catch (error) {
      const facet = FacetError.from(error);
      options.emit(errEnvelope(generateRequestId(), facet.toBody()));
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
    if (running) {
      pending = true;
      return;
    }
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => {
      timer = undefined;
      void publishAttempt();
    }, debounceMs);
  };

  const handle = watchDirectory(dirname(options.filePath), (event) => {
    // Atomic saves often report only the temporary inode's rename, not the
    // final target name; any rename in the parent directory may be the save.
    if (
      event.eventType !== "rename" &&
      event.filename !== undefined &&
      event.filename !== null &&
      event.filename !== target
    )
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
