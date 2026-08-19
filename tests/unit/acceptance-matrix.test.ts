import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dir, "../..");
const WORKFLOW_PATH = join(REPOSITORY_ROOT, ".github/workflows/ci.yml");
const ACCEPTANCE_DIRECTORY = join(REPOSITORY_ROOT, "tests/acceptance");

function matrixLegs(workflow: string): string[] {
  const start = workflow.indexOf("  acceptance-tier1:");
  const end = workflow.indexOf("    name: acceptance-tier1", start);
  if (start < 0 || end < 0) throw new Error("acceptance-tier1 matrix is missing");
  return [...workflow.slice(start, end).matchAll(/^\s+- ([\w.-]+\.test\.ts)$/gm)].map(
    (match) => match[1]!,
  );
}

test("every acceptance matrix leg exists on disk", () => {
  const matrix = matrixLegs(readFileSync(WORKFLOW_PATH, "utf8"));
  const onDisk = new Set(
    readdirSync(ACCEPTANCE_DIRECTORY).filter((entry) => entry.endsWith(".test.ts")),
  );

  for (const testFile of matrix) expect(onDisk).toContain(testFile);
});
