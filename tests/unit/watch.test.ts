import { describe, expect, test } from "bun:test";

import { FACET_SCHEMA_VERSION, type FacetEnvelope } from "../../src/shared/contracts/envelope";
import {
  watchPublishFile,
  type WatchFileEvent,
  type WatchHandle,
} from "../../src/cli/commands/watch";
import { parseArgs, renderHelp } from "../../src/cli/parser";
import { FacetError } from "../../src/shared/errors/facet-error";

const envelope = (id: string): FacetEnvelope<unknown> => ({
  schemaVersion: FACET_SCHEMA_VERSION,
  requestId: id,
  ok: true,
  data: { command: "publish", revision: { sha256: id } },
});

function harness(initial: Uint8Array) {
  let bytes = initial;
  let onEvent: ((event: WatchFileEvent) => void) | undefined;
  let closed = false;
  const attempts: Uint8Array[] = [];
  const outputs: FacetEnvelope<unknown>[] = [];
  const watcher: WatchHandle = {
    close() {
      closed = true;
    },
  };
  const readFile = async () => bytes;
  const watchDirectory = (_directory: string, callback: (event: WatchFileEvent) => void) => {
    onEvent = callback;
    return watcher;
  };
  const publish = async (next: Uint8Array) => {
    attempts.push(next);
    return envelope(String(attempts.length));
  };
  return {
    setBytes(next: Uint8Array) {
      bytes = next;
    },
    emit(event: WatchFileEvent = { eventType: "change", filename: "artifact.md" }) {
      onEvent?.(event);
    },
    attempts,
    outputs,
    watcher,
    readFile,
    watchDirectory,
    publish,
    get closed() {
      return closed;
    },
  };
}

describe("watchPublishFile", () => {
  test("requires a file for watch mode and exposes help", () => {
    expect(
      parseArgs(["publish", "--artifact-id", "a", "--type", "markdown", "--watch"]),
    ).toMatchObject({
      kind: "usage",
    });
    expect(
      parseArgs([
        "publish",
        "--artifact-id",
        "a",
        "--type",
        "markdown",
        "--file",
        "source.md",
        "--watch",
      ]),
    ).toMatchObject({ kind: "verb", verb: "publish", args: { watch: true, file: "source.md" } });
    expect(renderHelp("publish")).toContain("--watch");
  });

  test("publishes initially and coalesces a burst", async () => {
    const h = harness(new Uint8Array([1]));
    const controller = new AbortController();
    const running = watchPublishFile({
      filePath: "/tmp/artifact.md",
      debounceMs: 5,
      signal: controller.signal,
      readFile: h.readFile,
      watchDirectory: h.watchDirectory,
      publish: h.publish,
      emit: (value) => h.outputs.push(value),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.setBytes(new Uint8Array([2]));
    h.emit();
    h.emit();
    h.emit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(running).resolves.toEqual({ code: 0 });
    expect(h.attempts.map((value) => [...value])).toEqual([[1], [2]]);
  });

  test("skips identical bytes and survives atomic rename", async () => {
    const h = harness(new Uint8Array([1]));
    const controller = new AbortController();
    const running = watchPublishFile({
      filePath: "/tmp/artifact.md",
      debounceMs: 5,
      signal: controller.signal,
      readFile: h.readFile,
      watchDirectory: h.watchDirectory,
      publish: h.publish,
      emit: (value) => h.outputs.push(value),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.emit();
    await new Promise((resolve) => setTimeout(resolve, 15));
    h.setBytes(new Uint8Array([3]));
    h.emit({ eventType: "rename", filename: "artifact.md.tmp" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    controller.abort();
    await expect(running).resolves.toEqual({ code: 0 });
    expect(h.attempts.map((value) => [...value])).toEqual([[1], [3]]);
    expect(h.closed).toBe(true);
  });

  test("does not retry forever after a single edit", async () => {
    const h = harness(new Uint8Array([1]));
    const controller = new AbortController();
    const running = watchPublishFile({
      filePath: "/tmp/artifact.md",
      debounceMs: 5,
      signal: controller.signal,
      readFile: h.readFile,
      watchDirectory: h.watchDirectory,
      publish: h.publish,
      emit: (value) => h.outputs.push(value),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.setBytes(new Uint8Array([2]));
    h.emit();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.attempts.map((value) => [...value])).toEqual([[1], [2]]);
    controller.abort();
    await expect(running).resolves.toEqual({ code: 0 });
  });

  test("clears the pending event before a timer-driven attempt", async () => {
    const h = harness(new Uint8Array([1]));
    const controller = new AbortController();
    const timers: Array<() => void> = [];
    const running = watchPublishFile({
      filePath: "/tmp/artifact.md",
      debounceMs: 5,
      signal: controller.signal,
      readFile: h.readFile,
      watchDirectory: h.watchDirectory,
      setTimer: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimer: (timer) => {
        const index = timers.indexOf(timer as () => void);
        if (index >= 0) timers.splice(index, 1);
      },
      publish: h.publish,
      emit: (value) => h.outputs.push(value),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.setBytes(new Uint8Array([2]));
    h.emit();
    expect(timers).toHaveLength(1);
    timers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.attempts.map((value) => [...value])).toEqual([[1], [2]]);
    expect(timers).toHaveLength(0);
    controller.abort();
    await expect(running).resolves.toEqual({ code: 0 });
  });

  test("emits a typed envelope when publishing cannot reach the service", async () => {
    const h = harness(new Uint8Array([1]));
    const controller = new AbortController();
    const running = watchPublishFile({
      filePath: "/tmp/artifact.md",
      debounceMs: 5,
      signal: controller.signal,
      readFile: h.readFile,
      watchDirectory: h.watchDirectory,
      publish: async () => {
        throw new FacetError("internal", "Connection failed", { retryable: true });
      },
      emit: (value) => h.outputs.push(value),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0]).toMatchObject({ ok: false, error: { code: "internal" } });
    controller.abort();
    await expect(running).resolves.toEqual({ code: 0 });
  });
});
