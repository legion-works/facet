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
  checkExecutionSupported,
  checkRendererSupported,
  normalizeReadBackTier,
  type ArtifactEnvelope,
  type CommandRequest,
} from "../shared/contracts/commands";
import type { Artifact, ArtifactType, RenderRun, Revision } from "../shared/contracts/artifact";
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
  type Tier0WorkerResult,
  type Tier0Runner,
  type Tier1Input,
  type Tier1Result,
  type Tier1Runner,
  type InsecureLevel,
  type InsecureMarker,
  type TsxExecutionMode,
  type Verdict,
} from "../shared/contracts/validation";
import { FacetError } from "../shared/errors/facet-error";
import { SOURCE_CAP_BYTES, TIER1_PINNED_VERSION } from "../shared/config/limits";
import { computeLexicalExpectations } from "./lexical/expectations";
import { enrichVerdict, insecureMarker } from "./verdict-enrichment";
import { exportStoredRender, exportStoredSource } from "./export";
import { verdictFromStoredRun } from "./stored-verdict";

import type { GalleryLeaseManager } from "./security/leases";
import type { IdleController } from "./lifecycle/idle-controller";
import type { ArtifactRepository } from "./store/repository";
import { ensureRunEvidenceDirectory } from "./store/evidence-retention";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  /** Optional Tier 1 verifier, invoked only by explicit visual read-back. */
  readonly tier1Runner: Tier1Runner | undefined;
  /**
   * Write-path seam: called AFTER the revision is committed AND its
   * Tier 0 run is recorded, with the
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

function buildVerdict(input: {
  artifactId: string;
  revisionSha: string;
  tier: 0 | 1;
  status: string;
  observed: unknown;
  insecure?: InsecureMarker;
  screenshotError?: unknown;
  /**
   * Passed only when the artifact is a TSX revision (static or interactive).
   * Non-TSX verdicts carry NO
   * execution field — the field is absent, not null, so the wire
   * form for non-TSX stays byte-identical to the pre-arc shape.
   */
  execution?: TsxExecutionMode;
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
    ...(input.execution !== undefined ? { execution: input.execution } : {}),
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
        externalImageCount: 0,
        viewBoxes: [],
        errorCount: 1,
        discriminativeErrors: [{ code: facet.code, message: facet.message }],
      },
      ...(input.execution === undefined ? {} : { execution: input.execution }),
    });
  }
}

async function retainCompiledEvidence(
  repository: ArtifactRepository,
  artifactId: string,
  revisionSha: string,
  compiled: Tier0WorkerResult["compiled"],
): Promise<string | null> {
  if (compiled === undefined) return null;
  const bytes = Uint8Array.from(Buffer.from(compiled.bytesBase64, "base64"));
  const actualSha = new Bun.CryptoHasher("sha256");
  actualSha.update(bytes);
  const actualSha256 = actualSha.digest("hex");
  if (actualSha256 !== compiled.sha256) {
    throw new FacetError("tier0_protocol_error", "Compiled TSX bytes failed SHA-256 validation", {
      retryable: false,
      details: { expectedSha256: compiled.sha256, actualSha256 },
    });
  }
  const evidenceRoot = repository.getEvidenceRoot();
  if (evidenceRoot === undefined) return null;
  const runId = crypto.randomUUID();
  const evidence = ensureRunEvidenceDirectory({ evidenceRoot, artifactId, revisionSha, runId });
  const path = join(
    evidence.directory,
    compiled.mediaType === "text/html" ? "compiled.html" : "compiled.js",
  );
  await Bun.write(path, bytes);
  return path;
}

/**
 * Map a Tier 1 runner failure into a synthetic Tier1Result with
 * `status: "error"`. A failed launch is distinct from a rendered
 * verdict failure, so callers can tell an actionable environment fault
 * from an observed page defect.
 */
async function runTier1Safe(
  runner: Tier1Runner | undefined,
  input: Tier1Input,
  artifactId: string,
): Promise<Tier1Result> {
  try {
    if (runner === undefined) {
      throw new FacetError("tier1_unavailable", "Tier 1 runner is not configured", {
        retryable: false,
      });
    }
    return Tier1ResultSchema.parse(await runner(input));
  } catch (error) {
    return tier1Failure(input, artifactId, error);
  }
}

function tier1Failure(input: Tier1Input, artifactId: string, error: unknown): Tier1Result {
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
      externalImageCount: 0,
      viewBoxes: [],
      errorCount: 1,
      discriminativeErrors: [{ code: facet.code, message: facet.message }],
    },
    screenshotPath: null,
    consolePath: null,
  });
}

