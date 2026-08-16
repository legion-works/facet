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

async function main(): Promise<number> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    buffered += decoder.decode(value, { stream: true });
    if (Buffer.byteLength(buffered, "utf8") > TIER0_INPUT_CAP_BYTES) {
      process.stderr.write("tier0.worker.input_error request line exceeds byte cap\n");
      return 2;
    }
    let lineEnd = buffered.indexOf("\n");
    while (lineEnd >= 0) {
      const line = buffered.slice(0, lineEnd);
      buffered = buffered.slice(lineEnd + 1);
      lineEnd = buffered.indexOf("\n");
      if (Buffer.byteLength(line, "utf8") > TIER0_INPUT_CAP_BYTES) {
        process.stderr.write("tier0.worker.input_error request line exceeds byte cap\n");
        return 2;
      }
      let input: WorkerInput;
      try {
        input = parseWorkerInput(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`tier0.worker.input_error ${message}\n`);
        return 2;
      }
      let result;
      try {
        result = await runParser(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`tier0.worker.parser_error ${message}\n`);
        return 3;
      }
      process.stdout.write(`${JSON.stringify({ requestId: input.requestId, result })}\n`);
    }
  }
  if (buffered.length > 0) {
    process.stderr.write("tier0.worker.input_error incomplete request line\n");
    return 2;
  }
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`tier0.worker.unhandled ${message}\n`);
      process.exit(1);
    },
  );
}
