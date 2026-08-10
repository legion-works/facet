import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const CHECK_SCRIPT = join(REPO_ROOT, "scripts", "check-renderer-bundle-parity.ts");

async function runParityCheck(
  options: {
    readonly parityMutation?: string;
    readonly staticMutation?: string;
  } = {},
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = Bun.spawn([process.execPath, CHECK_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...(options.parityMutation === undefined
        ? {}
        : { FACET_TEST_RENDERER_PARITY_MUTATION: options.parityMutation }),
      ...(options.staticMutation === undefined
        ? {}
        : { FACET_TEST_RENDERER_STATIC_MUTATION: options.staticMutation }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("gallery and Tier 1 renderer bundle parity", () => {
  test("every artifact type executes the same renderer modules in both bundles", async () => {
    const result = await runParityCheck();
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      chart: ["chart.ts", "svg.ts"],
      html: ["html.ts"],
      markdown: ["markdown.ts", "mermaid.ts", "svg.ts"],
      mermaid: ["mermaid.ts", "svg.ts"],
      svg: ["svg.ts"],
    });
  });

  test("the check turns red when a verifier bundle uses the wrong renderer entry", async () => {
    const result = await runParityCheck({ parityMutation: "html=chart" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("renderer bundle parity mismatch for html");
  });

  test("the check turns red when plain markdown statically reaches Mermaid", async () => {
    const result = await runParityCheck({ staticMutation: "markdown" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("initial renderer load mismatch for markdown");
  });
});
