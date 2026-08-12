/**
 * Fixed TSX import allowlist.
 *
 * D6 of the TSX design: compilation runs inside the netns worker with no
 * egress. The import set is a fixed vendored allowlist:
 *   - `react`, `react-dom`, and `react-dom/client` (default exports);
 *   - the JSX runtimes `react/jsx-runtime` and `react/jsx-dev-runtime`.
 *
 * Arbitrary npm is rejected outright: resolving dependencies at publish
 * time would put network egress in the middle of the validation path,
 * which the trust core forbids. A dependency that is not vendored is not
 * available.
 *
 * Policy is exposed as plain data so the AST walker and the boundary
 * check can both consume the same source of truth.
 */

export const TSX_ALLOWED_MODULES = new Set([
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
]);

export type TsxImportDenialReason =
  | "tsx_import_relative"
  | "tsx_import_url"
  | "tsx_import_not_allowlisted";

export interface TsxImportDenial {
  readonly code: "tsx_import_denied";
  readonly message: string;
  readonly module: string;
  readonly reason: TsxImportDenialReason;
}

/**
 * Decide whether a single import specifier is allowed under D6.
 *
 * Reject rules, in order:
 *   1. Anything that looks like a URL (starts with a scheme, `//`, or a
 *      `data:` prefix) — `tsx_import_url`.
 *   2. Relative imports (`.`, `..`, `/`) — `tsx_import_relative`.
 *   3. Any package that is not in `TSX_ALLOWED_MODULES` — `tsx_import_not_allowlisted`.
 *
 * Returns `null` when the specifier is allowed.
 */
export function classifyTsxImport(specifier: string): TsxImportDenial | null {
  if (
    specifier.startsWith("data:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("//")
  ) {
    return {
      code: "tsx_import_denied",
      message: `TSX import not allowed: URL specifier "${specifier}"`,
      module: specifier,
      reason: "tsx_import_url",
    };
  }
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "." ||
    specifier === ".."
  ) {
    return {
      code: "tsx_import_denied",
      message: `TSX import not allowed: relative specifier "${specifier}"`,
      module: specifier,
      reason: "tsx_import_relative",
    };
  }
  if (specifier.startsWith("/")) {
    return {
      code: "tsx_import_denied",
      message: `TSX import not allowed: absolute path "${specifier}"`,
      module: specifier,
      reason: "tsx_import_relative",
    };
  }
  if (!TSX_ALLOWED_MODULES.has(specifier)) {
    return {
      code: "tsx_import_denied",
      message: `TSX import not allowed: "${specifier}" is not in the vendored allowlist`,
      module: specifier,
      reason: "tsx_import_not_allowlisted",
    };
  }
  return null;
}
