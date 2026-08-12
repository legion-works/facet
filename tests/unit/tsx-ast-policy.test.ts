/**
 * Adversarial coverage for the TSX AST policy.
 *
 * The capability rejections and import rejections MUST be decided from the
 * TypeScript AST (D13). String scans cannot tell `fetch` in a comment from
 * a real global call — and this project has shipped three review rounds on
 * one task because string-scan guards that look right on paper still score
 * false-positive or false-negative on adversarial inputs.
 *
 * For every guard we:
 *   1. RED  — assert a deliberately-bad input is REJECTED (or, for the
 *             accept direction, that the bad input would have been wrongly
 *             REJECTED by a naive string scan).
 *   2. GREEN — assert a deliberately-good input is ACCEPTED.
 *
 * Every case below names the production change that would make it fail.
 */

import { describe, expect, test } from "bun:test";

import { TSX_CAPABILITY_CODES, validateTsxAst } from "../../src/validation/tier0/tsx/ast-policy";
import { TSX_ALLOWED_MODULES, classifyTsxImport } from "../../src/shared/tsx/import-policy";

function codes(errors: readonly { readonly code: string }[]): string[] {
  return errors.map((e) => e.code).toSorted();
}

describe("tsx ast policy — capability REJECT directions (RED)", () => {
  // Each REJECT case names the production change that would make it pass:
  // removing the visitor entirely would do it. The negative inputs are
  // constructed to be adversarial but realistic.

  test("rejects a real global fetch(...) call", () => {
    const source = `export default function App(){fetch("/x");return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.fetch);
  });

  test("rejects globalThis.fetch(...) call", () => {
    const source = `export default function App(){globalThis.fetch("/x");return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.fetch);
  });

  test("rejects window.fetch(...) call", () => {
    const source = `export default function App(){window.fetch("/x");return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.fetch);
  });

  test("rejects self.fetch(...) call", () => {
    const source = `export default function App(){self.fetch("/x");return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.fetch);
  });

  test("rejects a bare globalThis.fetch reference (not called)", () => {
    const source = `export default function App(){const f = globalThis.fetch;return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.fetch);
  });

  test("rejects a computed access that resolves to fetch", () => {
    const source = `export default function App(){globalThis["fe" + "tch"]("/x");return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.fetch);
  });

  test("rejects a computed access whose fragments are unresolved (suspicious pattern)", () => {
    // Cannot statically resolve (identifier, not a literal), so the policy
    // surfaces `unsupportedComputedGlobal` instead of silently passing.
    const source = `export default function App(){const k = unknownKey; globalThis[k]("/x");return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.unsupportedComputedGlobal);
  });

  test("rejects eval(...) direct call", () => {
    const source = `export default function App(){eval("alert(1)");return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.evalCall);
  });

  test("rejects indirect eval (0, eval)(...)", () => {
    const source = `export default function App(){(0, eval)("alert(1)");return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.evalCall);
  });

  test("rejects new Function(...)", () => {
    const source = `export default function App(){return new Function("alert(1)");}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.functionConstructor);
  });

  test("rejects dynamic import()", () => {
    const source = `export default async function App(){await import("left-pad");return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.dynamicImport);
  });

  test("rejects new Worker(...)", () => {
    const source = `export default function App(){return new Worker("./w.js");}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.worker);
  });

  test("rejects new SharedWorker(...)", () => {
    const source = `export default function App(){return new SharedWorker("./w.js");}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.sharedWorker);
  });
});

describe("tsx ast policy — capability ACCEPT directions (GREEN)", () => {
  // Each ACCEPT case has an adjacent REJECT case. Removing the visitor or
  // turning it into `source.includes(...)` would flip these from PASS to
  // FAIL — that is the only way the negative direction can be trusted.

  test("accepts fetch in a comment", () => {
    const source = `
      // I would never call fetch("/x") in a comment.
      export default function App(){return null;}
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts fetch in a block comment", () => {
    const source = `
      /* fetch("/x") and eval("x") should not trigger here */
      export default function App(){return null;}
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts fetch in a string literal", () => {
    const source = `
      export default function App(){
        const message = 'we do not call fetch("/x") here';
        return null;
      }
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts a local identifier named fetch", () => {
    // The user defined `fetch` as a local function — calling it is fine,
    // it shadows the global. The AST walker must NOT report a violation
    // just because the identifier's text is "fetch".
    const source = `
      function fetch(url: string){return url;}
      export default function App(){return fetch("/x");}
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts eval in a string literal", () => {
    const source = `
      export default function App(){
        const message = "eval is not called here";
        return null;
      }
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts import() in a string literal", () => {
    const source = `
      export default function App(){
        const message = "import() is not invoked here";
        return null;
      }
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts new Worker in a comment", () => {
    const source = `
      // new Worker("./w.js") is a thought experiment, not a call.
      export default function App(){return null;}
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts a benign computed access on a non-global target", () => {
    // `[1,2,3][0]` is fine. The computed-access guard must only complain
    // about global-shaped targets.
    const source = `
      export default function App(){const first = [1,2,3][0]; return null;}
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts a benign property access on a local object", () => {
    const source = `
      export default function App(){
        const obj = { fetch: 1 };
        return obj.fetch;
      }
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts a static React component that compiles cleanly", () => {
    const source = `
      import React from "react";
      export default function Status({label}: {readonly label: string}) {
        return <p className="text-sm">{label}</p>;
      }
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });
});

describe("tsx ast policy — import policy REJECT directions (RED)", () => {
  test("rejects a non-allowlisted package import", () => {
    const source = `import x from "left-pad"; export default function App(){return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain("tsx_import_denied");
    expect(errors[0]?.message).toContain("left-pad");
  });

  test("rejects a relative import (./local)", () => {
    const source = `import x from "./local"; export default function App(){return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain("tsx_import_denied");
  });

  test("rejects an absolute import (/abs/path)", () => {
    const source = `import x from "/abs/path"; export default function App(){return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain("tsx_import_denied");
  });

  test("rejects a URL import (data:…)", () => {
    const source = `import x from "data:text/javascript,alert(1)"; export default function App(){return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain("tsx_import_denied");
  });

  test("rejects a URL import (https://…)", () => {
    const source = `import x from "https://evil/x.js"; export default function App(){return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain("tsx_import_denied");
  });

  test("rejects a re-export from a non-allowlisted package", () => {
    const source = `export * from "left-pad";`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain("tsx_import_denied");
  });
});

describe("tsx ast policy — import policy ACCEPT directions (GREEN)", () => {
  test("accepts every entry in the allowlist", () => {
    expect(TSX_ALLOWED_MODULES.has("react")).toBe(true);
    expect(TSX_ALLOWED_MODULES.has("react-dom")).toBe(true);
    expect(TSX_ALLOWED_MODULES.has("react-dom/client")).toBe(true);
    expect(TSX_ALLOWED_MODULES.has("react/jsx-runtime")).toBe(true);
    expect(TSX_ALLOWED_MODULES.has("react/jsx-dev-runtime")).toBe(true);
    // And the classifier agrees.
    expect(classifyTsxImport("react")).toBeNull();
    expect(classifyTsxImport("react-dom")).toBeNull();
    expect(classifyTsxImport("react-dom/client")).toBeNull();
    expect(classifyTsxImport("react/jsx-runtime")).toBeNull();
    expect(classifyTsxImport("react/jsx-dev-runtime")).toBeNull();
  });

  test("accepts a typed import path that matches an allowlist entry", () => {
    const source = `
      import React from "react";
      import { createRoot } from "react-dom/client";
      export default function App(){return null;}
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts a non-import 'left-pad' identifier (no false positive)", () => {
    // A naive string scan would reject this because the identifier name
    // happens to contain the deny pattern; the AST walker must not.
    const source = `
      const left_pad = (s: string) => s;
      export default function App(){return left_pad("ok");}
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });
});

describe("tsx ast policy — adversarial mutations", () => {
  // Each mutation removes a guard and the test must REJECT the change.
  // These are vacuity failures, asserted against the production policy.

  test("does not regress when one error slips through (returns typed code)", () => {
    // A real fetch call must produce a typed code that consumers can
    // switch on — NOT an empty array (vacuous pass).
    const source = `export default function App(){fetch("/x");return null;}`;
    const errors = validateTsxAst(source);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => typeof e.code === "string" && e.code.length > 0)).toBe(true);
  });

  test("reports source location for a real fetch call", () => {
    const source = `export default function App(){fetch("/x");return null;}`;
    const errors = validateTsxAst(source);
    const fetchError = errors.find((e) => e.code === TSX_CAPABILITY_CODES.fetch);
    expect(fetchError).toBeDefined();
    expect(fetchError?.location).toMatch(/^\d+:\d+$/);
  });
});
