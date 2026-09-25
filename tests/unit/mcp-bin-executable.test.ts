import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("MCP bin executes directly and responds to initialize", async () => {
  const entry = resolve(import.meta.dir, "../../src/harness-adapters/mcp/main.ts");
  const proc = Bun.spawn([entry], {
    env: { ...process.env, PATH: `${resolve(process.execPath, "..")}:${process.env.PATH ?? ""}` },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "mcp-bin-smoke", version: "0.0.0" },
      },
    }) + "\n",
  );
  proc.stdin.end();
  const timeout = setTimeout(() => proc.kill(), 5000);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const reply = stdout
      .split("\n")
      .filter(Boolean)
      .map(
        (line) => JSON.parse(line) as { id?: number; result?: { serverInfo?: { name?: string } } },
      )
      .find((message) => message.id === 1);
    expect(reply?.result?.serverInfo?.name).toBe("facet");
    expect(stderr).toBe("");
  } finally {
    clearTimeout(timeout);
    proc.kill();
    await proc.exited;
  }
});
