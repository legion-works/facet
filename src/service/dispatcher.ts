/**
 * Command dispatcher.
 *
 * Pure handler: maps a parsed-and-validated `CommandRequest` to its
 * repository call, returning the result body that the envelope wrapper
 * will hand back to the caller. The dispatcher never touches HTTP
 * concerns (headers, status codes) — those live in router.ts.
 *
 * Errors are surfaced as `FacetError` so the router's envelope helper
 * can map them to the typed error response.
 */

import {
  checkArtifactTypeSupported,
  checkRendererSupported,
  normalizeReadBackTier,
  type ArtifactEnvelope,
  type CommandRequest,
} from "../shared/contracts/commands";
import type { Artifact, ArtifactType } from "../shared/contracts/artifact";
import { ArtifactTypeSchema } from "../shared/contracts/artifact";
import { RevisionCommittedEventSchema } from "../shared/contracts/events";
import {
  Tier0InputSchema,
  Tier0ResultSchema,
  Tier0WorkerResultSchema,
  Tier1InputSchema,
  Tier1ResultSchema,
  VerdictObservedSchema,
  VerdictSchema,
  type Tier0Input,
  type Tier0Result,
  type Tier0WorkerResult,
  type Tier0Runner,
  type Tier1Input,
  type Tier1Result,
  type Tier1Runner,
  type InsecureLevel,
  type InsecureMarker,
  type Verdict,
} from "../shared/contracts/validation";
import { FacetError } from "../shared/errors/facet-error";
import { SOURCE_CAP_BYTES, TIER1_PINNED_VERSION } from "../shared/config/limits";
import { computeLexicalExpectations } from "./lexical/expectations";

import type { GalleryLeaseManager } from "./security/leases";
import type { IdleController } from "./lifecycle/idle-controller";
import type { ArtifactRepository } from "./store/repository";

const TIER1_TRACE = process.env.FACET_TIER1_TRACE === "1";

function traceTier1Transport(stage: string): void {
  if (!TIER1_TRACE) return;
  process.stderr.write(`[tier1-transport] ${stage}\n`);
}

/**
 * Tier 0 runner contract lives in `shared/contracts/validation.ts` so
 * the service can depend on it as a TYPE without importing the
 * implementation in `src/validation/`. The default runner is built by
 * callers (`src/cli/`, integration tests) and injected; this keeps the
 * service byte-dumb AND the boundary checker clean.
 */

export interface DispatcherDeps {
  readonly insecureLevel: InsecureLevel;
  readonly insecureReason: string | null;
  readonly repository: ArtifactRepository;
  readonly leases: GalleryLeaseManager;
  readonly idle: IdleController;
  readonly tier0Runner: Tier0Runner;
  /**
   * Optional Tier 1 verifier. When present, publish records BOTH a
   * Tier 0 and a Tier 1 render_run; read-back of tier 1 returns the
   * Tier 1 verdict. When absent, tier 1 is never recorded and
   * read-back of tier 1 surfaces `revision_not_found`.
   */
  readonly tier1Runner: Tier1Runner | undefined;
  /**
   * Write-path seam: called AFTER the revision is committed AND its
   * Tier 0 (and configured Tier 1) runs are recorded, with the
   * canonical `revision:committed` event. The server wires this to
   * the SSE broadcaster so gallery leases see the revision land.
   */
  readonly onPublished?: (event: {
    readonly type: "revision:committed";
    readonly artifactId: string;
    readonly revisionSha: string;
    readonly revisionNumber: number;
    readonly artifactType: ArtifactType;
    readonly at: string;
  }) => void;
}

