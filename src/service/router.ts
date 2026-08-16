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
  checkCommandImplemented,
  type CommandRequest,
} from "../shared/contracts/commands";
import { FacetError } from "../shared/errors/facet-error";
import { join, normalize, relative } from "node:path";
import { resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

import { requireAnyBearer, checkMutationSecurityHeaders } from "./security/auth";
import {
  checkHostOrigin,
  isCrossSiteRejection,
  isMissingHostRejection,
  resolveHost,
  type HostOriginResult,
} from "./security/host-origin";
import { dispatch, type DispatcherDeps } from "./dispatcher";
import { handleStream, type RevisionBroadcaster } from "./stream";
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
import { buildFrameDocument } from "../gallery-web/frame-html";
import { ARTIFACT_TYPES } from "../shared/contracts/artifact-types";
import { ArtifactTypeSchema } from "../shared/contracts/artifact";
import { latestStoredVerdict } from "./stored-verdict";

const ROUTE_API = "/api/v1/commands";
const ROUTE_STREAM = "/api/v1/stream";
const ROUTE_GALLERY = "/gallery";
const ROUTE_FRAME = "/gallery/frame";
const ROUTE_BOOTSTRAP = "/api/v1/gallery/bootstrap";
const ROUTE_RELEASE = "/api/v1/gallery/release";
const ROUTE_SOURCE = "/api/v1/gallery/source";
const FRAME_RUNTIME_PREFIX = `${ROUTE_FRAME}/runtime/`;
const FRAME_CHUNK_PREFIX = `${ROUTE_FRAME}/chunks/`;
const TIER1_TRACE = process.env.FACET_TIER1_TRACE === "1";

function traceTier1Transport(stage: string): void {
  if (!TIER1_TRACE) return;
  process.stderr.write(`[tier1-transport] ${stage}\n`);
}

function isFrameAssetPath(path: string): boolean {
  return (
    ((path.startsWith(FRAME_RUNTIME_PREFIX) || path.startsWith(FRAME_CHUNK_PREFIX)) &&
      path.endsWith(".js")) ||
    path === `${ROUTE_FRAME}/frame.css` ||
    path === `${ROUTE_FRAME}/artifact.css`
  );
}

function startRequestHeartbeat(requestId: string, command: string): () => void {
  if (!TIER1_TRACE) return () => {};
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
    traceTier1Transport(
      `request:heartbeat tick=${ticks} command=${command} requestId=${requestId}`,
    );
  }, 1_000);
  heartbeat.unref();
  traceTier1Transport(`request:heartbeat:start command=${command} requestId=${requestId}`);
  return () => {
    clearInterval(heartbeat);
    traceTier1Transport(
      `request:heartbeat:stop ticks=${ticks} command=${command} requestId=${requestId}`,
    );
  };
}

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
  /** Per-artifact SSE fan-out the stream route registers into. */
  readonly broadcaster: RevisionBroadcaster;
  readonly heartbeatIntervalMs?: number;
  readonly galleryBootstrap?: Map<
    string,
    { readonly artifactId: string; readonly revisionSha: string; readonly leaseId: string }
  >;
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
  const stopHeartbeat = startRequestHeartbeat(requestId, command.command);
  try {
    const result = await dispatch(deps, command, requestId);
    traceTier1Transport(
      `router:dispatch-result-received command=${command.command} requestId=${requestId}`,
    );
    let resultForWire = result;
    if (command.command === "open") {
      const openResult = result as {
        readonly artifactId: string;
        readonly revisionSha: string;
        readonly lease: { readonly leaseId: string; readonly expiresAt: number };
      };
      const token = crypto.randomUUID();
      deps.galleryBootstrap?.set(token, {
        artifactId: openResult.artifactId,
        revisionSha: openResult.revisionSha,
        leaseId: openResult.lease.leaseId,
      });
      resultForWire = {
        ...(result as Record<string, unknown>),
        frameUrl: `${resolveHost(deps.ownOrigin)}/gallery#bootstrap=${encodeURIComponent(token)}`,
      };
    }
    const safeResult = CommandResultSchema.parse(resultForWire);
    traceTier1Transport(
      `router:envelope-response:start command=${command.command} requestId=${requestId}`,
    );
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
    stopHeartbeat();
    deps.idle.release(`request:${requestId}`);
  }
}

