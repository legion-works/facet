import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../..");

function readRepositoryFile(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

function readReference(name: string): string {
  return readRepositoryFile(join("docs/reference", name));
}

function unescapedPipeCount(line: string): number {
  return line.match(/(?<!\\)\|/g)?.length ?? 0;
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

describe("gallery evidence documentation", () => {
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
    expect(validationReference).toMatch(
      /interactive TSX.*declares.*animated-?capture eligibility/is,
    );
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

  test("CLI reference pins publish verdict and promote token sources", () => {
    const cli = readReference("cli.md");

    expect(cli).toMatch(/publish envelope[\s\S]*stored Tier 0 verdict[\s\S]*status.*error/is);
    expect(cli).toMatch(/FACET_PROMOTE_TOKEN[\s\S]*FACET_HOME\/secrets\/promote\.token/is);
  });

  test("CLI reference documents doctor", () => {
    const cli = readReference("cli.md");
    expect(cli).toMatch(/`doctor`/);
    expect(cli).toMatch(/seven read-only probes/i);
    expect(cli).toMatch(/exits 1/i);
  });

  test("MCP reference documents the five adapter tools", () => {
    const mcp = readReference("mcp.md");

    expect(mcp).toMatch(
      /facet_publish[\s\S]*facet_read_back[\s\S]*facet_status[\s\S]*facet_export[\s\S]*facet_open_url/i,
    );
    assertTableRowsHaveNoUnescapedCellPipes(mcp);
  });

  test("storage reference names schema v9 and WebP screenshot metadata", () => {
    const storage = readReference("storage.md");

    expect(storage).toMatch(/current schema is v9/i);
    expect(storage).toMatch(/screenshot\.webp/);
    expect(storage).toMatch(/screenshot_format/);
  });

  test("canonical Facet skill teaches verdict inspection and operator promotion", () => {
    const skill = readRepositoryFile("skills/facet/SKILL.md");

    expect(skill).toMatch(/publish response[\s\S]*verdict[\s\S]*status.*error/i);
    expect(skill).toMatch(/FACET_PROMOTE_TOKEN[\s\S]*FACET_HOME\/secrets\/promote\.token/i);
    expect(skill).toMatch(/operator-only/i);
    expect(skill).toMatch(/do not run `?facet open`?.*agent/is);
  });

  test("README names current publish verdict and WebP evidence behavior", () => {
    const readme = readRepositoryFile("README.md");

    expect(readme).toMatch(/publish envelope[\s\S]*verdict/i);
    expect(readme).toMatch(/WebP[\s\S]*whole artifact/i);
    expect(readme).toMatch(/system[\s\S]*dark[\s\S]*light|system[\s\S]*light[\s\S]*dark/i);
  });
});
