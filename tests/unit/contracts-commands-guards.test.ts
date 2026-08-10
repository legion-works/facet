import { describe, expect, test } from "bun:test";

import {
  CommandNameSchema,
  IMPLEMENTED_COMMANDS,
  RESERVED_COMMANDS,
  checkArtifactTypeSupported,
  checkCommandImplemented,
  type CommandName,
} from "../../src/shared/contracts/commands";
import { REQUEST_ID } from "./_helpers/command-fixtures";

describe("CommandName coverage", () => {
  test("exposes the ten implemented command verbs", () => {
    const implemented: CommandName[] = [
      "create",
      "publish",
      "list",
      "readBack",
      "status",
      "open",
      "promote",
      "instantiate",
      "pin",
      "export",
    ];
    expect(new Set(IMPLEMENTED_COMMANDS)).toEqual(new Set(implemented));
  });

  test("does not reserve the implemented export verb", () => {
    expect(RESERVED_COMMANDS).not.toContain("export");
  });

  test("CommandNameSchema accepts both implemented and reserved names", () => {
    for (const name of [...IMPLEMENTED_COMMANDS, ...RESERVED_COMMANDS]) {
      expect(CommandNameSchema.safeParse(name).success).toBe(true);
    }
  });

  test("CommandNameSchema rejects unknown names", () => {
    expect(CommandNameSchema.safeParse("delete").success).toBe(false);
    expect(CommandNameSchema.safeParse("").success).toBe(false);
  });
});

describe("implemented 'export' command verb", () => {
  test("parses as a valid request and checkCommandImplemented returns null", () => {
    const exportReq = { command: "export" as const, requestId: REQUEST_ID, artifactId: "art-1" };
    expect(CommandNameSchema.safeParse(exportReq.command).success).toBe(true);
    const error = checkCommandImplemented(exportReq.command);
    expect(error).toBeNull();
  });

  test("checkCommandImplemented returns null for every implemented verb", () => {
    for (const name of IMPLEMENTED_COMMANDS) {
      expect(checkCommandImplemented(name)).toBeNull();
    }
  });
});

describe("implemented 'html' artifact type", () => {
  test("checkArtifactTypeSupported accepts html and every implemented type", () => {
    for (const type of ["markdown", "mermaid", "svg", "chart", "html"]) {
      expect(checkArtifactTypeSupported(type)).toBeNull();
    }
  });
});
