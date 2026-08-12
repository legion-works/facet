/**
 * Hand-written pin of `FROZEN_CSP_TEMPLATE`. Compared against the
 * production constant so a directive drift fails even if every consumer
 * is updated together. Do not derive this string from the template.
 */
export const FROZEN_CSP_LITERAL =
  "default-src 'none'; script-src 'nonce-<BOOTSTRAP_NONCE>'; style-src 'unsafe-inline'; " +
  "img-src data: https:; font-src data:; worker-src 'none'; connect-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'; frame-src 'none'; media-src 'none'";

export function parseCspDirectives(csp: string): readonly (readonly [string, string])[] {
  return csp.split("; ").map((directive) => {
    const [name, ...sources] = directive.split(" ");
    return [name!, sources.join(" ")] as const;
  });
}
