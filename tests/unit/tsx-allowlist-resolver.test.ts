/**
 * Compile-time allowlist enforcement.
 *
 * The AST policy (D13) catches structural rejection of `import` statements,
 * `require(...)`, and capability uses. The resolver plugin
 * (`src/validation/tier0/tsx/allowlist-resolver.ts`) is the second line of
 * defense: it makes the bundler structurally unable to resolve a
 * non-allowlisted module. A bypass of the AST layer (e.g. `require`,
 * computed paths) still cannot pull a forbidden package into the bundle.
 *
 * Fixtures live INSIDE the project tree (under
 * `tests/fixtures/tsx/_resolver-probes/`) so Bun can resolve node_modules
 * — otherwise the test never reaches the plugin's resolution gate. The
 * probe files are cleaned up by the afterEach hook; nothing in the working
 * tree persists after the suite.
 *
 * IMPORTANT: every probe file ACTUALLY USES the imported value. Bun's
 * bundler treats unused imports as side-effect-free and silently strips
 * them — the resolver plugin is never invoked. This is the same
 * empty-default-fixture vacuity class the previous round shipped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tsxAllowlistResolverPlugin } from "../../src/validation/tier0/tsx/allowlist-resolver";

const PROBE_ROOT = join(import.meta.dir, "..", "fixtures", "tsx", "_resolver-probes");

// The parent must exist before mkdtempSync can create children under it.
// `.gitignore` covers the directory; the afterEach hook wipes every run-*
// child, so the working tree ends clean.
if (!existsSync(PROBE_ROOT)) {
  mkdirSync(PROBE_ROOT, { recursive: true });
}

const tempRoots: string[] = [];

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(PROBE_ROOT, "run-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface BuildResult {
  readonly success: boolean;
  readonly messages: readonly string[];
}

async function tryBuild(entryPath: string): Promise<BuildResult> {
  const result = await Bun.build({
    entrypoints: [entryPath],
    target: "browser",
    format: "esm",
    minify: false,
    splitting: false,
    sourcemap: "none",
    external: [],
    throw: false,
    plugins: [tsxAllowlistResolverPlugin()],
  });
  return {
    success: result.success,
    messages: result.logs.map((log) => log.message),
  };
}

describe("tsx allowlist resolver — REJECT (RED)", () => {
  test("entrypoint INSIDE the project tree importing marked fails at the resolver layer", async () => {
    // The decisive probe. /tmp/x.tsx importing marked looks like
    // enforcement ("Could not resolve: marked") because node_modules is
    // not reachable from outside the tree. INSIDE the tree, Bun WOULD
    // bundle marked — so the resolver plugin is what actually closes it.
    const dir = makeFixtureDir();
    const entry = join(dir, "_probe.tsx");
    writeFileSync(
      entry,
      `import * as marked from "marked"; console.log(marked.parse("a")); export default function App(){return null;}`,
    );
    const result = await tryBuild(entry);
    expect(result.success).toBe(false);
    expect(
      result.messages.some((m) => m.includes("TSX allowlist violation") && m.includes("marked")),
    ).toBe(true);
  });

  test("entrypoint using require(marked) still fails at the AST layer (defense in depth)", async () => {
    // `require(...)` is ESM-side-channel — the AST walker rejects it
    // outright. Even if the resolver plugin were bypassed (e.g. by a
    // hypothetical CommonJS shim), the AST walker fires first.
    const { validateTsxAst } = await import("../../src/validation/tier0/tsx/ast-policy");
    const errors = validateTsxAst(
      `const m = require("marked"); export default function App(){return null;}`,
    );
    expect(errors.some((e) => e.code === "tsx_capability_require")).toBe(true);
  });

  test("entrypoint importing left-pad fails at the resolver layer", async () => {
    const dir = makeFixtureDir();
    const entry = join(dir, "_probe.tsx");
    writeFileSync(
      entry,
      `import leftpad from "left-pad"; console.log(leftpad("a", 1, "b")); export default function App(){return null;}`,
    );
    const result = await tryBuild(entry);
    expect(result.success).toBe(false);
    expect(
      result.messages.some((m) => m.includes("TSX allowlist violation") && m.includes("left-pad")),
    ).toBe(true);
  });

  test("entrypoint importing a forbidden React subpath fails at the resolver layer", async () => {
    // The allowlist is the five exact entries. Anything else under the
    // `react*` namespace is rejected at the resolver; the AST walker also
    // rejects it on the import-statement shape.
    const dir = makeFixtureDir();
    const entry = join(dir, "_probe.tsx");
    writeFileSync(
      entry,
      `import * as rdt from "react-dom/test-utils"; console.log(rdt); export default function App(){return null;}`,
    );
    const result = await tryBuild(entry);
    expect(result.success).toBe(false);
    expect(result.messages.some((m) => m.includes("react-dom/test-utils"))).toBe(true);
  });
});

describe("tsx allowlist resolver — ACCEPT (GREEN)", () => {
  test("entrypoint importing react resolves and bundles", async () => {
    const dir = makeFixtureDir();
    const entry = join(dir, "_probe.tsx");
    writeFileSync(
      entry,
      `import React from "react"; console.log(React.createElement("p")); export default function App(){return null;}`,
    );
    const result = await tryBuild(entry);
    expect(result.success).toBe(true);
    expect(result.messages).toEqual([]);
  });

  test("entrypoint importing react-dom/client resolves and bundles", async () => {
    const dir = makeFixtureDir();
    const entry = join(dir, "_probe.tsx");
    writeFileSync(
      entry,
      `import { createRoot } from "react-dom/client"; console.log(createRoot); export default function App(){return null;}`,
    );
    const result = await tryBuild(entry);
    expect(result.success).toBe(true);
    expect(result.messages).toEqual([]);
  });

  test("entrypoint importing react/jsx-runtime resolves and bundles", async () => {
    const dir = makeFixtureDir();
    const entry = join(dir, "_probe.tsx");
    writeFileSync(
      entry,
      `import { jsx } from "react/jsx-runtime"; console.log(jsx); export default function App(){return null;}`,
    );
    const result = await tryBuild(entry);
    expect(result.success).toBe(true);
    expect(result.messages).toEqual([]);
  });
});

describe("tsx allowlist resolver — determinism invariant pin", () => {
  // MUST 2: characterize the exact conditions under which bytes are stable.
  // The invariant we can claim and pin for Task 5 is:
  //
  //   Same source + same absolute entrypoint path + same cwd + same env
  //   ⇒ same bundle bytes (within a single process lifetime).
  //
  // Task 5's compiler entry must satisfy all four conditions for the
  // pooled Tier 0 worker, or revision-bound derived bytes will drift.

  test("byte hashes are stable for the same (source, absolute entrypoint, cwd, env)", async () => {
    const dir = makeFixtureDir();
    const entry = join(dir, "_probe.tsx");
    writeFileSync(
      entry,
      `import React from "react"; console.log(React.createElement("p")); export default function App(){return null;}`,
    );
    const first = await tryBuildBytes(entry);
    expect(first.success).toBe(true);
    const second = await tryBuildBytes(entry);
    expect(second.success).toBe(true);
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes.length).toBe(first.bytes.length);
  });

  test("different cwd changes the bytes even for an absolute entrypoint — the requirement Task 5 inherits", async () => {
    // Bun.build embeds cwd-derived metadata in the bundle, so even an
    // absolute entrypoint produces different bytes when cwd differs. The
    // invariant Task 5 inherits is therefore: bytes are stable IFF
    // (source, absolute entrypoint, cwd, env) all match. Task 5 MUST
    // pin cwd before calling Bun.build — the pooled Tier 0 worker
    // already pins cwd via spawn, so the compiler must read it from
    // process.cwd() (which is already canonical) and not rely on the
    // parent's cwd being stable across runs.
    //
    // This test pins the requirement: the parent must NOT change cwd
    // between compiles, and the compiler must not either.
    const dir = makeFixtureDir();
    const absoluteEntry = join(dir, "_probe.tsx");
    writeFileSync(
      absoluteEntry,
      `import React from "react"; console.log(React.createElement("p")); export default function App(){return null;}`,
    );
    const originalCwd = process.cwd();
    try {
      process.chdir(dir);
      const fromInside = await tryBuildBytes(absoluteEntry);
      expect(fromInside.success).toBe(true);
      process.chdir(originalCwd);
      const fromOutside = await tryBuildBytes(absoluteEntry);
      expect(fromOutside.success).toBe(true);
      // Bytes DIFFER between cwds, even with the same absolute entry.
      // The invariant the task inherits is to NOT change cwd between
      // compiles. (Same cwd → same bytes, proved by the prior test.)
      expect(fromOutside.sha256).not.toBe(fromInside.sha256);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

interface BuildResultWithBytes {
  readonly success: boolean;
  readonly messages: readonly string[];
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

async function tryBuildBytes(entryPath: string): Promise<BuildResultWithBytes> {
  const result = await Bun.build({
    entrypoints: [entryPath],
    target: "browser",
    format: "esm",
    minify: false,
    splitting: false,
    sourcemap: "none",
    external: [],
    throw: false,
    plugins: [tsxAllowlistResolverPlugin()],
  });
  const firstOutput = result.outputs[0];
  if (firstOutput === undefined) {
    return {
      success: result.success,
      messages: result.logs.map((log) => log.message),
      bytes: new Uint8Array(0),
      sha256: "",
    };
  }
  const bytes = new Uint8Array(await firstOutput.arrayBuffer());
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    success: result.success,
    messages: result.logs.map((log) => log.message),
    bytes,
    sha256,
  };
}
