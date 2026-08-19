import type { Database } from "bun:sqlite";
import {
  ArtifactSchema,
  ArtifactTypeSchema,
  ProjectSchema,
  RenderRunSchema,
  RevisionSchema,
  TemplateSchema,
  type Artifact,
  type ArtifactType,
  type Renderer,
  type Project,
  type RenderRun,
  type Revision,
  type Template,
} from "../../shared/contracts/artifact";
import type {
  InsecureMarker,
  ScreenshotError,
  TsxExecutionMode,
} from "../../shared/contracts/validation";
import { DEFAULT_LIST_LIMIT } from "../../shared/config/limits";
import { now } from "../../shared/util/time";
import { asStoreError, FacetStoreError, hardenDatabaseFiles } from "./database";
import {
  evictRevisions,
  createTemplate as createLifecycleTemplate,
  pinRevision as pinLifecycleRevision,
  promoteRevision as promoteLifecycleRevision,
  type PromoteRevisionInput,
  type TemplateInput,
} from "./repository-lifecycle";
import { enforceEvidenceRetention, removeUnreferencedEvidence } from "./evidence-retention";

interface ProjectInput {
  readonly projectRoot: string;
}
interface ArtifactInput {
  readonly projectId: string;
  readonly slug: string;
  readonly title: string;
}
interface PublishInput {
  readonly artifactId: string;
  readonly artifactType: ArtifactType | "html";
  readonly renderer?: Renderer;
  readonly source: Uint8Array;
  readonly note?: string | null;
  readonly parentRevisionId?: string | null;
  /**
   * TSX execution mode (D2). Optional — defaults to `'static'` for
   * every artifact type on disk so non-TSX rows carry the canonical
   * value and the wire form simply omits it. Required to be `'static'`
   * when `artifactType !== 'tsx'`; the dispatcher guard ensures this
   * before the row is written. Derived from `TsxExecutionMode` so a
   * new mode lands in one place.
   */
  readonly execution?: TsxExecutionMode;
}

interface RenderRunInput {
  readonly revisionId: string;
  readonly tier: 0 | 1;
  readonly status: string;
  readonly expected: unknown;
  readonly observed: unknown;
  readonly screenshotPath?: string | null;
  readonly consolePath?: string | null;
  readonly screenshotError?: ScreenshotError | null;
  readonly insecure?: InsecureMarker | null;
  /**
   * TSX compiled-bundle evidence (D7). The bundle is derived output
   * stored alongside the run, not a wire form — `null` (the default)
   * for non-TSX runs and for TSX runs whose compilation did not
   * produce a retained file. Retention cleanup deletes the file
   * alongside its row.
   */
  readonly compiledPath?: string | null;
  /**
   * Retained-evidence carve-out: `true` exempts the row from the
   * last-N cleanup policy. Pin/template call sites set this; the
   * default false makes new runs eviction-eligible.
   */
  readonly retained?: boolean;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

interface WriteHookContext {
  readonly phase: "after_insert" | "before_commit";
}
interface RepositoryOptions {
  readonly onCommitted?: (revision: Revision) => void;
  readonly writeHook?: (context: WriteHookContext) => void;
  /**
   * Evidence root used by the last-N retention cleanup. When omitted,
   * retention is skipped (acceptable for in-process / unit tests that
   * never write evidence files).
   */
  readonly evidenceRoot?: string;
  /**
   * Legacy evidence root (pre explicit-threading child-derived root). Read
   * only — never written by retention. The export path consults it as a
   * tolerant fallback for old evidence.
   */
  readonly legacyEvidenceRoot?: string;
}

interface ListArtifactsInput {
  readonly projectId: string;
  readonly slugPrefix?: string;
  readonly limit?: number;
}

interface StatusForArtifactInput {
  readonly artifactId: string;
}

type SqlRevision = Omit<
  Revision,
  | "artifactId"
  | "revisionNumber"
  | "parentRevisionId"
  | "artifactType"
  | "createdAt"
  | "pinned"
  | "source"
  | "execution"
> & {
  artifact_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  artifact_type: string;
  renderer: string;
  source: Uint8Array | ArrayBuffer;
  note: string | null;
  pinned: number;
  created_at: string;
  execution: TsxExecutionMode;
};

function sha256(source: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(source);
  return hasher.digest("hex");
}

function parseArtifactType(value: ArtifactType): ArtifactType {
  try {
    return ArtifactTypeSchema.parse(value);
  } catch (error) {
    throw new FacetStoreError("invalid_artifact_type", "Unsupported artifact type", {
      cause: error,
    });
  }
}

function bytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

function revisionHasColumn(db: Database, name: string): boolean {
  const rows = db.query(`PRAGMA table_info(revisions)`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === name);
}

function renderRunHasColumn(db: Database, name: string): boolean {
  const rows = db.query(`PRAGMA table_info(render_runs)`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === name);
}

function mapRevision(row: SqlRevision): Revision {
  // TSX carries `execution` on the wire; every other type carries it
  // on disk but the wire form omits the field (the dispatch is
  // explicit: `execution` must be absent, not null, for non-TSX).
  return RevisionSchema.parse({
    id: row.id,
    artifactId: row.artifact_id,
    revisionNumber: row.revision_number,
    parentRevisionId: row.parent_revision_id,
    artifactType: row.artifact_type,
    renderer: row.renderer,
    source: bytes(row.source),
    sha256: row.sha256,
    note: row.note,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    ...(row.artifact_type === "tsx" ? { execution: row.execution } : {}),
  });
}

export class ArtifactRepository {
  constructor(
    private readonly db: Database,
    private readonly options: RepositoryOptions = {},
  ) {}

