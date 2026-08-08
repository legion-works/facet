/**
 * Service router — single entrypoint mapping HTTP requests to command
 * verbs, enveloping results, applying security guards.
 *
 * Guard order: Host → Bearer auth → mutation Content-Type → raw body
 * size cap → body read/parse → dispatch. Auth happens BEFORE any
 * body read/parse (unauth malformed body → 401, not 400). Promote
 * accepts install OR operator bearer (constant-time). Cross-site
 * mutation failures map to 403 (CSRF).
 *
 * The pieces of each guard live in sibling modules (`router-guards.ts`
 * for body-cap + parse + status mapping, `http-utils.ts` for the
 * envelope → Response builder, `security/host-origin.ts` for the host
 * check + `resolveHost`, `security/auth.ts` for the bearer check).
 * This file is intentionally the orchestration: read the function
 * top-to-bottom and the guard order is the sequence of statements.
 */

import { errEnvelope, okEnvelope, parseEnvelope } from "../shared/contracts/envelope";
import {
  CommandRequestSchema,
  CommandResultSchema,
  ReservedExportResultSchema,
  checkCommandImplemented,
  type CommandRequest,
} from "../shared/contracts/commands";
import { FacetError } from "../shared/errors/facet-error";

import { requireAnyBearer, checkMutationSecurityHeaders } from "./security/auth";
import {
  checkHostOrigin,
  isCrossSiteRejection,
  isMissingHostRejection,
  resolveHost,
  type HostOriginResult,
} from "./security/host-origin";
import { dispatch, type DispatcherDeps } from "./dispatcher";
import { handleStream } from "./stream";
import { envelopeResponse, generateRequestId, pickRequestId } from "./http-utils";
import {
  INVALID_JSON,
  RAW_BODY_CAP_BYTES,
  parseBody,
  readCappedBody,
  readRequestMeta,
  statusFor,
  type RequestMeta,
} from "./router-guards";
import type { FacetLogger } from "../shared/logging/logger";

const ROUTE_API = "/api/v1/commands";
const ROUTE_STREAM = "/api/v1/stream";

// Re-export so `import { RAW_BODY_CAP_BYTES } from "./router"` keeps
// working — the constant moved to `router-guards.ts` for size reasons.
export { RAW_BODY_CAP_BYTES };

export interface RouterDeps extends DispatcherDeps {
  readonly installToken: string;
  readonly promoteToken: string | null;
  readonly logger: FacetLogger;
  readonly expectedHost: string | (() => string);
  readonly ownOrigin: string | (() => string);
  readonly startTime: number;
}

function statusForHostCheck(error: FacetError | undefined): number {
  // Cross-site mutation → 403 (CSRF). Missing host → 421 (Misdirected
  // Request, per RFC 8470 — distinguishes "no host" from "wrong host",
  // both of which are 400-ish but the typed 421 makes the missing-host
  // case unambiguous in logs and test assertions). Every other
  // host/origin failure is a 400.
  if (isCrossSiteRejection(error)) return 403;
  if (isMissingHostRejection(error)) return 421;
  return 400;
}

