/**
 * Loopback HTTP client used by every CLI verb.
 *
 * The CLI talks to the service over HTTP only — never to the
 * repository or any renderer module directly. `sendCommand` wraps
 * the request in a strict `FacetEnvelope`, sends it with Bearer auth
 * and the correct Host header, and parses the response through the
 * shared `FacetEnvelopeSchema` so a forged or drift-ed response
 * surfaces as a typed error envelope.
 *
 * Source bytes for `publish` are base64-encoded on the wire; the
 * schema's `PublishBytesSchema` accepts only valid base64, so an
 * invalid input is rejected at parse time (typed `invalid_request`).
 */

import { errEnvelope, parseEnvelope, type FacetEnvelope } from "../shared/contracts/envelope";
import {
  CommandRequestSchema,
  CommandResultSchema,
  type CommandRequest,
  type CommandResult,
} from "../shared/contracts/commands";

const TIER1_TRACE = process.env.FACET_TIER1_TRACE === "1";
export const FACET_CLIENT_COMMAND_TIMEOUT_MS = 75_000;

function traceTier1Transport(stage: string): void {
  if (!TIER1_TRACE) return;
  process.stderr.write(`[tier1-transport] ${stage}\n`);
}

import { FacetError } from "../shared/errors/facet-error";
import { generateRequestId } from "../shared/util/time";
import { isMutationMethod } from "../service/security/http-guards";
import type { ArtifactType } from "../shared/contracts/artifact-types";
import type { Renderer } from "../shared/contracts/renderers";
import type { InsecureMarker, ScreenshotError } from "../shared/contracts/validation";

export interface FacetClientOptions {
  readonly baseUrl: string;
  readonly installToken: string;
  readonly commandTimeoutMs?: number;
  /** `fetch` indirection so tests can stub network. */
  readonly fetchImpl?: typeof fetch;
}

