import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runOnce(args: string[], env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const proc = Bun.spawn([process.execPath, "run", "src/cli/main.ts", ...args], {
    cwd: resolve(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(text) as Record<string, unknown>;
}

describe("publish --watch CLI", () => {
  test("streams initial and changed envelopes, then exits cleanly on SIGINT", async () => {
    const root = mkdtempSync(join(tmpdir(), "facet-watch-cli-"));
    roots.push(root);
    const home = join(root, "home");
    const source = join(root, "source.md");
    mkdirSync(home, { recursive: true });
    writeFileSync(source, "first\n");
    const env = { ...process.env, FACET_HOME: home };
    const created = await runOnce(
      ["create", "--project-id", "watch", "--slug", "artifact", "--title", "Watch"],
      env,
    );
    const artifactId = String((created.data as { artifact?: { id?: string } }).artifact?.id);
    expect(artifactId).not.toBe("undefined");
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        "src/cli/main.ts",
        "publish",
        "--artifact-id",
        artifactId,
        "--type",
        "markdown",
        "--file",
        source,
        "--watch",
      ],
      { cwd: resolve(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe" },
    );
    const stream = proc.stdout.getReader();
    const lines: string[] = [];
    const readLine = async () => {
      while (true) {
        const { value, done } = await stream.read();
        if (done) return false;
        const text = new TextDecoder().decode(value);
        lines.push(...text.split("\n").filter((line) => line.length > 0));
        if (lines.length > 0) return true;
      }
    };
    await expect(readLine()).resolves.toBe(true);
    writeFileSync(source, "second\n");
    await expect(readLine()).resolves.toBe(true);
    expect(lines.map((line) => JSON.parse(line))).toHaveLength(2);
    proc.kill("SIGINT");
    await expect(proc.exited).resolves.toBe(0);
  }, 30_000);

  test("emits a typed envelope after the service dies mid-watch", async () => {
    const root = mkdtempSync(join(tmpdir(), "facet-watch-death-"));
    roots.push(root);
    const home = join(root, "home");
    const source = join(root, "source.md");
    mkdirSync(home, { recursive: true });
    writeFileSync(source, "first\n");
    const env = { ...process.env, FACET_HOME: home };
    const created = await runOnce(
      ["create", "--project-id", "watch", "--slug", "death", "--title", "Death"],
      env,
    );
    const artifactId = String((created.data as { artifact?: { id?: string } }).artifact?.id);
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        "src/cli/main.ts",
        "publish",
        "--artifact-id",
        artifactId,
        "--type",
        "markdown",
        "--file",
        source,
        "--watch",
      ],
      { cwd: resolve(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe" },
    );
    const reader = proc.stdout.getReader();
    const lines: string[] = [];
    let buffered = "";
    const readLine = async () => {
      while (true) {
        const complete = buffered.indexOf("\n");
        if (complete >= 0) {
          const line = buffered.slice(0, complete);
          buffered = buffered.slice(complete + 1);
          if (line.length > 0) {
            lines.push(line);
            return true;
          }
        }
        const { value, done } = await reader.read();
        if (done) return false;
        buffered += new TextDecoder().decode(value);
      }
    };
    await expect(readLine()).resolves.toBe(true);
    const lock = JSON.parse(readFileSync(join(home, "run", "facet.lock"), "utf8")) as {
      pid: number;
    };
    process.kill(lock.pid, "SIGKILL");
    writeFileSync(source, "after-death\n");
    await expect(readLine()).resolves.toBe(true);
    const failure = JSON.parse(lines[1] ?? "{}");
    expect(failure).toMatchObject({
      ok: false,
      error: {
        code: "invalid_envelope",
        retryable: true,
        details: { reason: "connection_failed" },
      },
    });
    proc.kill("SIGINT");
    await expect(proc.exited).resolves.toBe(0);
  }, 30_000);
});
