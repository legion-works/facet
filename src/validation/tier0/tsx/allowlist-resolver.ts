/**
 * Bun build plugin that enforces the TSX module allowlist at the resolver
 * layer.
 *
 * D6 of the TSX design declares a fixed vendored allowlist. The AST policy
 * rejects non-allowlisted `import` declarations with a typed verdict, but
 * the AST walker is one line of defense — `require()`, dynamic paths, and
 * other indirect routes can slip past it. This plugin is the second line:
 * it intercepts every bare module specifier and redirects non-allowlisted
 * names to a sentinel that fails to load. A bypass of the AST layer still
 * cannot pull a forbidden module into a bundle.
 *
 * Bun's `onResolve` API returns `{ path, namespace?, external? }` — there is
 * no first-class way to emit a typed error from the resolver hook. We work
 * around this by redirecting to a fixed sentinel path and throwing from
 * `onLoad` when the bundler tries to load it; the resulting build log
 * carries the violated module name. This is intentionally clunky — the
 * AST walker produces the structured `DiscriminativeError` verdict, and
 * this plugin exists only so a code path that bypasses the walker still
 * cannot bundle a forbidden package.
 *
 * ## Limitation
 *
 * The plugin intercepts BARE specifiers (anything that does not start with
 * `.`, `/`, or `\`). Relative imports are checked by the AST walker; URL
 * imports are blocked at the AST layer; this plugin handles the node_modules
 * path. Anything that reaches the bundler via a hook the plugin cannot see
 * (Bun's built-in pre-resolution, native module records) is OUT OF SCOPE.
 */

import type { BunPlugin } from "bun";

import { TSX_ALLOWED_MODULES } from "../../../shared/tsx/import-policy";

/**
 * Sentinel path the plugin redirects every non-allowlisted import to.
 * Resolving or loading this path fails, and the `onLoad` hook throws a
 * named error so the build log carries the violated module.
 */
const SENTINEL_PATH = "/__facet_tsx_allowlist_violation__";

/**
 * Build the allowlist resolver plugin. Pass it to `Bun.build({ plugins })`
 * so every bare module resolution goes through the gate.
 */
export function tsxAllowlistResolverPlugin(): BunPlugin {
  const violations: string[] = [];
  return {
    name: "facet-tsx-allowlist-resolver",
    setup(build) {
      build.onResolve({ filter: /^[^./\\:]/ }, (args) => {
        // The entrypoint is passed through onResolve with kind =
        // "entry-point-build"; we let it pass to the default resolver.
        if (args.kind === "entry-point-build") return undefined;
        // Transitive dependencies (imports from inside node_modules) are
        // trusted to resolve themselves; only the user's top-level
        // imports are gated by the allowlist.
        if (args.importer.includes("/node_modules/")) return undefined;
        if (TSX_ALLOWED_MODULES.has(args.path)) {
          return undefined; // let the default resolver find it
        }
        violations.push(args.path);
        return { path: SENTINEL_PATH };
      });
      build.onLoad({ filter: /.*/ }, (args) => {
        if (args.path === SENTINEL_PATH) {
          throw new Error(
            `TSX allowlist violation: ${violations.join(", ")} ` +
              `is not in the vendored allowlist ` +
              `(allowed: ${[...TSX_ALLOWED_MODULES].join(", ")})`,
          );
        }
        return undefined;
      });
    },
  };
}
