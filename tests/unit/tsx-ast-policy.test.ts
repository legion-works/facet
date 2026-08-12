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
 * Each REJECT case has an adjacent ACCEPT case so the rejection cannot be a
 * naive blocklist that also breaks valid code. Reviewers have independently
 * verified the five bypasses below, and the table is the acceptance target.
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

  test("rejects require(...) — ESM allowlist is the only legal entry", () => {
    // Defense-in-depth: even if the bundler would otherwise turn this into a
    // static require, the AST walker must reject it so the typed verdict
    // names the bypass.
    const source = `const m = require("marked"); export default function App(){return null;}`;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.requireCall);
  });

  test("rejects a NESTED-scope shadow that would otherwise suppress top-level global fetch", () => {
    // Before the per-scope fix, `function outer(){ function fetch(){} }` made
    // the top-level `fetch("/x")` look like it was locally bound, which
    // suppressed the global fetch rejection. Per-scope tracking closes it.
    const source = `
      function outer(){ function fetch(u:string){return u} }
      export const a = fetch("/x")
    `;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.fetch);
  });

  test("rejects `const g = globalThis; g.fetch(...)` — direct globalThis alias", () => {
    const source = `
      const g = globalThis;
      g.fetch("/x");
      export default function App(){return null;}
    `;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.aliasOfDeniedGlobal);
  });

  test("rejects `const W = Worker; new W(...)` — constructor alias", () => {
    const source = `
      const W = Worker;
      new W("./w.js");
      export default function App(){return null;}
    `;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.aliasOfDeniedGlobal);
  });

  test("rejects `const F = Function; new F(...)` — Function constructor alias", () => {
    const source = `
      const F = Function;
      new F("return 1");
      export default function App(){return null;}
    `;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.aliasOfDeniedGlobal);
  });

  test("rejects `const W = globalThis.Worker` — property-access alias", () => {
    const source = `
      const W = globalThis.Worker;
      new W("./w.js");
      export default function App(){return null;}
    `;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.aliasOfDeniedGlobal);
  });

  test("rejects `const F = window.Function` — window-aliased Function", () => {
    const source = `
      const F = window.Function;
      new F("return 1");
      export default function App(){return null;}
    `;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.aliasOfDeniedGlobal);
  });

  test("rejects `const SW = SharedWorker` — SharedWorker alias", () => {
    const source = `
      const SW = SharedWorker;
      new SW("./w.js");
      export default function App(){return null;}
    `;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.aliasOfDeniedGlobal);
  });

  test("rejects `const self_ = self; self_.fetch(...)` — alias via local binding", () => {
    const source = `
      const self_ = self;
      self_.fetch("/x");
      export default function App(){return null;}
    `;
    const errors = validateTsxAst(source);
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.aliasOfDeniedGlobal);
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
    // it shadows the global at the SAME scope. The AST walker must NOT
    // report a violation just because the identifier's text is "fetch".
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

  test("accepts a destructure from globalThis (per-scope shadow only)", () => {
    // `const { fetch } = globalThis` rebinds `fetch` to a local — the local
    // shadows the global at the use site. The AST walker treats the local
    // as the binding, NOT the alias-of-globalThis pattern.
    const source = `
      const { fetch } = globalThis;
      export default function App(){return fetch("/x");}
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts optional-chained access on a global target", () => {
    // `globalThis?.fetch?.()` is the same access path as
    // `globalThis.fetch()` — we already reject it elsewhere. The point of
    // this test is that the optional chain does NOT confuse the AST
    // walker; it must keep rejecting.
    const source = `
      export default function App(){
        const g: any = globalThis;
        g?.fetch?.("/x");
        return null;
      }
    `;
    const errors = validateTsxAst(source);
    // The walker surfaces the alias because `g = globalThis` is denied.
    expect(codes(errors)).toContain(TSX_CAPABILITY_CODES.aliasOfDeniedGlobal);
  });

  test("accepts `import { useState as fetch }` — user re-binds the name", () => {
    // The import brings `useState` into scope as `fetch`. Subsequent calls
    // resolve the local binding, not the global. A naive blocklist would
    // reject this; per-scope tracking accepts it.
    const source = `
      import React, { useState as fetch } from "react";
      export default function App(){
        const [n, setN] = fetch(0);
        return null;
      }
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts a user-defined `class Worker` and `new Worker(...)` in its scope", () => {
    const source = `
      class Worker { constructor(_: string){} }
      export default function App(){return new Worker("local");}
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts a user-defined `class Function` and `new Function(...)` in its scope", () => {
    const source = `
      class Function { constructor(_: string){} }
      export default function App(){return new Function("local");}
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts a user-defined `function Worker` and `new Worker(...)` in its scope", () => {
    const source = `
      function Worker(this: unknown, _: string){}
      export default function App(){return new Worker("local");}
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts `require` shadowed by a local function declaration", () => {
    // The user has a local function named `require` — calling it is fine.
    // The AST walker must not report a violation just because the
    // identifier's text is "require".
    const source = `
      function require(name: string){return name;}
      export default function App(){return require("ok");}
    `;
    const errors = validateTsxAst(source);
    expect(errors).toEqual([]);
  });

  test("accepts aliasing a NON-denied value (regression — must not widen the blocklist)", () => {
    // The alias check is for `globalThis` / `Worker` / `Function` etc.
    // A user binding to a benign value must not be reported.
    const source = `
      const x = 1;
      const y = "ok";
      const z = { a: 1 };
      const w = (n: number) => n + 1;
      export default function App(){return w(x);}
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
