/**
 * HTTP method guards shared between `auth.ts` and `host-origin.ts`.
 *
 * Both files need to recognise state-changing methods (POST / PUT /
 * DELETE / PATCH) for their respective checks (mutation Content-Type
 * gate, cross-site forgery defense). Single source of truth so the two
 * checks can never disagree on what counts as a mutation.
 */

export function isMutationMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "POST" || upper === "PUT" || upper === "DELETE" || upper === "PATCH";
}