export async function handleCommand(deps: RouterDeps, req: Request): Promise<Response> {
  const startNs = performance.now();
  const meta: RequestMeta = readRequestMeta(req);
  const requestId = pickRequestId(null);

  // 1. Host exact-match (DNS-rebinding defense). Reject missing Host.
  const hostCheck: HostOriginResult = checkHostOrigin({
    method: meta.method,
    host: meta.host,
    origin: meta.origin,
    secFetchSite: meta.secFetchSite,
    expectedHost: resolveHost(deps.expectedHost),
    ownOrigin: resolveHost(deps.ownOrigin),
  });
  if (!hostCheck.ok) {
    deps.logger.warn("request.rejected", {
      reason: "host_origin",
      errorCode: hostCheck.error.code,
      url: meta.url,
    });
    return envelopeResponse(
      errEnvelope(requestId, hostCheck.error.toBody()),
      statusForHostCheck(hostCheck.error),
    );
  }

  if (meta.method.toUpperCase() === "GET") {
    return envelopeResponse(
      errEnvelope(requestId, {
        code: "invalid_request",
        message: "GET is not supported on the command endpoint",
        retryable: false,
      }),
      405,
    );
  }

  // 2. Bearer auth BEFORE any body read. Install or operator bearer is
  //    accepted; the per-verb gate below enforces the operator requirement
  //    for promote.
  const authCandidates: string[] = [deps.installToken];
  if (deps.promoteToken !== null) authCandidates.push(deps.promoteToken);
  const authResult = requireAnyBearer(meta.authorization, authCandidates);
  if (!authResult.ok) {
    deps.logger.warn("auth.failed", {
      requestId,
      errorCode: authResult.error.code,
    });
    return envelopeResponse(errEnvelope(requestId, authResult.error.toBody()), 401);
  }
  const matchedIsOperator = authResult.matchedIndex > 0; // index 0 = install, 1 = operator

  // 3. Mutation Content-Type. GET already handled; mutations require JSON.
  const contentCheck = checkMutationSecurityHeaders({
    method: meta.method,
    contentType: meta.contentType,
  });
  if (!contentCheck.ok) {
    deps.logger.warn("request.rejected", {
      reason: "content_type",
      errorCode: contentCheck.error.code,
    });
    return envelopeResponse(errEnvelope(requestId, contentCheck.error.toBody()), 400);
  }

  // 4. Read body, enforcing the raw size cap BEFORE JSON.parse.
  let bodyText: string;
  try {
    bodyText = await readCappedBody(req, meta.contentLength);
  } catch (error) {
    const err = FacetError.from(error);
    deps.logger.warn("request.rejected", {
      reason: "body_size",
      errorCode: err.code,
    });
    return envelopeResponse(
      errEnvelope(requestId, err.toBody()),
      err.code === "payload_too_large" ? 413 : 400,
    );
  }
  const bodyRaw = parseBody(bodyText);
  if (bodyRaw === INVALID_JSON) {
    const err = new FacetError("invalid_envelope", "Request body is not valid JSON", {
      retryable: false,
    });
    return envelopeResponse(errEnvelope(requestId, err.toBody()), 400);
  }

  // 5. Parse envelope.
  const env = parseEnvelope(bodyRaw);
  if (!env.ok) {
    return envelopeResponse(errEnvelope(requestId, env.body), 400);
  }
  if (env.envelope.ok === false) {
    return envelopeResponse(env.envelope, 400);
  }

  // 6. Parse the command.
  const cmdParse = CommandRequestSchema.safeParse(env.envelope.data);
  if (!cmdParse.success) {
    const err = new FacetError("invalid_request", "Command request failed validation", {
      retryable: false,
      details: { issueCount: cmdParse.error.issues.length },
    });
    return envelopeResponse(errEnvelope(requestId, err.toBody()), 400);
  }
  const command: CommandRequest = cmdParse.data;

  // 7. Reserved-verb gate.
  const reserved = checkCommandImplemented(command.command);
  if (reserved !== null) {
    if (command.command === "export") {
      const result = ReservedExportResultSchema.parse({
        command: "export",
        requestId,
        accepted: false,
        reason: "export is reserved and not implemented in this build",
      });
      return envelopeResponse(okEnvelope(requestId, result), 200);
    }
    return envelopeResponse(errEnvelope(requestId, reserved.toBody()), 400);
  }

  // 8. Promote requires the operator token (constant-time compare).
  if (command.command === "promote") {
    if (!matchedIsOperator) {
      const err = new FacetError("invalid_envelope", "Promote requires the operator token", {
        retryable: false,
        details: { reason: "operator_token_required" },
      });
      return envelopeResponse(errEnvelope(requestId, err.toBody()), 403);
    }
  }

  deps.idle.acquire(`request:${requestId}`);
  try {
    const result = await dispatch(deps, command, requestId);
    const safeResult = CommandResultSchema.parse(result);
    const elapsedMs = Math.round(performance.now() - startNs);
    deps.logger.info("command.completed", {
      requestId,
      command: command.command,
      durationMs: elapsedMs,
    });
    return envelopeResponse(okEnvelope(requestId, safeResult), 200);
  } catch (error) {
    const facetError = FacetError.from(error);
    const elapsedMs = Math.round(performance.now() - startNs);
    deps.logger.warn("command.failed", {
      requestId,
      command: command.command,
      errorCode: facetError.code,
      durationMs: elapsedMs,
    });
    return envelopeResponse(errEnvelope(requestId, facetError.toBody()), statusFor(facetError));
  } finally {
    deps.idle.release(`request:${requestId}`);
  }
}

export function buildRouter(deps: RouterDeps): {
  fetch: (req: Request) => Promise<Response> | Response;
} {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === ROUTE_API) return handleCommand(deps, req);
      if (path === ROUTE_STREAM) {
        const meta = readRequestMeta(req);
        return handleStream(deps, {
          url: meta.url,
          method: meta.method,
          host: meta.host,
          origin: meta.origin,
          secFetchSite: meta.secFetchSite,
          authorization: meta.authorization,
          headers: meta.headers,
        });
      }
      return envelopeResponse(
        errEnvelope(generateRequestId(), {
          code: "invalid_request",
          message: "Unknown route",
          retryable: false,
        }),
        404,
      );
    },
  };
}