export function buildRouter(deps: RouterDeps): {
  fetch: (req: Request) => Promise<Response> | Response;
} {
  const bootstrap = new Map<
    string,
    { readonly artifactId: string; readonly revisionSha: string; readonly leaseId: string }
  >();
  const galleryRoot = join(import.meta.dir, "../../dist/gallery");
  // style-src allows 'unsafe-inline' because mermaid injects its theme
  // as a <style> element into the rendered SVG (operator-ruled posture
  // for this local-only tool); script-src stays 'self' blob: — no
  // script relaxation.
  const galleryCsp =
    "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; font-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
  let galleryBuild: Promise<void> | null = null;

  const ensureGalleryBuild = async (): Promise<void> => {
    const requiredAssets = [
      join(galleryRoot, "index.html"),
      join(galleryRoot, "frame", "frame.css"),
      join(galleryRoot, "frame", "artifact.css"),
      ...ARTIFACT_TYPES.map((artifactType) =>
        join(galleryRoot, "frame", "runtime", `${artifactType}.js`),
      ),
    ];
    if ((await Promise.all(requiredAssets.map((asset) => Bun.file(asset).exists()))).every(Boolean))
      return;
    galleryBuild ??= (async () => {
      const process = Bun.spawn(["bun", "scripts/build-gallery.ts"], {
        cwd: join(import.meta.dir, "../.."),
        stderr: "pipe",
        stdout: "ignore",
      });
      const exitCode = await process.exited;
      if (exitCode !== 0) {
        const details = await new Response(process.stderr).text();
        throw new Error(`Gallery build failed (exit ${exitCode})${details ? `: ${details}` : ""}`);
      }
    })().finally(() => {
      galleryBuild = null;
    });
    await galleryBuild;
  };

  const galleryResponse = async (path: string): Promise<Response> => {
    try {
      await ensureGalleryBuild();
    } catch (error) {
      return new Response(error instanceof Error ? error.message : "Gallery build failed", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const requested = path === ROUTE_GALLERY ? "index.html" : path.replace(/^\/gallery\/?/, "");
    return serveGalleryFile(requested, galleryCsp);
  };

  const serveGalleryFile = async (
    requested: string,
    csp?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(requested);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const candidate = normalize(join(galleryRoot, decoded));
    const rootRelative = relative(galleryRoot, candidate);
    if (rootRelative.startsWith("..") || rootRelative.includes("/..")) {
      return new Response("Not found", { status: 404 });
    }
    const file = Bun.file(candidate);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": file.type || "application/octet-stream",
        ...extraHeaders,
        ...(csp === undefined ? {} : { "content-security-policy": csp }),
      },
    });
  };

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      if (isFrameAssetPath(path) && req.method.toUpperCase() === "GET") {
        try {
          await ensureGalleryBuild();
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "Gallery build failed", {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
          });
        }
        return serveGalleryFile(path.replace(/^\/gallery\//, ""));
      }
      if (path === ROUTE_FRAME && req.method.toUpperCase() === "GET") {
        const artifactType = ArtifactTypeSchema.safeParse(url.searchParams.get("type"));
        if (!artifactType.success) {
          return new Response("Invalid frame artifact type", {
            status: 400,
            headers: {
              "cache-control": "no-store",
              "content-type": "text/plain; charset=utf-8",
            },
          });
        }
        try {
          await ensureGalleryBuild();
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "Gallery build failed", {
            status: 500,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
            },
          });
        }
        return new Response(
          buildFrameDocument({
            artifactType: artifactType.data,
            runtimeUrl: `${FRAME_RUNTIME_PREFIX}${artifactType.data}.js`,
          }),
          {
            status: 200,
            headers: {
              "cache-control": "no-store",
              "content-security-policy": galleryCsp,
              "content-type": "text/html; charset=utf-8",
            },
          },
        );
      }
      if (
        (path === ROUTE_GALLERY || path.startsWith(`${ROUTE_GALLERY}/`)) &&
        req.method.toUpperCase() === "GET"
      ) {
        return galleryResponse(path);
      }
      if (req.method.toUpperCase() === "GET" && path !== "/") {
        // `ensureGalleryBuild` requires index.html to exist, so a direct
        // navigation to /index.html (or any other .html document) reaches
        // this fallback and must carry the same gallery CSP as /gallery —
        // otherwise the gallery document ships without its CSP purely
        // because of which URL served it.
        const isDocument = /\.html$/i.test(path);
        const rootAssetResponse = await serveGalleryFile(
          path.replace(/^\//, ""),
          isDocument ? galleryCsp : undefined,
          {},
        );
        if (rootAssetResponse.status !== 404) return rootAssetResponse;
      }
      if (path === ROUTE_BOOTSTRAP && req.method.toUpperCase() === "POST") {
        const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
        const token = typeof body?.token === "string" ? body.token : null;
        const handoff = token === null ? undefined : bootstrap.get(token);
        if (token !== null) bootstrap.delete(token);
        const lease =
          handoff === undefined
            ? undefined
            : deps.leases.list().find((entry) => entry.leaseId === handoff.leaseId);
        if (handoff === undefined || lease === undefined) {
          return envelopeResponse(
            errEnvelope(generateRequestId(), {
              code: "invalid_envelope",
              message: "Bootstrap capability is invalid or already used",
              retryable: false,
            }),
            401,
          );
        }
        return new Response(
          JSON.stringify({
            authorization: `Bearer ${deps.installToken}`,
            artifactId: handoff.artifactId,
            revisionSha: handoff.revisionSha,
            lease: { leaseId: lease.leaseId, expiresAt: lease.expiresAt },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          },
        );
      }
      if (path === ROUTE_RELEASE && req.method.toUpperCase() === "POST") {
        const meta = readRequestMeta(req);
        const auth = requireAnyBearer(meta.authorization, [deps.installToken]);
        const leaseId = meta.headers.get("x-gallery-lease");
        const artifactId = meta.headers.get("x-gallery-artifact");
        if (!auth.ok || leaseId === null || artifactId === null) {
          return envelopeResponse(
            errEnvelope(generateRequestId(), {
              code: "invalid_envelope",
              message: "Display release requires authorization and lease headers",
              retryable: false,
            }),
            401,
          );
        }
        const lease = deps.leases
          .list()
          .find((entry) => entry.leaseId === leaseId && entry.artifactId === artifactId);
        if (lease !== undefined) {
          deps.leases.release(leaseId);
          deps.idle.release(`lease:${leaseId}`);
        }
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      if (path === ROUTE_SOURCE && req.method.toUpperCase() === "GET") {
        const meta = readRequestMeta(req);
        const hostCheck = checkHostOrigin({
          method: meta.method,
          host: meta.host,
          origin: meta.origin,
          secFetchSite: meta.secFetchSite,
          expectedHost: resolveHost(deps.expectedHost),
          ownOrigin: resolveHost(deps.ownOrigin),
        });
        if (!hostCheck.ok)
          return new Response(null, { status: statusForHostCheck(hostCheck.error) });
        const auth = requireAnyBearer(meta.authorization, [deps.installToken]);
        const leaseId = meta.headers.get("x-gallery-lease");
        const artifactId = meta.headers.get("x-gallery-artifact");
        if (!auth.ok || leaseId === null || artifactId === null) {
          return new Response(null, { status: 401, headers: { "cache-control": "no-store" } });
        }
        // artifactId comes from the CALLER's X-Gallery-Artifact header, so the
        // lease must be matched on BOTH fields: a valid lease for artifact A
        // paired with a header naming artifact B would otherwise read B's bytes.
        const lease = deps.leases
          .list()
          .find((entry) => entry.leaseId === leaseId && entry.artifactId === artifactId);
        if (lease === undefined) {
          return new Response(null, { status: 401, headers: { "cache-control": "no-store" } });
        }
        const revisionSha = new URL(req.url).searchParams.get("revisionSha");
        if (revisionSha === null || revisionSha.length === 0) {
          return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
        }
        const revision = deps.repository.getRevisionBySha(artifactId, revisionSha);
        if (revision === null) {
          return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
        }
        return new Response(
          JSON.stringify({
            artifactId,
            revisionSha: revision.sha256,
            artifactType: revision.artifactType,
            renderer: revision.renderer,
            source: new TextDecoder().decode(revision.source),
            verdict: latestStoredVerdict(deps.repository, revision),
            ...(revision.artifactType === "tsx"
              ? (() => {
                  const run = deps.repository.listRenderRuns({
                    revisionId: revision.id,
                    tier: 0,
                  })[0];
                  const compiledPath = run?.compiledPath ?? null;
                  const root = deps.repository.getEvidenceRoot();
                  if (compiledPath === null || root === undefined) return {};
                  const candidate = resolvePath(compiledPath);
                  const evidenceRoot = resolvePath(root);
                  const rootRelative = relative(evidenceRoot, candidate);
                  if (rootRelative.startsWith("..") || rootRelative.includes("/..")) return {};
                  try {
                    return {
                      renderBytesBase64: Buffer.from(readFileSync(candidate)).toString("base64"),
                      execution: revision.execution ?? "static",
                    };
                  } catch {
                    return {};
                  }
                })()
              : {}),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          },
        );
      }
      if (path === ROUTE_API) return handleCommand({ ...deps, galleryBootstrap: bootstrap }, req);
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
