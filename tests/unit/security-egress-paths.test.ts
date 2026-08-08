import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { isSecurityEgressPath, main } from "../../scripts/check-security-egress-paths";

describe("security-egress path decision", () => {
  test("matches security paths and rejects unrelated paths", () => {
    expect(isSecurityEgressPath("scripts/launch-netns.sh")).toBe(true);
    expect(isSecurityEgressPath("scripts/egress-penetration.ts")).toBe(true);
    expect(isSecurityEgressPath("src/service/security/auth.ts")).toBe(true);
    expect(isSecurityEgressPath("src/gallery-web/app.ts")).toBe(true);
    expect(isSecurityEgressPath("src/validation/tier0/markdown.ts")).toBe(true);
    expect(isSecurityEgressPath("README.md")).toBe(false);
    expect(isSecurityEgressPath("docs/x.md")).toBe(false);
  });

  test("keeps the workflow's actual grep regex aligned with the tested prefixes", () => {
    const workflow = readFileSync(".github/workflows/security-egress.yml", "utf8");
    expect(workflow).toContain("src/(gallery-web/.+|validation/.+|service/security/.+)");
  });

  test("prints deterministic decisions for CLI callers", () => {
    const output: string[] = [];
    const original = console.log;
    console.log = (line: string) => output.push(line);
    try {
      main(["src/service/security/auth.ts", "README.md"]);
    } finally {
      console.log = original;
    }
    expect(output).toEqual(["match\tsrc/service/security/auth.ts", "no-match\tREADME.md"]);
  });
});
