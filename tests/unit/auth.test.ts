/**
 * Auth + Host/Origin/Sec-Fetch-Site enforcement tests.
 *
 * These exercise the route guard in isolation: every guard returns a
 * typed decision (allow | typed-error) without depending on the router
 * or Bun.serve. The router tests in tests/integration/api.test.ts then
 * assert the same decisions wire through to real HTTP responses.
 */

import { describe, expect, test } from "bun:test";

import {
  checkMutationSecurityHeaders,
  constantTimeEqual,
  parseBearer,
} from "../../src/service/security/auth";
import { checkHost, checkHostOrigin } from "../../src/service/security/host-origin";

describe("constantTimeEqual", () => {
  test("returns true for equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  test("returns false for differing strings of the same length", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  test("returns false for strings of different lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abcd", "abc")).toBe(false);
  });

  test("returns true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("parseBearer", () => {
  test("extracts a Bearer token from a valid Authorization header", () => {
    expect(parseBearer("Bearer abc.def-ghi_123")).toBe("abc.def-ghi_123");
  });

  test("is case-insensitive on the scheme", () => {
    expect(parseBearer("bearer abc")).toBe("abc");
    expect(parseBearer("BEARER abc")).toBe("abc");
  });

  test("returns null on null/missing/empty header", () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("   ")).toBeNull();
  });

  test("returns null on a header that does not start with Bearer", () => {
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("abc")).toBeNull();
  });

  test("returns null on a Bearer header with no token", () => {
    expect(parseBearer("Bearer")).toBeNull();
    expect(parseBearer("Bearer ")).toBeNull();
  });
});

describe("checkHost (DNS-rebinding defense)", () => {
  const expected = "127.0.0.1:54321";

  test("accepts exact match", () => {
    const result = checkHost(expected, expected);
    expect(result.ok).toBe(true);
  });

  test("rejects different host header (case sensitive)", () => {
    const result = checkHost("localhost:54321", expected);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_request");
  });

  test("rejects host header that includes the port mismatch", () => {
    const result = checkHost("127.0.0.1:99999", expected);
    expect(result.ok).toBe(false);
  });

  test("rejects missing host header", () => {
    const result = checkHost(null, expected);
    expect(result.ok).toBe(false);
  });

  test("rejects host with trailing dot or other canonicalization", () => {
    expect(checkHost("127.0.0.1.:54321", expected).ok).toBe(false);
  });
});

describe("checkHostOrigin (combined Host + Origin check)", () => {
  const expected = "127.0.0.1:54321";
  const ownOrigin = "http://127.0.0.1:54321";

  test("GET request with matching host passes", () => {
    const result = checkHostOrigin({
      method: "GET",
      host: expected,
      origin: null,
      secFetchSite: null,
      expectedHost: expected,
      ownOrigin,
    });
    expect(result.ok).toBe(true);
  });

  test("GET request with mismatched host is rejected", () => {
    const result = checkHostOrigin({
      method: "GET",
      host: "evil.example:54321",
      origin: null,
      secFetchSite: null,
      expectedHost: expected,
      ownOrigin,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_request");
  });

  test("POST with matching origin passes", () => {
    const result = checkHostOrigin({
      method: "POST",
      host: expected,
      origin: ownOrigin,
      secFetchSite: "same-origin",
      expectedHost: expected,
      ownOrigin,
    });
    expect(result.ok).toBe(true);
  });

  test("POST with cross-site origin is rejected (403 typed)", () => {
    const result = checkHostOrigin({
      method: "POST",
      host: expected,
      origin: "http://evil.example",
      secFetchSite: "cross-site",
      expectedHost: expected,
      ownOrigin,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_request");
  });

  test("POST with Sec-Fetch-Site=cross-site is rejected", () => {
    const result = checkHostOrigin({
      method: "POST",
      host: expected,
      origin: null,
      secFetchSite: "cross-site",
      expectedHost: expected,
      ownOrigin,
    });
    expect(result.ok).toBe(false);
  });

  test("GET does not require an origin or sec-fetch-site (read-only)", () => {
    const result = checkHostOrigin({
      method: "GET",
      host: expected,
      origin: null,
      secFetchSite: "cross-site",
      expectedHost: expected,
      ownOrigin,
    });
    expect(result.ok).toBe(true);
  });
});

describe("checkMutationSecurityHeaders (Content-Type enforcement)", () => {
  test("POST with application/json passes", () => {
    expect(
      checkMutationSecurityHeaders({
        method: "POST",
        contentType: "application/json",
      }).ok,
    ).toBe(true);
  });

  test("POST with application/json; charset=utf-8 passes", () => {
    expect(
      checkMutationSecurityHeaders({
        method: "POST",
        contentType: "application/json; charset=utf-8",
      }).ok,
    ).toBe(true);
  });

  test("POST with text/plain is rejected (typed)", () => {
    const result = checkMutationSecurityHeaders({
      method: "POST",
      contentType: "text/plain",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_request");
  });

  test("POST without Content-Type is rejected", () => {
    const result = checkMutationSecurityHeaders({
      method: "POST",
      contentType: null,
    });
    expect(result.ok).toBe(false);
  });

  test("GET does not require Content-Type", () => {
    expect(
      checkMutationSecurityHeaders({
        method: "GET",
        contentType: null,
      }).ok,
    ).toBe(true);
  });
});