export interface SendCommandOptions {
  /** Set true for any state-changing verb (default: derived from verb name). */
  readonly isMutation?: boolean;
  /** Extra headers to merge into the request (Content-Type is added automatically on mutations). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export class FacetClient {
  readonly #baseUrl: string;
  readonly #installToken: string;
  readonly #commandTimeoutMs: number;
  readonly #fetchImpl: typeof fetch;

  constructor(options: FacetClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#installToken = options.installToken;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? FACET_CLIENT_COMMAND_TIMEOUT_MS;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Build a typed `CommandRequest` for the given verb + args, parse
   * it through the shared schema (so a malformed CLI surface fails
   * here, not in the service), wrap it in an envelope, POST to the
   * loopback service, and return the parsed response envelope.
   *
   * On a non-2xx HTTP response the service still returns a valid
   * envelope (the router wraps every error in one), so the only
   * `throw` path is a transport-level failure (connection refused,
   * DNS error, etc.). Those surface as `FacetError("invalid_envelope",
   * ...)` so the caller can wrap them in a typed envelope for the
   * adapter.
   */
  async sendCommand(
    command: CommandRequest,
    options: SendCommandOptions = {},
  ): Promise<FacetEnvelope<CommandResult>> {
    // Re-parse the command via the strict schema — a forged or
    // drift-ed CLI surface that produced a malformed request fails
    // here with a typed issue list, never reaching the wire.
    const parsed = CommandRequestSchema.parse(command);
    const innerRequestId = parsed.requestId;
    const isMutation = options.isMutation ?? isMutationMethodFor(parsed.command);
    const envelope: FacetEnvelope<CommandRequest> = {
      schemaVersion: "facet.v1",
      requestId: generateRequestId(),
      ok: true,
      data: parsed,
    };
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#installToken}`,
      host: new URL(this.#baseUrl).host,
    };
    if (isMutation) {
      headers["content-type"] = "application/json";
    }
    if (options.extraHeaders) {
      Object.assign(headers, options.extraHeaders);
    }
    let res: Response;
    let text: string;
    const signal = AbortSignal.timeout(this.#commandTimeoutMs);
    try {
      traceTier1Transport(`client:fetch:start command=${parsed.command}`);
      res = await this.#fetchImpl(`${this.#baseUrl}/api/v1/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
        signal,
      });
      traceTier1Transport(`client:fetch:complete command=${parsed.command} status=${res.status}`);
      traceTier1Transport(`client:body:start command=${parsed.command}`);
      text = await res.text();
      traceTier1Transport(`client:body:complete command=${parsed.command} bytes=${text.length}`);
    } catch (error) {
      const timedOut = signal.aborted;
      throw new FacetError(
        "invalid_envelope",
        timedOut
          ? `Connection timed out after ${this.#commandTimeoutMs}ms`
          : `Connection failed: ${(error as Error).message}`,
        {
          retryable: true,
          cause: error,
          details: timedOut
            ? {
                reason: "connection_timeout",
                host: this.#baseUrl,
                timeoutMs: this.#commandTimeoutMs,
              }
            : { reason: "connection_failed", host: this.#baseUrl },
        },
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new FacetError(
        "invalid_envelope",
        `Service response is not valid JSON (status ${res.status})`,
        { retryable: false, details: { status: res.status } },
      );
    }
    const parsed2 = parseEnvelope(body);
    if (!parsed2.ok) {
      // The service's response was a parse failure; surface a typed
      // error envelope with the same shape as the wire would.
      return errEnvelope(innerRequestId, parsed2.body) as FacetEnvelope<CommandResult>;
    }
    return parsed2.envelope as FacetEnvelope<CommandResult>;
  }
}

/**
 * Map a wire `command` to whether it counts as a mutation. The CLI
 * must set Content-Type for mutations; the service enforces the same
 * check on the other side via the shared `isMutationMethod` helper.
 */
function isMutationMethodFor(_command: CommandRequest["command"]): boolean {
  // The CLI only ever sends POST, so every wire command is a
  // mutation from the HTTP-method standpoint; the service's
  // mutation guard is always satisfied. This helper exists so the
  // CLI can express intent in one place and the security
  // classification stays single-sourced.
  void isMutationMethod;
  return true;
}

/**
 * Result of a successful publish. `artifactId` and `revisionSha` are
 * the canonical IDs every downstream verb (read-back, status, open)
 * carries. The `tier1Verdict` field is populated only when the
 * service was started with a Tier1Runner configured; otherwise it
 * is `null`.
 */
export interface PublishArtifactResult {
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly tier1Status: string | null;
  readonly tier1ScreenshotPath: string | null;
  readonly tier1ScreenshotError: ScreenshotError | null;
}

export interface PublishArtifactOptions {
  readonly artifactType: ArtifactType;
  readonly renderer?: Renderer;
  readonly bytes: ArrayBuffer;
  readonly slug?: string;
  readonly note?: string;
}

/**
 * Publish a new revision through an existing FacetClient. Resolves
 * the artifact (create-then-publish) and returns the canonical IDs.
 * Used by the acceptance test fixture helper, which needs to spawn
 * a service via the existing CLI infrastructure.
 */
export async function publishArtifact(
  client: FacetClient,
  options: PublishArtifactOptions,
): Promise<PublishArtifactResult> {
  const slug = options.slug ?? `acceptance-${crypto.randomUUID().slice(0, 8)}`;
  const createRes = await client.sendCommand({
    command: "create",
    requestId: generateRequestId(),
    projectId: "/facet",
    slug,
    title: slug,
  });
  if (!createRes.ok) {
    throw FacetError.from(createRes.error);
  }
  const parsed = CommandResultSchema.parse(createRes.data);
  if (parsed.command !== "create") {
    throw new FacetError("invalid_envelope", `expected create result, got ${parsed.command}`);
  }
  const artifactId = parsed.artifact.id;
  const base64 = btoa(String.fromCharCode(...new Uint8Array(options.bytes)));
  const publishRes = await client.sendCommand({
    command: "publish",
    requestId: generateRequestId(),
    artifactId,
    artifactType: options.artifactType,
    renderer: options.renderer ?? "svg",
    bytes: base64,
    ...(options.note !== undefined ? { note: options.note } : {}),
  });
  if (!publishRes.ok) {
    throw FacetError.from(publishRes.error);
  }
  const parsedPublish = CommandResultSchema.parse(publishRes.data);
  if (parsedPublish.command !== "publish") {
    throw new FacetError(
      "invalid_envelope",
      `expected publish result, got ${parsedPublish.command}`,
    );
  }
  // The dispatcher only embeds `tier1Verdict` on the wire response
  // when a Tier1Runner is configured; otherwise the field is null.
  const tier1Status = parsedPublish.tier1Verdict?.status ?? null;
  return {
    artifactId,
    revisionSha: parsedPublish.revision.sha256,
    tier1Status,
    tier1ScreenshotPath: parsedPublish.tier1Verdict?.screenshotPath ?? null,
    tier1ScreenshotError: parsedPublish.tier1Verdict?.screenshotError ?? null,
  };
}

export interface ReadBackOptions {
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly tier: 0 | 1 | "visual";
}

/**
 * Run `readBack` against an existing FacetClient and return the
 * typed verdict. The service normalizes "visual" → 1 internally.
 */
export async function readBack(
  client: FacetClient,
  options: ReadBackOptions,
): Promise<{
  readonly status: string;
  readonly tier: 0 | 1 | "visual";
  readonly renderer: Renderer;
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly insecure?: InsecureMarker;
  readonly screenshotError?: ScreenshotError;
  readonly observed: {
    readonly rendererRootSvgCount: number;
    readonly graphCount: number;
    readonly mermaidNodeCount: number;
    readonly visibleSvgCount: number;
    readonly opaqueRegionCount: number;
    readonly errorCount: number;
    readonly discriminativeErrors?: readonly { readonly code: string; readonly message: string }[];
  };
}> {
  const res = await client.sendCommand({
    command: "readBack",
    requestId: generateRequestId(),
    artifactId: options.artifactId,
    revisionSha: options.revisionSha,
    tier: options.tier,
  });
  if (!res.ok) {
    throw FacetError.from(res.error);
  }
  const parsed = CommandResultSchema.parse(res.data);
  if (parsed.command !== "readBack") {
    throw new FacetError("invalid_envelope", `expected readBack result, got ${parsed.command}`);
  }
  return {
    status: parsed.verdict.status,
    tier: parsed.verdict.tier,
    renderer: parsed.renderer,
    artifactId: parsed.verdict.artifactId,
    revisionSha: parsed.verdict.revisionSha,
    ...(parsed.verdict.insecure !== undefined ? { insecure: parsed.verdict.insecure } : {}),
    ...(parsed.verdict.screenshotError !== undefined
      ? { screenshotError: parsed.verdict.screenshotError }
      : {}),
    observed: {
      rendererRootSvgCount: parsed.verdict.observed.rendererRootSvgCount,
      graphCount: parsed.verdict.observed.graphCount,
      mermaidNodeCount: parsed.verdict.observed.mermaidNodeCount,
      visibleSvgCount: parsed.verdict.observed.visibleSvgCount,
      opaqueRegionCount: parsed.verdict.observed.opaqueRegionCount,
      errorCount: parsed.verdict.observed.errorCount,
      ...(parsed.verdict.observed.discriminativeErrors !== undefined
        ? { discriminativeErrors: parsed.verdict.observed.discriminativeErrors }
        : {}),
    },
  };
}
