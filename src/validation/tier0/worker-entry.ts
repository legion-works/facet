/**
 * Tier 0 worker subprocess entrypoint.
 *
 * The file remains the spawn path; protocol decoding and parser dispatch are
 * kept in focused modules so this entrypoint only owns process I/O.
 */

import { TIER0_INPUT_CAP_BYTES } from "../sandbox/limits";
import { parseWorkerInput, type WorkerInput } from "./worker-input";
import { runParser } from "./worker-dispatch";

export type { WorkerInput } from "./worker-input";

export function splitWorkerInputLines(buffered: string): {
  readonly lines: readonly string[];
  readonly remainder: string;
} {
  const lines: string[] = [];
  let remainder = buffered;
  let lineEnd = remainder.indexOf("\n");
  while (lineEnd >= 0) {
    const line = remainder.slice(0, lineEnd);
    if (Buffer.byteLength(line, "utf8") > TIER0_INPUT_CAP_BYTES) {
      throw new Error("request line exceeds byte cap");
    }
    lines.push(line);
    remainder = remainder.slice(lineEnd + 1);
    lineEnd = remainder.indexOf("\n");
  }
  if (Buffer.byteLength(remainder, "utf8") > TIER0_INPUT_CAP_BYTES) {
    throw new Error("request line exceeds byte cap");
  }
  return { lines, remainder };
}

export async function runWorkerLoop(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writeStdout: (text: string) => void,
  writeStderr: (text: string) => void,
): Promise<number> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    buffered += decoder.decode(value, { stream: true });
    let lines: readonly string[];
    try {
      ({ lines, remainder: buffered } = splitWorkerInputLines(buffered));
    } catch {
      writeStderr("tier0.worker.input_error request line exceeds byte cap\n");
      return 2;
    }
    for (const line of lines) {
      let input: WorkerInput;
      try {
        input = parseWorkerInput(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeStderr(`tier0.worker.input_error ${message}\n`);
        return 2;
      }
      let result;
      try {
        result = await runParser(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeStderr(`tier0.worker.parser_error ${message}\n`);
        return 3;
      }
      writeStdout(`${JSON.stringify({ requestId: input.requestId, result })}\n`);
    }
  }
  if (buffered.length > 0) {
    writeStderr("tier0.worker.input_error incomplete request line\n");
    return 2;
  }
  return 0;
}

export function formatWorkerUnhandled(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `tier0.worker.unhandled ${message}\n`;
}

if (import.meta.main) {
  runWorkerLoop(
    Bun.stdin.stream().getReader(),
    process.stdout.write.bind(process.stdout),
    process.stderr.write.bind(process.stderr),
  ).then(process.exit, (error) => {
    process.stderr.write(formatWorkerUnhandled(error));
    process.exit(1);
  });
}
