import { describe, expect, test } from "bun:test";

import {
  CommandRequestSchema,
  CommandResultSchema,
  ExportRequestSchema,
  ExportResultSchema,
  CreateRequestSchema,
  CreateResultSchema,
  InstantiateRequestSchema,
  InstantiateResultSchema,
  ListRequestSchema,
  ListResultSchema,
  OpenRequestSchema,
  OpenResultSchema,
  PinRequestSchema,
  PinResultSchema,
  PromoteRequestSchema,
  PromoteResultSchema,
  PublishRequestSchema,
  PublishResultSchema,
  ReadBackRequestSchema,
  ReadBackResultSchema,
  StatusRequestSchema,
  StatusResultSchema,
  type CommandRequest,
  type CommandResult,
} from "../../src/shared/contracts/commands";

import {
  validCreateRequest,
  validCreateResult,
  validExportRequest,
  validExportResult,
  validInstantiateRequest,
  validInstantiateResult,
  validListRequest,
  validListResult,
  validOpenRequest,
  validOpenResult,
  validPinRequest,
  validPinResult,
  validPromoteRequest,
  validPromoteResult,
  validPublishRequest,
  validPublishResult,
  validReadBackRequest,
  validReadBackResult,
  validStatusRequest,
  validStatusResult,
} from "./_helpers/command-fixtures";

describe("command round-trips", () => {
  test("create request and result round-trip", () => {
    expect(CreateRequestSchema.parse(validCreateRequest())).toEqual(validCreateRequest());
    expect(CreateResultSchema.parse(validCreateResult())).toEqual(validCreateResult());
  });

  test("publish request and result round-trip", () => {
    expect(PublishRequestSchema.parse(validPublishRequest())).toEqual(validPublishRequest());
    expect(PublishResultSchema.parse(validPublishResult())).toEqual(validPublishResult());
  });

  test("publish request defaults renderer to svg and accepts canvas", () => {
    const request = validPublishRequest();
    const { renderer: _renderer, ...withoutRenderer } = request;
    expect(PublishRequestSchema.parse(withoutRenderer).renderer).toBe("svg");
    expect(PublishRequestSchema.safeParse({ ...request, renderer: "canvas" }).success).toBe(true);
    expect(PublishRequestSchema.safeParse({ ...request, renderer: "webgl" }).success).toBe(false);
  });

  test("list request and result round-trip", () => {
    expect(ListRequestSchema.parse(validListRequest())).toEqual(validListRequest());
    expect(ListResultSchema.parse(validListResult())).toEqual(validListResult());
  });

  test("readBack request accepts tier 0, tier 1, and 'visual' (which normalizes to tier 1)", () => {
    expect(ReadBackRequestSchema.safeParse({ ...validReadBackRequest(), tier: 0 }).success).toBe(
      true,
    );
    expect(ReadBackRequestSchema.safeParse({ ...validReadBackRequest(), tier: 1 }).success).toBe(
      true,
    );
    expect(
      ReadBackRequestSchema.safeParse({ ...validReadBackRequest(), tier: "visual" }).success,
    ).toBe(true);
    expect(ReadBackRequestSchema.safeParse({ ...validReadBackRequest(), tier: 7 }).success).toBe(
      false,
    );
  });

  test("readBack request and result round-trip", () => {
    expect(ReadBackRequestSchema.parse(validReadBackRequest())).toEqual(validReadBackRequest());
    expect(ReadBackResultSchema.parse(validReadBackResult())).toEqual(validReadBackResult());
  });

  test("status request and result round-trip", () => {
    expect(StatusRequestSchema.parse(validStatusRequest())).toEqual(validStatusRequest());
    expect(StatusResultSchema.parse(validStatusResult())).toEqual(validStatusResult());
  });

  test("open request and result round-trip", () => {
    expect(OpenRequestSchema.parse(validOpenRequest())).toEqual(validOpenRequest());
    expect(OpenResultSchema.parse(validOpenResult())).toEqual(validOpenResult());
  });

  test("promote request and result round-trip", () => {
    expect(PromoteRequestSchema.parse(validPromoteRequest())).toEqual(validPromoteRequest());
    expect(PromoteResultSchema.parse(validPromoteResult())).toEqual(validPromoteResult());
  });

  test("instantiate request and result round-trip", () => {
    expect(InstantiateRequestSchema.parse(validInstantiateRequest())).toEqual(
      validInstantiateRequest(),
    );
    expect(InstantiateResultSchema.parse(validInstantiateResult())).toEqual(
      validInstantiateResult(),
    );
  });

  test("pin request and result round-trip", () => {
    expect(PinRequestSchema.parse(validPinRequest())).toEqual(validPinRequest());
    expect(PinResultSchema.parse(validPinResult())).toEqual(validPinResult());
  });

  test("export request and result round-trip", () => {
    expect(ExportRequestSchema.parse(validExportRequest())).toEqual(validExportRequest());
    expect(ExportResultSchema.parse(validExportResult())).toEqual(validExportResult());
  });

  test("export request defaults format to source and accepts an optional revisionSha", () => {
    const { format: _format, ...withoutFormat } = validExportRequest();
    expect(ExportRequestSchema.parse(withoutFormat).format).toBe("source");
    expect(
      ExportRequestSchema.safeParse({ ...withoutFormat, revisionSha: "a".repeat(64) }).success,
    ).toBe(true);
    expect(ExportRequestSchema.safeParse({ ...withoutFormat, format: "pdf" }).success).toBe(false);
  });

  test("export result rejects the old accepted-false envelope", () => {
    expect(
      ExportResultSchema.safeParse({
        command: "export",
        requestId: "req-0001",
        accepted: false,
        reason: "legacy export refusal",
      }).success,
    ).toBe(false);
  });

  test("export result rejects malformed base64 bytes", () => {
    const sample = validExportResult();
    for (const bytes of ["AAA", "AA$=", "A===", "AA=A"]) {
      expect(ExportResultSchema.safeParse({ ...sample, bytes }).success).toBe(false);
    }
  });

  test("discriminated union of all requests round-trips for implemented verbs", () => {
    const samples: CommandRequest[] = [
      validCreateRequest(),
      validPublishRequest(),
      validListRequest(),
      validReadBackRequest(),
      validStatusRequest(),
      validOpenRequest(),
      validPromoteRequest(),
      validInstantiateRequest(),
      validPinRequest(),
      validExportRequest(),
    ];
    for (const sample of samples) {
      expect(CommandRequestSchema.parse(sample)).toEqual(sample);
    }
  });

  test("discriminated union of all results round-trips for implemented verbs", () => {
    const samples: CommandResult[] = [
      validCreateResult(),
      validPublishResult(),
      validListResult(),
      validReadBackResult(),
      validStatusResult(),
      validOpenResult(),
      validPromoteResult(),
      validInstantiateResult(),
      validPinResult(),
      validExportResult(),
    ];
    for (const sample of samples) {
      expect(CommandResultSchema.parse(sample)).toEqual(sample);
    }
  });
});
