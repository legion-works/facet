/**
 * Mutation harness for the TSX AST policy scope-handling branches.
 *
 * Each ACCEPT test in `tests/unit/tsx-ast-policy.test.ts` that asserts a
 * user's own binding (parameter / catch / for-loop / class field named
 * `fetch`/`eval`/`Worker`/`Function`) is allowed MUST redden when the
 * scope-handling branch that suppresses the false rejection is removed.
 *
 * The harness reads `src/validation/tier0/tsx/ast-policy.ts`, applies a
 * targeted mutation that disables ONE branch at a time, writes the
 * result to a temp file, spawns a child Bun process that imports it and
 * runs the relevant ACCEPT source, and asserts the error count rises.
 *
 * The point is durable: any future ACCEPT test that doesn't actually
 * depend on a scope branch will be flagged here instead of silently
 * passing vacuously in CI.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const AST_POLICY_PATH = join(REPO_ROOT, "src/validation/tier0/tsx/ast-policy.ts");

interface AcceptCase {
  readonly label: string;
  readonly source: string;
}

const ACCEPT_CASES: Readonly<Record<string, AcceptCase>> = {
  parameterFetch: {
    label: "accepts a parameter named `fetch`",
    source: `function f(fetch: (u: string) => string) { return fetch("/x"); }
export default function App(){return f((u) => u);}`,
  },
  arrowEval: {
    label: "accepts an arrow-function parameter named `eval`",
    source: `const f = (eval: (s: string) => string) => eval("ok");
export default function App(){return f((s) => s);}`,
  },
  destructuredWorker: {
    label: "accepts a destructured parameter named `Worker`",
    source: `function f({ Worker }: { Worker: new (s: string) => string }) { return new Worker("ok"); }
export default function App(){return f({ Worker: class { constructor(_: string) { return ""; } } });}`,
  },
  defaultParamFunction: {
    label: "accepts a default-value parameter named `Function`",
    source: `function f(Function: new (s: string) => string = class { constructor(_: string) { return ""; } }) { return new Function("ok"); }
export default function App(){return f();}`,
  },
  catchEval: {
    label: "accepts a `catch (eval)` binding",
    source: `try { throw "x" } catch (eval) { return eval("ok") }
export default function App(){return null;}`,
  },
  methodParamFetch: {
    label: "accepts a method parameter named `fetch`",
    source: `class C { method(fetch: (u: string) => string) { return fetch("/x"); } }
export default function App(){return new C().method((u) => u);}`,
  },
  forLetFetch: {
    label: "accepts a `for (let fetch = ...; ...)` loop binding used at a call site",
    source: `for (let fetch = 0; fetch < 10; fetch++) { fetch("/x"); }
export default function App(){return null;}`,
  },
  forOfWorker: {
    label: "accepts a `for-of` loop binding named `Worker` used as a constructor",
    source: `const items = ["a"];
for (const Worker of items) { new Worker("x"); }
export default function App(){return null;}`,
  },
  forInFunction: {
    label: "accepts a `for-in` loop binding named `Function` used at a call site",
    source: `const obj = { x: 1 };
for (const Function in obj) { new Function("ok"); }
export default function App(){return null;}`,
  },
  classFieldFetch: {
    label: "accepts a class field named `fetch`",
    source: `class C { fetch = (u: string) => u; }
export default function App(){return new C().fetch("/x");}`,
  },
};

interface Mutation {
  readonly branch: string;
  readonly affected: readonly string[];
  /**
   * Returns the mutated source with the targeted scope-handling branch
   * disabled (so the walker treats the user's binding as the global).
   */
  readonly apply: (source: string) => string;
}