  getEvidenceRoot(): string | undefined {
    return this.options.evidenceRoot;
  }

  getLegacyEvidenceRoot(): string | undefined {
    return this.options.legacyEvidenceRoot;
  }

  createProject(input: ProjectInput): Project {
    const value = { id: crypto.randomUUID(), projectRoot: input.projectRoot, createdAt: now() };
    try {
      this.db
        .query("INSERT INTO projects(id, project_root, created_at) VALUES (?, ?, ?)")
        .run(value.id, value.projectRoot, value.createdAt);
      return ProjectSchema.parse(value);
    } catch (error) {
      throw asStoreError(error);
    }
  }

  getProjectById(id: string): Project | null {
    try {
      const row = this.db
        .query("SELECT id, project_root, created_at FROM projects WHERE id = ?")
        .get(id) as { id: string; project_root: string; created_at: string } | null;
      if (!row) return null;
      return ProjectSchema.parse({
        id: row.id,
        projectRoot: row.project_root,
        createdAt: row.created_at,
      });
    } catch (error) {
      throw asStoreError(error);
    }
  }

  /**
   * Look up by id, creating the project on demand. The first lookup
   * for a given id stamps it with the supplied root; subsequent lookups
   * return the existing row. The synthesized root `${root}-${id}` keeps
   * the `project_root` UNIQUE constraint satisfied while preserving
   * the caller-chosen id for stable addressing.
   */
  getOrCreateProjectById(id: string, projectRoot: string): Project {
    const existing = this.getProjectById(id);
    if (existing) return existing;
    const value = { id, projectRoot: `${projectRoot}-${id}`, createdAt: now() };
    try {
      this.db
        .query("INSERT INTO projects(id, project_root, created_at) VALUES (?, ?, ?)")
        .run(value.id, value.projectRoot, value.createdAt);
      return ProjectSchema.parse(value);
    } catch (error) {
      throw asStoreError(error);
    }
  }