function mapArtifact(a: Artifact): ArtifactEnvelope {
  return {
    id: a.id,
    projectId: a.projectId,
    slug: a.slug,
    title: a.title,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function insecureMarker(
  deps: Pick<DispatcherDeps, "insecureLevel" | "insecureReason">,
): InsecureMarker | undefined {
  if (deps.insecureLevel === 0) return undefined;
  return {
    level: deps.insecureLevel,
    reason: deps.insecureReason ?? `manual insecure level ${deps.insecureLevel}`,
  };
}

function buildVerdict(input: {
  artifactId: string;
  revisionSha: string;
  tier: 0 | 1;
  status: string;
  observed: unknown;
  insecure?: InsecureMarker;
  screenshotError?: unknown;
}): Verdict {
  const observed = VerdictObservedSchema.parse(input.observed);
  return VerdictSchema.parse({
    status: input.status,
    tier: input.tier,
    artifactId: input.artifactId,
    revisionSha: input.revisionSha,
    observed,
    ...(input.insecure !== undefined ? { insecure: input.insecure } : {}),
    ...(input.screenshotError !== undefined ? { screenshotError: input.screenshotError } : {}),
  });
}

/**
 * Run the Tier 0 worker, mapping a thrown `FacetError` to a synthetic
 * Tier0Result with `status: "error"`. The wire response must still be
 * a publish envelope (the revision IS committed), so the run is
 * recorded as an error-tier observation rather than as a publish
 * failure. The original error code is surfaced via
 * `discriminativeErrors[].code` so the read-back verdict carries the
 * typed reason.
 */
async function runTier0Safe(runner: Tier0Runner, input: Tier0Input): Promise<Tier0WorkerResult> {
  try {
    return await runner(input);
  } catch (error) {
    const facet = FacetError.from(error);
    return Tier0WorkerResultSchema.parse({
      tier: 0,
      status: "error",
      revisionSha: input.revisionSha,
      expected: input.lexical,
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        viewBoxes: [],
        errorCount: 1,
        discriminativeErrors: [{ code: facet.code, message: facet.message }],
      },
    });
  }
}

/**
 * Pin the verdict to the (artifactId, revisionSha) pair the parent
 * service is committing. The worker doesn't know the artifactId (it
 * runs out of process and only needs the sha); we fill it in here so
 * every Tier 0 verdict carries the canonical binding.
 */
function enrichVerdict(
  result: Tier0WorkerResult,
  artifactId: string,
  revisionSha: string,
  insecure?: InsecureMarker,
): Tier0Result {
  return Tier0ResultSchema.parse({
    ...result,
    ...(insecure !== undefined ? { insecure } : {}),
    artifactId,
    revisionSha,
  });
}

/**
 * Map a Tier 1 runner failure into a synthetic Tier1Result with
 * `status: "error"`. The publish path ALWAYS records a tier 1 run
 * when a Tier1Runner is configured; a thrown FacetError here means
 * the verifier could not even obtain a verdict, so the run row
 * carries the typed code via `discriminativeErrors[].code`.
 */
async function runTier1Safe(
  runner: Tier1Runner,
  input: Tier1Input,
  artifactId: string,
): Promise<Tier1Result> {
  try {
    return await runner(input);
  } catch (error) {
    const facet = FacetError.from(error);
    return Tier1ResultSchema.parse({
      tier: 1,
      status: "error",
      artifactId,
      revisionSha: input.revisionSha,
      expected: input.lexical,
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        viewBoxes: [],
        errorCount: 1,
        discriminativeErrors: [{ code: facet.code, message: facet.message }],
      },
      screenshotPath: null,
      consolePath: null,
    });
  }
}

function enrichTier1Verdict(
  result: Tier1Result,
  artifactId: string,
  revisionSha: string,
  insecure?: InsecureMarker,
): Tier1Result {
  return Tier1ResultSchema.parse({
    ...result,
    ...(insecure !== undefined ? { insecure } : {}),
    artifactId,
    revisionSha,
  });
}

