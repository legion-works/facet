/**
 * Service router — single entrypoint mapping HTTP requests to command
 * verbs, enveloping results, applying security guards.
 *
 * Guard order: Host exact-match → mutation headers → Bearer auth →
 * dispatch (delegated to dispatcher.ts).
 *
 * Every response carries `Cache-Control: no-store`. SSE handling lives
 * in stream.ts; this file owns the command route + fetch() entrypoint.
 */

import { randomUUID } from "node:crypto";

import {
  errEnvelope,
  okEnvelope,
  parseEnvelope,
  type FacetEnvelope,
} from "../shared/contracts/envelope";
import {
  CommandRequestSchema,
  CommandResultSchema,
  ReservedExportResultSchema,
  checkCommandImplemented,
  type CommandRequest,
} from "../shared/contracts/commands";
import { FacetError } from "../shared/errors/facet-error";

import { requireBearer, checkMutationSecurityHeaders, parseBearer } from "./security/auth";
import { checkHostOrigin } from "./security/host-origin";
import { dispatch, type DispatcherDeps } from "./dispatcher";
import { handleStream } from "./stream";
import type { FacetLogger } from "../shared/logging/logger";

const NO_STORE = "no-store";
const ROUTE_API = "/api/v1/commands";
const ROUTE_STREAM = "/api/v1/stream";

export interface RouterDeps extends DispatcherDeps {
  readonly installToken: string;
  readonly promoteToken: string | null;
  readonly logger: FacetLogger;
  readonly expectedHost: string | (() => string);
  readonly ownOrigin: string | (() => string);
  readonly startTime: number;
}

function resolveHost(value: string | (() => string)): string {
  return typeof value === "function" ? value() : value;
}

export interface ParsedRequest {
  readonly url: string;
  readonly method: string;
  readonly host: string | null;
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  readonly contentType: string | null;
  readonly authorization: string | null;
  readonly bodyText: string | null;
}

async function parseIncomingRequest(req: Request): Promise<ParsedRequest> {
  const url = new URL(req.url);
  let bodyText: string | null = null;
  const upper = req.method.toUpperCase();
  if (upper !== "GET" && upper !== "HEAD") {
    bodyText = await req.text();
  }
  return {
    url: url.pathname + url.search,
    method: req.method,
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    contentType: req.headers.get("content-type"),
    authorization: req.headers.get("authorization"),
    bodyText,
  };
}

function envelopeResponse(envelope: FacetEnvelope<unknown>, status: number): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": NO_STORE,
    },
  });
}

function generateRequestId(): string {
  return `req-${randomUUID()}`;
}

function pickRequestId(header: string | null | undefined): string {
  if (header === null || header === undefined) return generateRequestId();
  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed : generateRequestId();
}

function parseBody(bodyText: string | null): unknown {
  if (bodyText === null) return null;
  if (bodyText.length === 0) return null;
  try {
    return JSON.parse(bodyText);
  } catch {
    return Symbol.for("invalid_json");
  }
}

function statusFor(error: FacetError): number {
  switch (error.code) {
    case "artifact_not_found":
    case "revision_not_found":
    case "template_not_found":
      return 404;
    case "payload_too_large":
      return 413;
    case "reserved_not_implemented":
    case "unsupported_reserved_type":
    case "invalid_envelope":
    case "invalid_request":
    case "unknown_schema_version":
      return 400;
    case "duplicate_revision":
    case "constraint":
    case "foreign_key":
    case "immutable_revision":
    case "invalid_artifact_type":
      return 409;
    default:
      return 500;
  }
}

export async function handleCommand(deps: RouterDeps, req: ParsedRequest): Promise<Response> {
  const startNs = performance.now();
  const requestId = pickRequestId(null);

  const hostCheck = checkHostOrigin({
    method: req.method,
    host: req.host,
    origin: req.origin,
    secFetchSite: req.secFetchSite,
    expectedHost: resolveHost(deps.expectedHost),
    ownOrigin: resolveHost(deps.ownOrigin),
  });
  if (!hostCheck.ok) {
    deps.logger.warn("request.rejected", {
      reason: "host_origin",
      errorCode: hostCheck.error.code,
      url: req.url,
    });
    return envelopeResponse(errEnvelope(requestId, hostCheck.error.toBody()), 400);
  }

  const contentCheck = checkMutationSecurityHeaders({
    method: req.method,
    contentType: req.contentType,
  });
  if (!contentCheck.ok) {
    deps.logger.warn("request.rejected", {
      reason: "content_type",
      errorCode: contentCheck.error.code,
    });
    return envelopeResponse(errEnvelope(requestId, contentCheck.error.toBody()), 400);
  }

  if (req.method.toUpperCase() === "GET") {
    return envelopeResponse(
      errEnvelope(requestId, {
        code: "invalid_request",
        message: "GET is not supported on the command endpoint",
        retryable: false,
      }),
      405,
    );
  }

  const bodyRaw = parseBody(req.bodyText);
  if (bodyRaw === Symbol.for("invalid_json")) {
    const err = new FacetError("invalid_envelope", "Request body is not valid JSON", {
      retryable: false,
    });
    return envelopeResponse(errEnvelope(requestId, err.toBody()), 400);
  }

  const authResult = requireBearer(req.authorization, deps.installToken);
  if (!authResult.ok) {
    deps.logger.warn("auth.failed", {
      requestId,
      errorCode: authResult.error.code,
    });
    return envelopeResponse(errEnvelope(requestId, authResult.error.toBody()), 401);
  }

  const env = parseEnvelope(bodyRaw);
  if (!env.ok) {
    return envelopeResponse(errEnvelope(requestId, env.body), 400);
  }
  if (env.envelope.ok === false) {
    return envelopeResponse(env.envelope, 400);
  }

  const cmdParse = CommandRequestSchema.safeParse(env.envelope.data);
  if (!cmdParse.success) {
    const err = new FacetError("invalid_request", "Command request failed validation", {
      retryable: false,
      details: { issueCount: cmdParse.error.issues.length },
    });
    return envelopeResponse(errEnvelope(requestId, err.toBody()), 400);
  }
  const command: CommandRequest = cmdParse.data;

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

  if (command.command === "promote") {
    const supplied = parseBearer(req.authorization);
    if (deps.promoteToken === null || supplied === null || supplied !== deps.promoteToken) {
      const err = new FacetError("invalid_envelope", "Promote requires the operator token", {
        retryable: false,
        details: { reason: "operator_token_missing_or_mismatch" },
      });
      return envelopeResponse(errEnvelope(requestId, err.toBody()), 401);
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
      const parsed = await parseIncomingRequest(req);
      const url = parsed.url.split("?")[0] ?? parsed.url;
      if (url === ROUTE_API) return handleCommand(deps, parsed);
      if (url === ROUTE_STREAM) {
        return handleStream(deps, {
          url: parsed.url,
          method: parsed.method,
          host: parsed.host,
          origin: parsed.origin,
          secFetchSite: parsed.secFetchSite,
          contentType: parsed.contentType,
          authorization: parsed.authorization,
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
