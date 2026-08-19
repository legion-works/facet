import { expect, test } from "bun:test";

import { TIER0_INPUT_CAP_BYTES } from "../../src/validation/sandbox/limits";
import {
  formatWorkerUnhandled,
  runWorkerLoop,
  splitWorkerInputLines,
} from "../../src/validation/tier0/worker-entry";

function readerFor(...chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return stream.getReader();
}

function validRequest(): string {
  return JSON.stringify({
    schemaVersion: "facet.tier0.v2",
    requestId: "request-1",
    revisionSha: "a".repeat(64),
    artifactType: "markdown",
    renderer: "svg",
    sourceBase64: Buffer.from("# heading").toString("base64"),
    lexical: {
      rendererRootSvgCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: 0,
    },
  });
}

test("accepts complete batched worker lines above the aggregate cap", () => {
  const line = "x".repeat(Math.floor(TIER0_INPUT_CAP_BYTES / 2) + 1);
  const parsed = splitWorkerInputLines(`${line}\n${line}\n`);

  expect(parsed.lines).toEqual([line, line]);
  expect(parsed.remainder).toBe("");
});

test("rejects one unterminated worker line above the cap", () => {
  expect(() => splitWorkerInputLines("x".repeat(TIER0_INPUT_CAP_BYTES + 1))).toThrow(
    "request line exceeds byte cap",
  );
});

test("carries an unterminated remainder across input chunks", () => {
  const first = splitWorkerInputLines('{"requestId":"req-1"');
  expect(first.lines).toEqual([]);
  expect(first.remainder).toBe('{"requestId":"req-1"');

  const second = splitWorkerInputLines(`${first.remainder}}\n`);
  expect(second.lines).toEqual(['{"requestId":"req-1"}']);
  expect(second.remainder).toBe("");
});

test("processes complete requests in-process and emits one response", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runWorkerLoop(
    readerFor(`${validRequest()}\n`),
    (text) => stdout.push(text),
    (text) => stderr.push(text),
  );

  expect(code).toBe(0);
  expect(stdout).toHaveLength(1);
  expect(stdout[0]).toContain('"requestId":"request-1"');
  expect(stderr).toEqual([]);
});

test("reports malformed requests without spawning a parser", async () => {
  const stderr: string[] = [];
  const code = await runWorkerLoop(
    readerFor("{\n"),
    () => {},
    (text) => stderr.push(text),
  );

  expect(code).toBe(2);
  expect(stderr[0]).toContain("tier0.worker.input_error");
});

test("reports an incomplete final request", async () => {
  const stderr: string[] = [];
  const code = await runWorkerLoop(
    readerFor(validRequest()),
    () => {},
    (text) => stderr.push(text),
  );

  expect(code).toBe(2);
  expect(stderr).toEqual(["tier0.worker.input_error incomplete request line\n"]);
});

test("formats unexpected worker failures for the subprocess boundary", () => {
  expect(formatWorkerUnhandled(new Error("boom"))).toBe("tier0.worker.unhandled boom\n");
  expect(formatWorkerUnhandled("boom")).toBe("tier0.worker.unhandled boom\n");
});