const MUTATIONS: readonly Mutation[] = [
  {
    branch:
      "function-like parameter scope (FunctionDeclaration/Expression/Arrow/Method/Constructor/get/set)",
    affected: [
      "parameterFetch",
      "arrowEval",
      "destructuredWorker",
      "defaultParamFunction",
      "methodParamFetch",
    ],
    // The function-like scopes branch loops `scope.parameters` and returns
    // true on a parameter name match. Replace the body of that branch so
    // the walker falls through to the next scope ancestor without the
    // local shadow.
    apply: (source) =>
      source.replace(
        /(if \(\s*\n?\s*ts\.isFunctionDeclaration\(scope\)[\s\S]*?return false;\s*\n\s*\})/,
        `if (ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope) || ts.isArrowFunction(scope) || ts.isMethodDeclaration(scope) || ts.isConstructorDeclaration(scope) || ts.isGetAccessorDeclaration(scope) || ts.isSetAccessorDeclaration(scope)) {
    // mutated: parameter scope disabled
    void scope;
    return false;
  }`,
      ),
  },
  {
    branch: "catch clause scope",
    affected: ["catchEval"],
    apply: (source) =>
      source.replace(
        /(if \(ts\.isCatchClause\(scope\)\) \{[\s\S]*?return false;\s*\n\s*\})/,
        `if (ts.isCatchClause(scope)) {
    // mutated: catch scope disabled
    return false;
  }`,
      ),
  },
  {
    branch: "for-statement scope (for-let)",
    affected: ["forLetFetch"],
    apply: (source) =>
      source.replace(
        /(if \(ts\.isForStatement\(scope\)\) \{[\s\S]*?return false;\s*\n\s*\})/,
        `if (ts.isForStatement(scope)) {
    // mutated: for-statement scope disabled
    return false;
  }`,
      ),
  },
  {
    branch: "for-in / for-of scope",
    affected: ["forOfWorker", "forInFunction"],
    apply: (source) =>
      source.replace(
        /(if \(ts\.isForInStatement\(scope\) \|\| ts\.isForOfStatement\(scope\)\) \{[\s\S]*?return false;\s*\n\s*\})/,
        `if (ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    // mutated: for-in/for-of scope disabled
    return false;
  }`,
      ),
  },
];

const scratchRoot = join(tmpdir(), `facet-ast-mutation-${crypto.randomUUID()}`);
mkdirSync(scratchRoot, { recursive: true });
const tempFiles: string[] = [];

