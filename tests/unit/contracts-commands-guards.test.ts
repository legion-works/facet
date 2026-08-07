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
  test("exposes the nine implemented command verbs", () => {
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
    ];
    expect(new Set(IMPLEMENTED_COMMANDS)).toEqual(new Set(implemented));
  });

  test("names 'export' as a reserved verb", () => {
    expect(RESERVED_COMMANDS).toContain("export");
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

describe("reserved 'export' command verb", () => {
  test("parses as a valid request but checkCommandImplemented returns reserved_not_implemented", () => {
    const exportReq = { command: "export" as const, requestId: REQUEST_ID, format: "pdf" };
    expect(CommandNameSchema.safeParse(exportReq.command).success).toBe(true);
    const error = checkCommandImplemented(exportReq.command);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("reserved_not_implemented");
    expect(error?.retryable).toBe(false);
    expect(error?.toBody()).toEqual({
      code: "reserved_not_implemented",
      message: error!.message,
      retryable: false,
      details: { command: "export" },
    });
  });

  test("checkCommandImplemented returns null for every implemented verb", () => {
    for (const name of IMPLEMENTED_COMMANDS) {
      expect(checkCommandImplemented(name)).toBeNull();
    }
  });
});

describe("reserved 'html' artifact type", () => {
  test("checkArtifactTypeSupported('html') returns unsupported_reserved_type", () => {
    const error = checkArtifactTypeSupported("html");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("unsupported_reserved_type");
    expect(error?.retryable).toBe(false);
  });

  test("checkArtifactTypeSupported accepts every implemented type", () => {
    expect(checkArtifactTypeSupported("markdown")).toBeNull();
    expect(checkArtifactTypeSupported("mermaid")).toBeNull();
    expect(checkArtifactTypeSupported("svg")).toBeNull();
    expect(checkArtifactTypeSupported("chart")).toBeNull();
  });
});