  listArtifacts(input: ListArtifactsInput): Artifact[] {
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;
    const prefix = input.slugPrefix ?? "";
    try {
      const rows = this.db
        .query(
          "SELECT id, project_id, slug, title, created_at, updated_at FROM artifacts WHERE project_id = ? AND slug LIKE ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(input.projectId, `${prefix}%`, limit) as Array<{
        id: string;
        project_id: string;
        slug: string;
        title: string;
        created_at: string;
        updated_at: string;
      }>;
      return rows.map((row) =>
        ArtifactSchema.parse({
          id: row.id,
          projectId: row.project_id,
          slug: row.slug,
          title: row.title,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      );
    } catch (error) {
      throw asStoreError(error);
    }
  }

  getArtifactById(id: string): Artifact | null {
    try {
      const row = this.db
        .query(
          "SELECT id, project_id, slug, title, created_at, updated_at FROM artifacts WHERE id = ?",
        )
        .get(id) as {
        id: string;
        project_id: string;
        slug: string;
        title: string;
        created_at: string;
        updated_at: string;
      } | null;
      if (row === null) return null;
      return ArtifactSchema.parse({
        id: row.id,
        projectId: row.project_id,
        slug: row.slug,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    } catch (error) {
      throw asStoreError(error);
    }
  }

  listRenderRuns(input: { revisionId: string; tier: 0 | 1 }): RenderRun[] {
    const hasCompiledPath = renderRunHasColumn(this.db, "compiled_path");
    try {
      const selectSql = hasCompiledPath
        ? "SELECT id, revision_id, tier, status, expected_json, observed_json, screenshot_path, console_path, screenshot_error_json, insecure_json, retained, compiled_path, started_at, finished_at FROM render_runs WHERE revision_id = ? AND tier = ? ORDER BY finished_at DESC"
        : "SELECT id, revision_id, tier, status, expected_json, observed_json, screenshot_path, console_path, screenshot_error_json, insecure_json, retained, started_at, finished_at FROM render_runs WHERE revision_id = ? AND tier = ? ORDER BY finished_at DESC";
      const rows = this.db.query(selectSql).all(input.revisionId, input.tier) as Array<{
        id: string;
        revision_id: string;
        tier: number;
        status: string;
        expected_json: string;
        observed_json: string;
        screenshot_path: string | null;
        console_path: string | null;
        screenshot_error_json: string | null;
        insecure_json: string | null;
        retained: number;
        compiled_path?: string | null;
        started_at: string;
        finished_at: string;
      }>;
      return rows.map((row) =>
        RenderRunSchema.parse({
          id: row.id,
          revisionId: row.revision_id,
          tier: row.tier,
          status: row.status,
          expectedJson: row.expected_json,
          observedJson: row.observed_json,
          screenshotPath: row.screenshot_path,
          consolePath: row.console_path,
          screenshotErrorJson: row.screenshot_error_json,
          insecureJson: row.insecure_json,
          retained: row.retained === 1,
          compiledPath: hasCompiledPath ? (row.compiled_path ?? null) : null,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
        }),
      );
    } catch (error) {
      throw asStoreError(error);
    }
  }

  statusForArtifact(input: StatusForArtifactInput): {
    revisionCount: number;
    pinnedCount: number;
    templateCount: number;
  } {
    try {
      const revisionRow = this.db
        .query("SELECT COUNT(*) AS count FROM revisions WHERE artifact_id = ?")
        .get(input.artifactId) as { count: number };
      const pinnedRow = this.db
        .query("SELECT COUNT(*) AS count FROM revisions WHERE artifact_id = ? AND pinned = 1")
        .get(input.artifactId) as { count: number };
      const templateRow = this.db
        .query(
          "SELECT COUNT(*) AS count FROM templates t JOIN revisions r ON r.id = t.revision_id WHERE r.artifact_id = ?",
        )
        .get(input.artifactId) as { count: number };
      return {
        revisionCount: revisionRow.count,
        pinnedCount: pinnedRow.count,
        templateCount: templateRow.count,
      };
    } catch (error) {
      throw asStoreError(error);
    }
  }

  findTemplateByName(name: string): Template | null {
    try {
      const row = this.db
        .query(
          "SELECT id, artifact_id, revision_id, name, description, promoted_by, promoted_at FROM templates WHERE name = ? ORDER BY promoted_at DESC LIMIT 1",
        )
        .get(name) as {
        id: string;
        artifact_id: string;
        revision_id: string;
        name: string;
        description: string | null;
        promoted_by: string;
        promoted_at: string;
      } | null;
      if (!row) return null;
      return TemplateSchema.parse({
        id: row.id,
        artifactId: row.artifact_id,
        revisionId: row.revision_id,
        name: row.name,
        description: row.description,
        promotedBy: row.promoted_by,
        promotedAt: row.promoted_at,
      });
    } catch (error) {
      throw asStoreError(error);
    }
  }

  createArtifact(input: ArtifactInput): Artifact {
    const createdAt = now();
    const value = { id: crypto.randomUUID(), ...input, createdAt, updatedAt: createdAt };
    try {
      this.db
        .query(
          "INSERT INTO artifacts(id, project_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(value.id, value.projectId, value.slug, value.title, value.createdAt, value.updatedAt);
      return ArtifactSchema.parse(value);
    } catch (error) {
      throw asStoreError(error);
    }
  }

  publishRevision(input: PublishInput): Revision {
    parseArtifactType(input.artifactType);
    const source = new Uint8Array(input.source);
    const revisionId = crypto.randomUUID();
    const timestamp = now();
    const sha = sha256(source);
    // D2: every revision carries an execution mode on disk. Non-TSX
    // rows store `'static'` (the canonical default) and the wire
    // envelope omits the field; TSX rows carry the declared value
    // end-to-end.
    const execution = input.execution ?? "static";
    // The `execution` column lands in the v8 migration. Detect it
    // here so the v6-rollback test (which publishes against a v5
    // schema) keeps its semantics: the rollback assertion is about
    // the v6 transaction, not about whether the publish path itself
    // needed v8.
    const hasExecutionColumn = revisionHasColumn(this.db, "execution");
    try {
      const transact = this.db.transaction(() => {
        const previous = this.db
          .query(
            "SELECT id, revision_number FROM revisions WHERE artifact_id = ? ORDER BY revision_number DESC LIMIT 1",
          )
          .get(input.artifactId) as { id: string; revision_number: number } | null;
        const revisionNumber = (previous?.revision_number ?? 0) + 1;
        if (hasExecutionColumn) {
          this.db
            .query(
              "INSERT INTO revisions(id, artifact_id, revision_number, parent_revision_id, artifact_type, renderer, source, sha256, note, created_at, execution) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              revisionId,
              input.artifactId,
              revisionNumber,
              input.parentRevisionId === undefined
                ? (previous?.id ?? null)
                : input.parentRevisionId,
              input.artifactType,
              input.renderer ?? "svg",
              source,
              sha,
              input.note ?? null,
              timestamp,
              execution,
            );
        } else {
          this.db
            .query(
              "INSERT INTO revisions(id, artifact_id, revision_number, parent_revision_id, artifact_type, renderer, source, sha256, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              revisionId,
              input.artifactId,
              revisionNumber,
              input.parentRevisionId === undefined
                ? (previous?.id ?? null)
                : input.parentRevisionId,
              input.artifactType,
              input.renderer ?? "svg",
              source,
              sha,
              input.note ?? null,
              timestamp,
            );
        }
        const revision = RevisionSchema.parse({
          id: revisionId,
          artifactId: input.artifactId,
          revisionNumber,
          parentRevisionId:
            input.parentRevisionId === undefined ? (previous?.id ?? null) : input.parentRevisionId,
          artifactType: input.artifactType,
          renderer: input.renderer ?? "svg",
          source,
          sha256: sha,
          note: input.note ?? null,
          pinned: false,
          createdAt: timestamp,
          ...(input.artifactType === "tsx" && hasExecutionColumn ? { execution } : {}),
        });
        this.options.writeHook?.({ phase: "after_insert" });
        evictRevisions(this.db, input.artifactId, revisionId);

        this.options.writeHook?.({ phase: "before_commit" });
        return revision;
      });
      const revision = transact.immediate();
      hardenDatabaseFiles(this.db.filename);
      this.options.onCommitted?.(revision);
      return revision;
    } catch (error) {
      const mapped = asStoreError(error);
      if (mapped.code === "constraint" && mapped.message.toLowerCase().includes("unique")) {
        throw new FacetStoreError("duplicate_revision", mapped.message, { cause: error });
      }
      throw mapped;
    }
  }

  getRevisionBySha(artifactId: string, revisionSha: string): Revision | null {
    try {
      const row = this.db
        .query("SELECT * FROM revisions WHERE artifact_id = ? AND sha256 = ?")
        .get(artifactId, revisionSha) as SqlRevision | null;
      return row ? mapRevision(row) : null;
    } catch (error) {
      throw asStoreError(error);
    }
  }

  getLatestRevision(artifactId: string): Revision | null {
    try {
      const row = this.db
        .query(
          "SELECT * FROM revisions WHERE artifact_id = ? ORDER BY revision_number DESC LIMIT 1",
        )
        .get(artifactId) as SqlRevision | null;
      return row === null ? null : mapRevision(row);
    } catch (error) {
      throw asStoreError(error);
    }
  }

  getRevisionById(revisionId: string): Revision | null {
    try {
      const row = this.db
        .query("SELECT * FROM revisions WHERE id = ?")
        .get(revisionId) as SqlRevision | null;
      return row ? mapRevision(row) : null;
    } catch (error) {
      throw asStoreError(error);
    }
  }

  recordRenderRun(input: RenderRunInput): RenderRun {
    const startedAt = input.startedAt ?? now();
    const finishedAt = input.finishedAt ?? now();
    const retained = input.retained ?? false;
    const compiledPath = input.compiledPath ?? null;
    // The `compiled_path` column lands in the v8 migration. Detect it
    // so the v6-rollback test (which records runs against a v5
    // schema) keeps its semantics: the rollback assertion is about
    // the v6 transaction, not about whether the record path itself
    // needed v8.
    const hasCompiledPath = renderRunHasColumn(this.db, "compiled_path");
    const value: {
      id: string;
      revisionId: string;
      tier: 0 | 1;
      status: string;
      expectedJson: string;
      observedJson: string;
      screenshotPath: string | null;
      consolePath: string | null;
      screenshotErrorJson: string | null;
      insecureJson: string | null;
      retained: boolean;
      compiledPath?: string | null;
      startedAt: string;
      finishedAt: string;
    } = {
      id: crypto.randomUUID(),
      revisionId: input.revisionId,
      tier: input.tier,
      status: input.status,
      expectedJson: JSON.stringify(input.expected),
      observedJson: JSON.stringify(input.observed),
      screenshotPath: input.screenshotPath ?? null,
      consolePath: input.consolePath ?? null,
      screenshotErrorJson:
        input.screenshotError === null || input.screenshotError === undefined
          ? null
          : JSON.stringify(input.screenshotError),
      insecureJson:
        input.insecure === null || input.insecure === undefined
          ? null
          : JSON.stringify(input.insecure),
      retained,
      startedAt,
      finishedAt,
    };
    if (hasCompiledPath) value.compiledPath = compiledPath;
    const compiledColumnValue: string | null = hasCompiledPath
      ? (value.compiledPath ?? null)
      : null;
    let artifactIdForCleanup: string | null = null;
    try {
      // Validate BEFORE the INSERT, not after: `render_runs` has no unique
      // schema-shape constraint SQLite would reject on its own (e.g. an
      // empty `status`), so a post-insert `RenderRunSchema.parse` failure
      // used to land in this same catch AFTER the row was already durable
      // — unlinking evidence files a committed row still pointed at.
      // Validating first means a schema-invalid input never reaches the
      // INSERT, so the catch's cleanup-on-failure is only ever reached
      // when no row was written.
      const parsed = RenderRunSchema.parse(value);
      if (hasCompiledPath) {
        this.db
          .query(
            "INSERT INTO render_runs(id, revision_id, tier, status, expected_json, observed_json, screenshot_path, console_path, screenshot_error_json, insecure_json, retained, compiled_path, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            value.id,
            value.revisionId,
            value.tier,
            value.status,
            value.expectedJson,
            value.observedJson,
            value.screenshotPath,
            value.consolePath,
            value.screenshotErrorJson,
            value.insecureJson,
            value.retained ? 1 : 0,
            compiledColumnValue,
            value.startedAt,
            value.finishedAt,
          );
      } else {
        this.db
          .query(
            "INSERT INTO render_runs(id, revision_id, tier, status, expected_json, observed_json, screenshot_path, console_path, screenshot_error_json, insecure_json, retained, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            value.id,
            value.revisionId,
            value.tier,
            value.status,
            value.expectedJson,
            value.observedJson,
            value.screenshotPath,
            value.consolePath,
            value.screenshotErrorJson,
            value.insecureJson,
            value.retained ? 1 : 0,
            value.startedAt,
            value.finishedAt,
          );
      }
      const ownerRow = this.db
        .query("SELECT artifact_id FROM revisions WHERE id = ?")
        .get(input.revisionId) as { artifact_id: string } | null;
      if (ownerRow !== null) artifactIdForCleanup = ownerRow.artifact_id;
      // Last-N retention runs AFTER the row is durable; a failure
      // here would lose the just-recorded run, so it sits outside the
      // INSERT transaction. Cleanup is best-effort — the row is
      // authoritative, a stale on-disk file is recoverable.
      if (artifactIdForCleanup !== null && this.options.evidenceRoot !== undefined) {
        try {
          enforceEvidenceRetention({
            db: this.db,
            artifactId: artifactIdForCleanup,
            evidenceRoot: this.options.evidenceRoot,
          });
        } catch {
          // Retention cleanup is best-effort; do not fail the write.
        }
      }
      hardenDatabaseFiles(this.db.filename);
      return parsed;
    } catch (error) {
      removeUnreferencedEvidence(this.db, [input.screenshotPath, input.consolePath, compiledPath]);
      throw asStoreError(error);
    }
  }

  promoteRevision(input: PromoteRevisionInput): Template {
    return promoteLifecycleRevision(this.db, input);
  }

  instantiateTemplate(input: TemplateInput): Template {
    return createLifecycleTemplate(this.db, input);
  }

  pinRevision(revisionId: string, pinned = true): void {
    pinLifecycleRevision(this.db, revisionId, pinned);
  }

  updateRevisionSource(_revisionId: string, _source: Uint8Array): never {
    throw new FacetStoreError("immutable_revision", "Revision source and sha256 are immutable");
  }
}