function tier1InputForRevision(
  revision: Revision,
  tier0Run: RenderRun,
  evidenceDir: string | undefined,
): Tier1Input {
  const compiledPath = tier0Run.compiledPath ?? null;
  const source =
    revision.artifactType === "tsx" && compiledPath !== null
      ? new Uint8Array(readFileSync(compiledPath))
      : new Uint8Array(revision.source);
  return Tier1InputSchema.parse({
    revisionSha: revision.sha256,
    artifactType: revision.artifactType,
    renderer: revision.renderer,
    source,
    lexical: JSON.parse(tier0Run.expectedJson),
    ...(revision.artifactType === "tsx" ? { execution: revision.execution ?? "static" } : {}),
    launcherVersion: TIER1_PINNED_VERSION,
    networkNamespace: "facet-tier1-egress-isolated",
    // Thread the canonical evidence root through to the Tier 1 runner so
    // its screenshot/console evidence lands in the SAME root the service
    // (and the parent CLI) agreed on — otherwise the runner falls back to
    // `computeFacetPaths().evidence` and re-introduces the XDG divergence.
    ...(evidenceDir !== undefined ? { evidenceDir } : {}),
  });
}

function recordTier1Run(
  deps: DispatcherDeps,
  revision: Revision,
  result: Tier1Result,
): Tier1Result {
  const execution = revision.artifactType === "tsx" ? (revision.execution ?? "static") : undefined;
  const enriched = Tier1ResultSchema.parse(
    enrichVerdict(
      result,
      revision.artifactId,
      revision.sha256,
      insecureMarker(deps.insecureLevel, deps.insecureReason),
      execution,
    ),
  );
  deps.repository.recordRenderRun({
    revisionId: revision.id,
    tier: 1,
    status: enriched.status,
    expected: enriched.expected,
    observed: enriched.observed,
    ...(enriched.screenshotPath !== null ? { screenshotPath: enriched.screenshotPath } : {}),
    ...(enriched.consolePath !== null ? { consolePath: enriched.consolePath } : {}),
    ...(enriched.screenshotError !== undefined
      ? { screenshotError: enriched.screenshotError }
      : {}),
    insecure: enriched.insecure ?? null,
  });
  return enriched;
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
      const executionError = checkExecutionSupported(command.artifactType, command.execution);
      if (executionError !== null) throw executionError;
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
      // D2: TSX execution mode is declared on the request and stored
      // on the revision row. Non-TSX artifacts carry 'static' on disk
      // (the canonical default) and the wire form simply omits the
      // field; TSX artifacts carry the declared value end-to-end.
      const executionMode = artifactType === "tsx" ? (command.execution ?? "static") : "static";
      if (deps.repository.getArtifactById(command.artifactId) === null) {
        throw new FacetError("artifact_not_found", "Artifact not found", {
          retryable: false,
          details: { artifactId: command.artifactId },
        });
      }
      const revision = deps.repository.publishRevision({
        artifactId: command.artifactId,
        artifactType,
        renderer: command.renderer,
        source: bytes,
        ...(command.note !== undefined ? { note: command.note } : {}),
        ...(command.parentRevisionId !== undefined
          ? { parentRevisionId: command.parentRevisionId }
          : {}),
        execution: executionMode,
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
      const legacyCounters =
        artifactType === "html"
          ? {
              rendererRootSvgCount: 0,
              mermaidNodeCount: 0,
              visibleSvgCount: 0,
              opaqueRegionCount: 0,
              externalImageCount: 0,
            }
          : {
              rendererRootSvgCount: lexical.expectedRendererRoots,
              mermaidNodeCount: lexical.mermaidNodeCount,
              visibleSvgCount: 0,
              opaqueRegionCount: lexical.expectedOpaqueRegions,
              externalImageCount: 0,
            };
      const tier0Input = Tier0InputSchema.parse({
        revisionSha: revision.sha256,
        artifactType,
        renderer: command.renderer,
        source: bytes,
        lexical: legacyCounters,
        ...(artifactType === "tsx" ? { execution: executionMode } : {}),
      });
      const insecure = insecureMarker(deps.insecureLevel, deps.insecureReason);
      // Execution is revision metadata for TSX only. Other types omit the
      // field rather than serializing null; TSX uses its declared mode.
      const verdictExecution: TsxExecutionMode | undefined =
        artifactType === "tsx" ? executionMode : undefined;
      if (deps.insecureLevel === 3) {
        const verdict = enrichVerdict(
          buildVerdict({
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
              externalImageCount: 0,
              errorCount: 0,
            },
            ...(verdictExecution !== undefined ? { execution: verdictExecution } : {}),
          }),
          command.artifactId,
          revision.sha256,
          insecure,
          verdictExecution,
        );
        deps.repository.recordRenderRun({
          revisionId: revision.id,
          tier: 0,
          status: verdict.status,
          expected: tier0Input.lexical,
          observed: verdict.observed,
          insecure: verdict.insecure ?? null,
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
      const compiledPath =
        artifactType === "tsx"
          ? await retainCompiledEvidence(
              deps.repository,
              command.artifactId,
              revision.sha256,
              tier0Result.compiled,
            )
          : null;
      // 3. Bind the verdict to (artifactId, revisionSha) via the
      // canonical render_run row so read-back returns it later.
      const enriched = Tier0ResultSchema.parse(
        enrichVerdict(tier0Result, command.artifactId, revision.sha256, insecure, verdictExecution),
      );
      deps.repository.recordRenderRun({
        revisionId: revision.id,
        tier: 0,
        status: enriched.status,
        expected: enriched.expected,
        observed: enriched.observed,
        insecure: enriched.insecure ?? null,
        ...(compiledPath === null ? {} : { compiledPath }),
      });
      // 4. Write-path SSE seam: the revision is committed and its Tier 0
      // verdict is recorded, so gallery streams bound to this
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
      return {
        command: "publish",
        requestId,
        revision: envelope,
        verdict: enriched,
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
      const revision =
        command.revisionSha === undefined
          ? deps.repository.getLatestRevision(command.artifactId)
          : deps.repository.getRevisionBySha(command.artifactId, command.revisionSha);
      if (revision === null) {
        throw new FacetError("revision_not_found", "Revision not found", {
          retryable: false,
          details: {
            artifactId: command.artifactId,
            ...(command.revisionSha === undefined ? {} : { revisionSha: command.revisionSha }),
          },
        });
      }
      const tier = normalizeReadBackTier(command.tier);
      let runs = deps.repository.listRenderRuns({ revisionId: revision.id, tier });
      if (tier === 1 && runs.length === 0) {
        const tier0Run = deps.repository.listRenderRuns({ revisionId: revision.id, tier: 0 })[0];
        if (tier0Run === undefined) {
          throw new FacetError("tier1_unavailable", "Tier 1 requires a Tier 0 render run", {
            retryable: false,
            details: { revisionId: revision.id },
          });
        }
        const tier1Input = tier1InputForRevision(
          revision,
          tier0Run,
          deps.repository.getEvidenceRoot(),
        );
        const tier1Result =
          revision.artifactType === "tsx" && tier0Run.compiledPath === null
            ? tier1Failure(
                tier1Input,
                revision.artifactId,
                new FacetError(
                  "tier1_unavailable",
                  "Tier 1 requires compiled TSX evidence from a successful Tier 0 run",
                  { retryable: false },
                ),
              )
            : await runTier1Safe(deps.tier1Runner, tier1Input, revision.artifactId);
        recordTier1Run(deps, revision, tier1Result);
        runs = deps.repository.listRenderRuns({ revisionId: revision.id, tier });
      }
      if (runs.length === 0) {
        throw new FacetError("revision_not_found", "No render runs recorded for revision", {
          retryable: false,
          details: { revisionId: revision.id, tier },
        });
      }
      // Single source of truth for cross-boundary verdict reconstruction:
      // `verdictFromStoredRun` handles the tolerant observed read,
      // the execution marker for TSX revisions, and the
      // insecure/screenshotError conditional-spreads. Re-deriving
      // any of these inline drifts; the export sidecar and the
      // gallery router use this helper, and the read-back route must
      // use it too.
      const verdict = verdictFromStoredRun(revision, runs[0]!);
      traceTier1Transport(`readback:build-complete status=${verdict.status}`);
      return { command: "readBack", requestId, renderer: revision.renderer, verdict };
    }
    case "status": {
      const counts =
        command.artifactId === undefined
          ? undefined
          : deps.repository.statusForArtifact({ artifactId: command.artifactId });
      const latestRevision =
        command.artifactId === undefined
          ? undefined
          : deps.repository.getLatestRevision(command.artifactId);
      return {
        command: "status",
        requestId,
        state: "active",
        ...(command.artifactId === undefined ? {} : { artifactId: command.artifactId }),
        ...(counts === undefined
          ? {}
          : {
              revisionCount: counts.revisionCount,
              pinnedCount: counts.pinnedCount,
              templateCount: counts.templateCount,
              ...(latestRevision === undefined || latestRevision === null
                ? {}
                : { latestRevisionSha: latestRevision.sha256 }),
            }),
        activeLeases: deps.leases.list().length,
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
        // Template instantiation preserves declared TSX mode. Non-TSX source
        // omits it and the publish path applies its existing default.
        ...(source.execution !== undefined ? { execution: source.execution } : {}),
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
      return command.format === "render"
        ? exportStoredRender({ repository: deps.repository, command, requestId })
        : exportStoredSource({ repository: deps.repository, command, requestId });
    }
    default: {
      const exhaustive: never = command;
      void exhaustive;
      throw new FacetError("invalid_request", "Unhandled command", { retryable: false });
    }
  }
}