export async function dispatch(
  deps: DispatcherDeps,
  command: CommandRequest,
  requestId: string,
): Promise<unknown> {
  switch (command.command) {
    case "create": {
      const project = deps.repository.getOrCreateProjectById(command.projectId, "/facet");
      const artifact = deps.repository.createArtifact({
        projectId: project.id,
        slug: command.slug,
        title: command.title,
      });
      return { command: "create", requestId, artifact: mapArtifact(artifact) };
    }
    case "publish": {
      const unsupported = checkArtifactTypeSupported(command.artifactType);
      if (unsupported !== null) throw unsupported;
      const rendererError = checkRendererSupported(command.artifactType, command.renderer);
      if (rendererError !== null) throw rendererError;
      // The reserved-type gate above rejected `html`; re-parse so the
      // rest of the publish path holds the narrowed supported type.
      const artifactType: ArtifactType = ArtifactTypeSchema.parse(command.artifactType);
      // Decode the base64 string into a Uint8Array. The schema validates
      // base64 syntax; here we enforce the SOURCE_CAP_BYTES on the
      // decoded length BEFORE any further work, throwing a typed
      // payload_too_large so the wire response is 413 (not 400).
      const bytes = Uint8Array.from(Buffer.from(command.bytes, "base64"));
      if (bytes.byteLength > SOURCE_CAP_BYTES) {
        throw new FacetError("payload_too_large", "Publish bytes exceed SOURCE_CAP_BYTES", {
          retryable: false,
          details: { sizeBytes: bytes.byteLength, capBytes: SOURCE_CAP_BYTES },
        });
      }
      // 1. Persist the IMMUTABLE revision first. The bytes-on-disk +
      // sha256 + revision row are the source of truth; Tier 0 is an
      // observation over those bytes, not a gate.
      const revision = deps.repository.publishRevision({
        artifactId: command.artifactId,
        artifactType,
        renderer: command.renderer,
        source: bytes,
        ...(command.note !== undefined ? { note: command.note } : {}),
        ...(command.parentRevisionId !== undefined
          ? { parentRevisionId: command.parentRevisionId }
          : {}),
      });
      // 2. Run Tier 0 over the SAME immutable bytes — never re-decode
      // from the wire or substitute. The runner lives in
      // src/validation (netns'd subprocess); only its contract type
      // is visible to the service. A thrown FacetError here (unshare
      // unavailable, worker died, protocol error, …) aborts the
      // publish AFTER the revision is committed; we still record the
      // partial run so the wire response can carry a verdict-shaped
      // body. A non-ok Tier0Result is normal: the parser rejected the
      // artifact and we persist that decision as a render_run.
      const lexical = computeLexicalExpectations(bytes, artifactType, command.renderer);
      const tier0Input = Tier0InputSchema.parse({
        revisionSha: revision.sha256,
        artifactType,
        renderer: command.renderer,
        source: bytes,
        lexical: {
          rendererRootSvgCount: lexical.expectedRendererRoots,
          mermaidNodeCount: lexical.mermaidNodeCount,
          visibleSvgCount: 0,
          opaqueRegionCount: lexical.expectedOpaqueRegions,
        },
      });
      const insecure = insecureMarker(deps);
      if (deps.insecureLevel === 3) {
        const verdict = buildVerdict({
          artifactId: command.artifactId,
          revisionSha: revision.sha256,
          tier: 0,
          status: "insecure:unvalidated",
          observed: {
            rendererRootSvgCount: 0,
            graphCount: 0,
            mermaidNodeCount: 0,
            visibleSvgCount: 0,
            opaqueRegionCount: 0,
            errorCount: 0,
          },
          ...(insecure !== undefined ? { insecure } : {}),
        });
        deps.repository.recordRenderRun({
          revisionId: revision.id,
          tier: 0,
          status: verdict.status,
          expected: tier0Input.lexical,
          observed: verdict.observed,
        });
        deps.onPublished?.(
          RevisionCommittedEventSchema.parse({
            type: "revision:committed",
            artifactId: command.artifactId,
            revisionSha: revision.sha256,
            revisionNumber: revision.revisionNumber,
            artifactType,
            at: new Date().toISOString(),
          }),
        );
        const { source: _source, ...envelope } = revision;
        void _source;
        return {
          command: "publish",
          requestId,
          revision: envelope,
          verdict,
        };
      }
      const tier0Result = await runTier0Safe(deps.tier0Runner, tier0Input);
      // 3. Bind the verdict to (artifactId, revisionSha) via the
      // canonical render_run row so read-back returns it later.
      const enriched = enrichVerdict(tier0Result, command.artifactId, revision.sha256, insecure);
      deps.repository.recordRenderRun({
        revisionId: revision.id,
        tier: 0,
        status: enriched.status,
        expected: enriched.expected,
        observed: enriched.observed,
      });
      // 4. Tier 1 (optional). When configured, run the headless-shell
      // verifier over the SAME bytes and record a separate render_run.
      // Acceptance tests gate on the Tier 1 verdict (forgery +
      // layout); integration tests skip this branch entirely because
      // they inject no Tier1Runner.
      let tier1Verdict: Tier1Result | null = null;
      if (deps.tier1Runner !== undefined) {
        const tier1Input: Tier1Input = Tier1InputSchema.parse({
          ...tier0Input,
          launcherVersion: TIER1_PINNED_VERSION,
          networkNamespace: "facet-tier1-egress-isolated",
        });
        const tier1Result = await runTier1Safe(deps.tier1Runner, tier1Input, command.artifactId);
        traceTier1Transport(`publish:tier1-return status=${tier1Result.status}`);
        const enrichedTier1 = enrichTier1Verdict(
          tier1Result,
          command.artifactId,
          revision.sha256,
          insecure,
        );
        traceTier1Transport("publish:tier1-record:start");
        deps.repository.recordRenderRun({
          revisionId: revision.id,
          tier: 1,
          status: enrichedTier1.status,
          expected: enrichedTier1.expected,
          observed: enrichedTier1.observed,
          ...(enrichedTier1.screenshotPath !== null
            ? { screenshotPath: enrichedTier1.screenshotPath }
            : {}),
          ...(enrichedTier1.consolePath !== null ? { consolePath: enrichedTier1.consolePath } : {}),
          ...(enrichedTier1.screenshotError !== undefined
            ? { screenshotError: enrichedTier1.screenshotError }
            : {}),
        });
        traceTier1Transport("publish:tier1-record:complete");
        tier1Verdict = enrichedTier1;
      }
      // 5. Write-path SSE seam: the revision is committed and its
      // verdict runs are recorded, so gallery streams bound to this
      // artifact may now learn the exact revision to fetch + swap to.
      deps.onPublished?.(
        RevisionCommittedEventSchema.parse({
          type: "revision:committed",
          artifactId: command.artifactId,
          revisionSha: revision.sha256,
          revisionNumber: revision.revisionNumber,
          artifactType,
          at: new Date().toISOString(),
        }),
      );
      const { source: _source, ...envelope } = revision;
      void _source;
      traceTier1Transport("publish:return:before");
      return {
        command: "publish",
        requestId,
        revision: envelope,
        ...(insecure !== undefined ? { verdict: enriched } : {}),
        ...(tier1Verdict !== null ? { tier1Verdict } : {}),
      };
    }
    case "list": {
      const project = deps.repository.getOrCreateProjectById(command.projectId, "/facet");
      const artifacts = deps.repository.listArtifacts({
        projectId: project.id,
        ...(command.slugPrefix !== undefined ? { slugPrefix: command.slugPrefix } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
      });
      return {
        command: "list",
        requestId,
        artifacts: artifacts.map(mapArtifact),
        nextCursor: null,
      };
    }
    case "readBack": {
      const revision = deps.repository.getRevisionBySha(command.artifactId, command.revisionSha);
      if (revision === null) {
        throw new FacetError("revision_not_found", "Revision not found", {
          retryable: false,
          details: { artifactId: command.artifactId, revisionSha: command.revisionSha },
        });
      }
      const tier = normalizeReadBackTier(command.tier);
      const runs = deps.repository.listRenderRuns({ revisionId: revision.id, tier });
      if (runs.length === 0) {
        throw new FacetError("revision_not_found", "No render runs recorded for revision", {
          retryable: false,
          details: { revisionId: revision.id, tier },
        });
      }
      const observedJson = JSON.parse(runs[0]!.observedJson);
      const insecure = insecureMarker(deps);
      const verdict = buildVerdict({
        artifactId: command.artifactId,
        revisionSha: command.revisionSha,
        tier,
        status: runs[0]!.status,
        observed: observedJson,
        ...(insecure !== undefined ? { insecure } : {}),
        ...(runs[0]!.screenshotErrorJson !== null
          ? { screenshotError: JSON.parse(runs[0]!.screenshotErrorJson) }
          : {}),
      });
      traceTier1Transport(`readback:build-complete status=${verdict.status}`);
      return { command: "readBack", requestId, renderer: revision.renderer, verdict };
    }
    case "status": {
      const counts = deps.repository.statusForArtifact({ artifactId: command.artifactId });
      return {
        command: "status",
        requestId,
        artifactId: command.artifactId,
        revisionCount: counts.revisionCount,
        pinnedCount: counts.pinnedCount,
        templateCount: counts.templateCount,
      };
    }
    case "open": {
      const revision = deps.repository.getRevisionBySha(command.artifactId, command.revisionSha);
      if (revision === null) {
        throw new FacetError("revision_not_found", "Revision not found", {
          retryable: false,
          details: { artifactId: command.artifactId, revisionSha: command.revisionSha },
        });
      }
      const lease = deps.leases.issue({ artifactId: command.artifactId, pid: process.pid });
      deps.idle.acquire(`lease:${lease.leaseId}`);
      // The lease id is NOT embedded in the frameUrl — clients carry
      // it out-of-band (header / cache) so a URL log line, referrer,
      // or browser history cannot leak the lease. The frameUrl only
      // identifies the artifact + revision; the SSE route takes the
      // lease id via `X-Gallery-Lease` header.
      const frameUrl = `facet://frame/${command.artifactId}/${command.revisionSha}`;
      return {
        command: "open",
        requestId,
        artifactId: command.artifactId,
        revisionSha: command.revisionSha,
        frameUrl,
        lease: {
          leaseId: lease.leaseId,
          expiresAt: lease.expiresAt,
        },
      };
    }
    case "promote": {
      const template = deps.repository.promoteRevision({
        ...(command.artifactId !== undefined ? { artifactId: command.artifactId } : {}),
        revisionId: command.revisionId,
        name: command.name,
        promotedBy: command.promotedBy,
        ...(command.description !== undefined ? { description: command.description } : {}),
      });
      return { command: "promote", requestId, template };
    }
    case "instantiate": {
      const template = deps.repository.findTemplateByName(command.name);
      if (template === null) {
        throw new FacetError("template_not_found", "Template not found", {
          retryable: false,
          details: { name: command.name },
        });
      }
      const project = deps.repository.getOrCreateProjectById(
        command.projectId ?? template.artifactId,
        "/facet",
      );
      const artifact = deps.repository.createArtifact({
        projectId: project.id,
        slug: command.newSlug,
        title: template.name,
      });
      const source = deps.repository.getRevisionById(template.revisionId);
      if (source === null) {
        throw new FacetError("revision_not_found", "Template revision not found", {
          retryable: false,
          details: { revisionId: template.revisionId },
        });
      }
      deps.repository.publishRevision({
        artifactId: artifact.id,
        artifactType: source.artifactType,
        renderer: source.renderer,
        source: new Uint8Array(source.source),
        note: `Instantiated from template ${template.name}`,
      });
      return {
        command: "instantiate",
        requestId,
        artifact: mapArtifact(artifact),
        template,
      };
    }
    case "pin": {
      const revision = deps.repository.getRevisionById(command.revisionId);
      if (revision === null) {
        throw new FacetError("revision_not_found", "Revision not found", {
          retryable: false,
          details: { revisionId: command.revisionId },
        });
      }
      deps.repository.pinRevision(command.revisionId, command.pinned);
      return {
        command: "pin",
        requestId,
        revisionId: command.revisionId,
        pinned: command.pinned,
      };
    }
    case "export": {
      // Handled at the router's reserved-verb guard — never reached here.
      throw new FacetError("reserved_not_implemented", "export reserved", { retryable: false });
    }
    default: {
      const exhaustive: never = command;
      void exhaustive;
      throw new FacetError("invalid_request", "Unhandled command", { retryable: false });
    }
  }
}