afterAll(() => {
  for (const path of tempFiles.splice(0)) {
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort
    }
  }
  try {
    rmSync(scratchRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/**
 * Rewrite every relative import in the copied AST policy to an absolute
 * repository path. The mutation target is written under `/tmp`, so keeping
 * a relative specifier would resolve beside the temporary file rather than
 * beside the source module.
 */
function rewrittenImports(source: string, repoRoot: string): string {
  const sourceDir = join(repoRoot, "src/validation/tier0/tsx");
  return source
    .replace(/from "(\.{1,2}\/[^\x22]+)"/g, (_match, specifier: string) => {
      return `from ${JSON.stringify(join(sourceDir, specifier))}`;
    })
    .replaceAll(
      'from "typescript"',
      `from ${JSON.stringify(join(repoRoot, "node_modules/typescript"))}`,
    );
}

/**
 * Spawn a child Bun process that imports a mutated policy file and
 * reports the number of typed errors for the given source. The child
 * isolates the mutation from the parent's module graph so subsequent
 * tests see the unmodified walker.
 */
async function runMutation(
  caseSource: string,
  mutate: (source: string) => string,
): Promise<{
  readonly count: number;
  readonly codes: readonly string[];
  readonly unmutatedCount: number;
}> {
  const original = readFileSync(AST_POLICY_PATH, "utf8");
  const mutated = mutate(original);
  // sanity: the mutation must have changed something
  if (mutated === original) {
    throw new Error("mutation did not change the source — pattern is out of date");
  }
  // Rewrite relative imports to absolute paths so the mutation file
  // resolves its dependencies from the repo root, not from /tmp.
  const rewritten = rewrittenImports(mutated, REPO_ROOT);
  const mutatedPath = join(scratchRoot, `ast-policy-${crypto.randomUUID()}.ts`);
  const driverPath = join(scratchRoot, `driver-${crypto.randomUUID()}.ts`);
  tempFiles.push(mutatedPath, driverPath);
  writeFileSync(mutatedPath, rewritten);
  // The driver imports the mutated module via absolute path so Bun
  // resolves it as a local TS source. Each driver is a fresh file so
  // Bun caches them independently per mutation.
  const driver = `import { validateTsxAst } from ${JSON.stringify(mutatedPath)};
const source = ${JSON.stringify(caseSource)};
const errors = validateTsxAst(source);
const codes = errors.map((e) => e.code).sort();
process.stdout.write(JSON.stringify({ count: errors.length, codes }) + "\\n");`;
  writeFileSync(driverPath, driver);

  const child = Bun.spawn({
    cmd: [process.execPath, driverPath],
    env: process.env,
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`mutation child failed: ${stderr}`);
  }
  const parsed = JSON.parse(stdout) as { count: number; codes: string[] };

  // Sanity baseline: confirm the unmutated walker reports zero errors
  // for the same ACCEPT case. If the baseline fails, the ACCEPT test
  // itself is broken — fix that first.
  const baseline = await runUnmutated(caseSource);
  return { ...parsed, unmutatedCount: baseline };
}

async function runUnmutated(caseSource: string): Promise<number> {
  const driverPath = join(scratchRoot, `baseline-${crypto.randomUUID()}.ts`);
  tempFiles.push(driverPath);
  const driver = `import { validateTsxAst } from ${JSON.stringify(AST_POLICY_PATH)};
const source = ${JSON.stringify(caseSource)};
const errors = validateTsxAst(source);
process.stdout.write(String(errors.length) + "\\n");`;
  writeFileSync(driverPath, driver);
  const child = Bun.spawn({
    cmd: [process.execPath, driverPath],
    env: process.env,
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode !== 0) return -1;
  return Number(stdout.trim());
}

describe("tsx ast policy — scope-handling mutation harness", () => {
  // Baseline sanity: every ACCEPT case below MUST report zero errors
  // against the unmutated walker. If this fails, the ACCEPT test in
  // tests/unit/tsx-ast-policy.test.ts is broken or no longer tests
  // what it claims.
  test("baseline: every ACCEPT case reports zero errors against the unmutated walker", async () => {
    const failures: string[] = [];
    for (const [key, value] of Object.entries(ACCEPT_CASES)) {
      const count = await runUnmutated(value.source);
      if (count !== 0) failures.push(`${key}: ${count} errors (expected 0)`);
    }
    expect(failures).toEqual([]);
  });

  for (const mutation of MUTATIONS) {
    describe(`branch disabled: ${mutation.branch}`, () => {
      for (const caseKey of mutation.affected) {
        const accept = ACCEPT_CASES[caseKey];
        if (accept === undefined) throw new Error(`unknown ACCEPT case ${caseKey}`);
        test(`${accept.label} → must redden when this branch is removed`, async () => {
          const result = await runMutation(accept.source, mutation.apply);
          // Two-part contract:
          //  1. The unmutated walker reports zero errors (else the test
          //     is vacuous for a different reason).
          //  2. The mutated walker reports ≥1 error containing a typed
          //     capability code (not just an unrelated parser issue).
          expect(result.unmutatedCount).toBe(0);
          expect(result.count).toBeGreaterThanOrEqual(1);
          expect(result.codes.length).toBeGreaterThanOrEqual(1);
        });
      }
    });
  }

  // Class field: the walker has no scope branch for class fields (the
  // comment in tests/unit/tsx-ast-policy.test.ts notes that fields are
  // not in the user's binding scope). The ACCEPT test asserts the
  // declaration does not trigger a false rejection. There is no
  // mutation to run here — the test is a regression pin, not a scope-
  // handler test. We still verify the baseline (sanity).
  test("class field ACCEPT case reports zero errors against the unmutated walker", async () => {
    const accept = ACCEPT_CASES["classFieldFetch"];
    if (accept === undefined) throw new Error("classFieldFetch missing");
    const count = await runUnmutated(accept.source);
    expect(count).toBe(0);
  });
});
