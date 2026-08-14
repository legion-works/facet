import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const acceptanceDirectory = join(import.meta.dir, "../acceptance");
const ciWorkflowPath = join(import.meta.dir, "../../.github/workflows/ci.yml");

const conditionalGatePatterns: readonly RegExp[] = [
  /FACET_LIVE_GALLERY/,
  /test\.skipIf/,
  /SKIP gallery-/,
];

function galleryAcceptanceFiles(): readonly string[] {
  return readdirSync(acceptanceDirectory)
    .filter((entry) => entry.startsWith("gallery-") && entry.endsWith(".test.ts"))
    .toSorted();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matrixListsFile(ciWorkflow: string, file: string): boolean {
  // A commented-out matrix line (`# - gallery-x.test.ts`) still contains the
  // substring `- gallery-x.test.ts`; anchor to a line that starts (after
  // leading whitespace) with the list marker so a comment can't satisfy it.
  return new RegExp(`^\\s+-\\s+${escapeRegExp(file)}\\s*$`, "m").test(ciWorkflow);
}

test("every gallery acceptance file runs unconditionally in CI", () => {
  const ciWorkflow = readFileSync(ciWorkflowPath, "utf8");
  const files = galleryAcceptanceFiles();
  expect(files.length).toBeGreaterThan(0);

  const unregistered: string[] = [];
  const conditional: string[] = [];

  for (const file of files) {
    if (!matrixListsFile(ciWorkflow, file)) unregistered.push(file);

    const source = readFileSync(join(acceptanceDirectory, file), "utf8");
    for (const pattern of conditionalGatePatterns) {
      if (pattern.test(source)) {
        conditional.push(`${file}: ${pattern}`);
        break;
      }
    }
  }

  expect(unregistered).toEqual([]);
  expect(conditional).toEqual([]);
  for (const pattern of conditionalGatePatterns) {
    expect(ciWorkflow).not.toMatch(pattern);
  }
});

test("deleted gallery acceptance files stay out of the CI matrix", () => {
  const ciWorkflow = readFileSync(ciWorkflowPath, "utf8");
  const removedFiles = ["tsx-interactive-isolation.test.ts", "nested-frame-denials.test.ts"];

  for (const file of removedFiles) {
    expect(matrixListsFile(ciWorkflow, file)).toBe(false);
  }
});
