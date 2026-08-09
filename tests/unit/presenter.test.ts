import { describe, expect, test } from "bun:test";

import { presentEnvelope, presenterCaps, shouldPresentPretty } from "../../src/cli/presenter";
import { errEnvelope, okEnvelope } from "../../src/shared/contracts/envelope";
import { FacetError } from "../../src/shared/errors/facet-error";
import { validPublishResult, validReadBackResult } from "./_helpers/command-fixtures";

const plain = { color: false } as const;

describe("CLI presenter routing", () => {
  test("pretty output is exclusive to interactive non-JSON terminals", () => {
    expect(shouldPresentPretty({ isTTY: true, jsonFlag: false, env: {} })).toBe(true);
    expect(shouldPresentPretty({ isTTY: false, jsonFlag: false, env: {} })).toBe(false);
    expect(shouldPresentPretty({ isTTY: true, jsonFlag: true, env: {} })).toBe(false);
  });

  test("NO_COLOR disables ANSI while preserving interactive routing", () => {
    expect(presenterCaps({ isTTY: true, jsonFlag: false, env: {} })).toEqual({ color: true });
    expect(presenterCaps({ isTTY: true, jsonFlag: false, env: { NO_COLOR: "1" } })).toEqual({
      color: false,
    });
  });
});

describe("CLI presenter envelopes", () => {
  test("errors preserve the typed code, retryability, and message", () => {
    const envelope = errEnvelope(
      "request-1",
      new FacetError("tier1_unavailable", "service is starting", { retryable: true }).toBody(),
    );
    expect(presentEnvelope(envelope, plain)).toEqual([
      "✗ tier1_unavailable · retryable yes",
      "            service is starting",
    ]);
  });

  test("publish output includes the exact read-back command and tier verdict", () => {
    const publish = {
      ...validPublishResult(),
      tier1Verdict: {
        ...validReadBackResult().verdict,
        status: "partial:layout_unverified" as const,
        screenshotPath: "/tmp/evidence.png",
        observed: {
          ...validReadBackResult().verdict.observed,
          discriminativeErrors: [{ code: "layout", message: "browser viewport unavailable" }],
        },
      },
    };
    const sha = publish.revision.sha256;

    expect(presentEnvelope(okEnvelope("request-1", publish), plain)).toEqual([
      `● published · rev ${sha.slice(0, 8)}`,
      `  read-back facet read-back --revision-sha ${sha}`,
      `◐ partial · layout_unverified · tier 1 · art-1 @ ${"a".repeat(8)}`,
      "  observed  svg 1 · graphs 1 · nodes 2 · errors 0",
      "  detail    layout — browser viewport unavailable",
      "  evidence  /tmp/evidence.png",
    ]);
  });

  test("read-back, status, and fallback commands stay terse", () => {
    expect(presentEnvelope(okEnvelope("request-1", validReadBackResult()), plain)[0]).toBe(
      `✓ ok · tier 1 · art-1 @ ${"a".repeat(8)}`,
    );
    expect(
      presentEnvelope(okEnvelope("request-1", { command: "status", state: "dormant" }), plain),
    ).toEqual(["◌ dormant · zero processes · zero ports — healthy"]);
    expect(
      presentEnvelope(
        okEnvelope("request-1", { command: "status", state: "active", activeJobs: 3 }),
        plain,
      ),
    ).toEqual(["● active · jobs 3"]);
    expect(presentEnvelope(okEnvelope("request-1", { command: "list" }), plain)).toEqual([
      "✓ ok · list",
    ]);
    expect(presentEnvelope(okEnvelope("request-1", {}), plain)).toEqual(["✓ ok"]);
  });

  test("color capability wraps semantic fragments in ANSI-16 codes", () => {
    const [line] = presentEnvelope(
      okEnvelope("request-1", { command: "status", state: "active" }),
      {
        color: true,
      },
    );
    expect(line).toContain("\u001b[32m● active\u001b[0m");
  });
});
