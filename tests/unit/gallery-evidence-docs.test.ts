import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROMOTION_GATE } from "../../src/shared/contracts/promotion";
import { RenderStatusSchema } from "../../src/shared/contracts/validation";

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
    expect(cli).toMatch(/watch[\s\S]*NDJSON|NDJSON[\s\S]*watch/i);
    expect(cli).toMatch(/duplicate_revision[\s\S]*continues/i);
  });

  test("CLI promotion refusal description covers every gate-refused status", () => {
    const cli = readReference("cli.md");
    const refusalDescription = cli.match(
      /The gate refuses ([\s\S]*?)\.\s+Other Tier 1 statuses/,
    )?.[1];
    expect(refusalDescription).toBeDefined();

    for (const [status, disposition] of Object.entries(PROMOTION_GATE)) {
      if (disposition !== "refuse") continue;
      expect(refusalDescription, `missing refused status ${status}`).toContain(`\`${status}\``);
    }
  });

  test("CLI reference documents doctor", () => {
    const cli = readReference("cli.md");
    expect(cli).toMatch(/`doctor`/);
    expect(cli).toMatch(/seven read-only probes/i);
    expect(cli).toMatch(/exits 1/i);
  });

  test("MCP reference documents every adapter tool", () => {
    const mcp = readReference("mcp.md");
    const readme = readRepositoryFile("README.md");
    const adapter = readRepositoryFile("src/harness-adapters/mcp/server.ts");
    const toolNames = [...adapter.matchAll(/^\s{4}(facet_[a-z_]+): defineTool\(/gm)].map(
      ([, name]) => name!,
    );
    expect(toolNames).toHaveLength(6);

    for (const name of toolNames) {
      expect(mcp, `missing ${name} in MCP reference`).toContain(name);
      expect(readme, `missing ${name} in README`).toContain(name);
    }

    expect(mcp).toMatch(
      /facet_publish[\s\S]*facet_read_back[\s\S]*facet_status[\s\S]*facet_export[\s\S]*facet_open_url/i,
    );
    // These checks prove that documented command text is present, not that the command executes.
    expect(mcp).toMatch(/bun add -g @legionworks\/facet[\s\S]*facet-mcp/);
    expect(mcp).toMatch(/npx -p @legionworks\/facet facet-mcp/);
    expect(mcp).toMatch(/npm package includes the `facet-mcp` bin/i);
    expect(mcp).toMatch(/facet_open_url[\s\S]*always adds `--no-launch`/i);
    expect(mcp).toMatch(/shell access, the CLI is the integration/i);
    assertTableRowsHaveNoUnescapedCellPipes(mcp);
  });

  test("every render status is documented in validation reference and skill", () => {
    const validation = readReference("validation.md");
    const skill = readRepositoryFile("skills/facet/SKILL.md");

    for (const status of RenderStatusSchema.options) {
      expect(
        validation.split("\n").some((line) => line.startsWith(`| \`${status}\``)),
        `missing ${status} from validation status table`,
      ).toBe(true);
      expect(skill, `missing ${status} in Facet skill`).toContain(`\`${status}\``);
    }
  });

  test("distribution documentation pins the Bun runtime and install forms", () => {
    const readme = readRepositoryFile("README.md");
    const cli = readReference("cli.md");

    expect(readme).toMatch(/## Install[\s\S]*bun add -g @legionworks\/facet/);
    expect(readme).toMatch(/npm i -g @legionworks\/facet/);
    expect(readme).toMatch(/pnpm add -g @legionworks\/facet/);
    expect(readme).toMatch(/bunx @legionworks\/facet <verb>/);
    expect(readme).toMatch(/Bun is the required runtime/i);
    expect(readme).toMatch(/first visual[\s\S]*read-back/i);
    expect(cli).toMatch(/Bun `1\.4\.0` or newer is required at runtime/i);
  });

  test("agent surfaces route shell-capable hosts to the CLI, not MCP", () => {
    const skill = readRepositoryFile("skills/facet/SKILL.md");
    const agents = readRepositoryFile("docs/guides/agents.md");

    expect(skill).toMatch(/shell access, the CLI is the integration/i);
    expect(skill).not.toMatch(/prefer MCP/i);
    expect(agents).toMatch(/shell access, the CLI is the integration/i);
  });

  test("storage reference names schema v10 and WebP screenshot metadata", () => {
    const storage = readReference("storage.md");

    expect(storage).toMatch(/current schema is v10/i);
    expect(storage).toMatch(/v10[\s\S]*promotion_override[\s\S]*null/i);
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
    expect(readme).toMatch(/^\| `partial:empty_render`/m);
    expect(readme).toMatch(/system[\s\S]*dark[\s\S]*light|system[\s\S]*light[\s\S]*dark/i);
  });
});
