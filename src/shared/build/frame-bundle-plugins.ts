/**
 * Bun.build plugins shared by every frame-bundle build (gallery frame
 * bootstrap + Tier 1 verifier harness).
 *
 * The dompurify alias points `import "dompurify"` at the frame shim,
 * which re-instantiates DOMPurify against the frame's own window. The
 * import-time default instance captures unbound Document methods from
 * whatever global the bundler resolved; inlined into a srcdoc bundle
 * those throw `Illegal invocation` at sanitize time. The shim import
 * itself is excluded from the alias so it resolves the real package.
 */

import { basename, join } from "node:path";

/**
 * Minimal shape of `Bun.build`'s plugin object — the public Bun type
 * does not export `BunBuildPlugin` (only `BunPlugin` and the inferred
 * shape from the bundler overloads), so we declare the surface this
 * module uses. The `setup` callback receives the live build handle and
 * a per-resolution args bag; both are inferred from the API.
 */
interface BunBuildPlugin {
  readonly name: string;
  setup(build: {
    onResolve(
      filter: { readonly filter: RegExp },
      callback: (args: {
        readonly path: string;
        readonly importer: string;
      }) => { readonly path: string } | undefined,
    ): void;
  }): void;
}

const DOMPURIFY_SHIM_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "gallery-web",
  "frame",
  "renderers",
  "dompurify-shim.ts",
);

export function frameBundlePlugins(): BunBuildPlugin[] {
  return [
    {
      name: "facet-dom-purify-frame-alias",
      setup(build) {
        build.onResolve({ filter: /^dompurify$/ }, (args) => {
          // The shim's OWN import must resolve to the real package.
          // Bun reports the importer through symlink-copied paths
          // (e.g. /tmp/node_modules/…), so match by basename, not by
          // exact path.
          if (basename(args.importer) === "dompurify-shim.ts") return undefined;
          return { path: DOMPURIFY_SHIM_PATH };
        });
      },
    },
  ];
}
