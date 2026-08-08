/**
 * Logging tests. Verifies:
 *  - one JSON object per line on STDERR (not stdout)
 *  - stdout stays clean (CLI envelopes live there, not diagnostics)
 *  - redact() removes any value whose key matches a sensitive name
 *    (case-insensitive substring match against the closed key list)
 *  - sensitive KEYS under any nesting depth are scrubbed
 *  - non-sensitive keys survive intact
 */

import { afterEach, describe, expect, test } from "bun:test";

import { redact, REDACT_PLACEHOLDER } from "../../src/shared/logging/redact";

function captureStreams(): { stderr: string[]; stdout: string[]; [Symbol.dispose]: () => void } {
  const captured = { stderr: [] as string[], stdout: [] as string[] };
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured.stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  return Object.assign(captured, {
    [Symbol.dispose]() {
      process.stderr.write = originalWrite;
      process.stdout.write = originalStdoutWrite;
    },
  });
}

afterEach(() => {
  // nothing per-test; stream capture is local to each test
});

describe("redact()", () => {
  test("replaces values whose key matches a redacted name (case-insensitive)", () => {
    const out = redact({
      Token: "secret-token",
      AUTHORIZATION: "Bearer xyz",
      source: "<svg>nope</svg>",
      nested: { Content: "secret-bytes", unrelated: "kept" },
      arr: [{ html: "<h1>x</h1>" }, { svg: "<svg></svg>", ok: "kept" }],
    });
    expect(out).toEqual({
      Token: REDACT_PLACEHOLDER,
      AUTHORIZATION: REDACT_PLACEHOLDER,
      source: REDACT_PLACEHOLDER,
      nested: { Content: REDACT_PLACEHOLDER, unrelated: "kept" },
      arr: [{ html: REDACT_PLACEHOLDER }, { svg: REDACT_PLACEHOLDER, ok: "kept" }],
    });
  });

  test("scrubs screenshot, dom, console keys anywhere in the tree", () => {
    const out = redact({
      render: {
        screenshot: "/tmp/secret.png",
        dom: "<html>nope</html>",
        console: ["log1", "log2"],
        verdict: { status: "ok" },
      },
    });
    expect(out).toEqual({
      render: {
        screenshot: REDACT_PLACEHOLDER,
        dom: REDACT_PLACEHOLDER,
        console: REDACT_PLACEHOLDER,
        verdict: { status: "ok" },
      },
    });
  });

  test("leaves primitives and non-sensitive keys untouched at any depth", () => {
    const out = redact({
      requestId: "req-1",
      count: 7,
      ok: true,
      nested: { list: [1, 2, 3], keep: "yes" },
    });
    expect(out).toEqual({
      requestId: "req-1",
      count: 7,
      ok: true,
      nested: { list: [1, 2, 3], keep: "yes" },
    });
  });

  test("returns primitives unchanged (including null/undefined/numbers)", () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
    expect(redact("plain text")).toBe("plain text");
    expect(redact(true)).toBe(true);
  });

  test("arrays of mixed sensitive/insensitive entries are scrubbed positionally", () => {
    const out = redact([{ token: "a" }, { keep: "b" }, { source: "c" }]);
    expect(out).toEqual([
      { token: REDACT_PLACEHOLDER },
      { keep: "b" },
      { source: REDACT_PLACEHOLDER },
    ]);
  });

  test("does NOT scrub a value just because it contains the substring of a sensitive key", () => {
    const out = redact({ authtokenless: "kept", sourceful: "kept" });
    expect(out).toEqual({ authtokenless: "kept", sourceful: "kept" });
  });
});

describe("FacetLogger", () => {
  test("writes exactly one JSON object per line to STDERR", async () => {
    const { createLogger } = await import("../../src/shared/logging/logger");
    using streams = captureStreams();
    const logger = createLogger({ component: "router" });
    logger.info("request.received", { requestId: "r1" });
    logger.warn("lease.expiring", { leaseId: "L1", artifactId: "a1" });
    logger.error("auth.failed", { code: "unauthorized" });
    expect(streams.stderr).toHaveLength(3);
    for (const line of streams.stderr) {
      expect(line.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(line);
      expect(typeof parsed).toBe("object");
      expect(parsed.level).toBeDefined();
      expect(parsed.event).toBeDefined();
      expect(parsed.timestamp).toBeDefined();
      expect(parsed.pid).toBe(process.pid);
      expect(parsed.component).toBe("router");
    }
  });

  test("stdout stays clean — diagnostics never leak there", async () => {
    const { createLogger } = await import("../../src/shared/logging/logger");
    using streams = captureStreams();
    const logger = createLogger({ component: "lifecycle" });
    logger.info("event.a");
    logger.error("event.b");
    expect(streams.stdout).toEqual([]);
  });

  test("scrubs sensitive keys before serializing — no token/authorization/source/etc in stderr", async () => {
    const { createLogger } = await import("../../src/shared/logging/logger");
    using streams = captureStreams();
    const logger = createLogger({ component: "auth" });
    logger.info("auth.verified", {
      token: "secret-token-123",
      authorization: "Bearer abc",
      source: "<svg>nope</svg>",
      html: "<h1>x</h1>",
      svg: "<svg></svg>",
      content: new Uint8Array([1, 2, 3]),
      screenshot: "/tmp/secret.png",
      dom: "<html></html>",
      console: ["nope"],
      requestId: "req-1",
    });
    const combined = streams.stderr.join("");
    expect(combined).not.toContain("secret-token-123");
    expect(combined).not.toContain("Bearer abc");
    expect(combined).not.toContain("<svg>nope</svg>");
    expect(combined).not.toContain("<h1>x</h1>");
    expect(combined).not.toContain("/tmp/secret.png");
    expect(combined).not.toContain("<html></html>");
    expect(combined).toContain("req-1"); // non-sensitive value survives
  });

  test("emits the required fields: level, event, component, timestamp, pid", async () => {
    const { createLogger } = await import("../../src/shared/logging/logger");
    using streams = captureStreams();
    const logger = createLogger({ component: "store" });
    logger.warn("disk.warning", { detail: "free space low" });
    const parsed = JSON.parse(streams.stderr[0]!);
    expect(parsed.level).toBe("warn");
    expect(parsed.event).toBe("disk.warning");
    expect(parsed.component).toBe("store");
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.timestamp).toBe("string");
  });

  test("durationMs / errorCode / artifactId / revisionSha are passed through when supplied", async () => {
    const { createLogger } = await import("../../src/shared/logging/logger");
    using streams = captureStreams();
    const logger = createLogger({ component: "router" });
    logger.info("publish.completed", {
      artifactId: "a-1",
      revisionSha: "a".repeat(64),
      durationMs: 42,
    });
    const parsed = JSON.parse(streams.stderr[0]!);
    expect(parsed.artifactId).toBe("a-1");
    expect(parsed.revisionSha).toBe("a".repeat(64));
    expect(parsed.durationMs).toBe(42);
  });

  test("child() preserves parent component and accumulates context", async () => {
    const { createLogger } = await import("../../src/shared/logging/logger");
    using streams = captureStreams();
    const root = createLogger({ component: "service" });
    const child = root.child("router");
    child.info("event.x", { requestId: "r-1" });
    const parsed = JSON.parse(streams.stderr[0]!);
    expect(parsed.component).toBe("router");
    expect(parsed.requestId).toBe("r-1");
  });
});
