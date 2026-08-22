import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../..");

function readReference(name: string): string {
  return readFileSync(join(repositoryRoot, "docs/reference", name), "utf8");
}

function unescapedPipeCount(line: string): number {
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "|" || line[index - 1] === "\\") continue;
    count += 1;
  }
  return count;
}

function assertTableRowsHaveNoUnescapedCellPipes(document: string): void {
  const lines = document.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const separator = lines[index]!;
    if (!/^\s*\|?\s*:?-{3,}/.test(separator)) continue;

    const expectedPipes = unescapedPipeCount(separator);
    expect(expectedPipes, `invalid table separator at line ${index + 1}`).toBeGreaterThan(0);

    for (
      let rowIndex = index - 1;
      rowIndex >= 0 && /^\s*\|/.test(lines[rowIndex]!);
      rowIndex -= 1
    ) {
      expect(
        unescapedPipeCount(lines[rowIndex]!),
        `unescaped table-cell pipe at line ${rowIndex + 1}`,
      ).toBe(expectedPipes);
    }
    for (
      let rowIndex = index + 1;
      rowIndex < lines.length && /^\s*\|/.test(lines[rowIndex]!);
      rowIndex += 1
    ) {
      expect(
        unescapedPipeCount(lines[rowIndex]!),
        `unescaped table-cell pipe at line ${rowIndex + 1}`,
      ).toBe(expectedPipes);
    }
  }
}

test("export documentation describes WebP evidence and legacy PNG compatibility", () => {
  const exportReference = readReference("export.md");

  expect(exportReference).toMatch(
    /serves the stored bytes,.*never starts a renderer or.*reruns validation/is,
  );
  expect(exportReference).toMatch(/\.webp/);
  expect(exportReference).toMatch(/\.png/);
  expect(exportReference).toMatch(/backward compatible/i);
  expect(exportReference).toMatch(/renderFormat/);
  expect(exportReference).toMatch(/detected PNG or WebP format/i);
  expect(exportReference).toMatch(
    /Render sidecars additionally require `renderFormat`;[\s\S]*source sidecars omit `renderFormat`/,
  );
  assertTableRowsHaveNoUnescapedCellPipes(exportReference);
});

test("validation documentation names whole-artifact bounds and animation semantics", () => {
  const validationReference = readReference("validation.md");

  expect(validationReference).toMatch(/4096/);
  expect(validationReference).toMatch(/8,?388,?608|8388608/);
  expect(validationReference).toMatch(/8 MiB/);
  expect(validationReference).toMatch(
    /declares animated-capture eligibility|animated evidence|multi-frame WebP/i,
  );
  expect(validationReference).toMatch(/interactive TSX.*declares.*animated-?capture eligibility/is);
  expect(validationReference).toMatch(/Tier 2.*display|Tier 1.*dark.*structural parity/is);
  assertTableRowsHaveNoUnescapedCellPipes(validationReference);
});

test("CLI documentation covers render format and gallery theme scope", () => {
  const cliReference = readReference("cli.md");

  expect(cliReference).toMatch(/render.*\.webp|\.webp.*render/is);
  expect(cliReference).toMatch(/renderFormat/);
  expect(cliReference).toMatch(/theme/i);
  assertTableRowsHaveNoUnescapedCellPipes(cliReference);
});
