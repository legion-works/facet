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
  type Project,
  type RenderRun,
  type Revision,
  type Template,
} from "../../shared/contracts/artifact";
import { asStoreError, FacetStoreError } from "./database";

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
  readonly source: Uint8Array;
  readonly note?: string;
  readonly parentRevisionId?: string | null;
}

interface RenderRunInput {
  readonly revisionId: string;
  readonly tier: 0 | 1;
  readonly status: string;
  readonly expected: unknown;
  readonly observed: unknown;
  readonly screenshotPath?: string | null;
  readonly consolePath?: string | null;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}
interface TemplateInput {
  readonly artifactId: string;
  readonly revisionId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly promotedBy: string;
  readonly promotedAt?: string;
}
interface WriteHookContext {
  readonly phase: "after_insert" | "before_commit";
}
interface RepositoryOptions {
  readonly onCommitted?: (revision: Revision) => void;
  readonly writeHook?: (context: WriteHookContext) => void;
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
> & {
  artifact_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  artifact_type: string;
  source: Uint8Array | ArrayBuffer;
  note: string | null;
  pinned: number;
  created_at: string;
};

function now(): string {
  return new Date().toISOString();
}

function sha256(source: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(source);
  return hasher.digest("hex");
}

function parseArtifactType(value: ArtifactType | "html"): ArtifactType {
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

function mapRevision(row: SqlRevision): Revision {
  return RevisionSchema.parse({
    id: row.id,
    artifactId: row.artifact_id,
    revisionNumber: row.revision_number,
    parentRevisionId: row.parent_revision_id,
    artifactType: row.artifact_type,
    source: bytes(row.source),
    sha256: row.sha256,
    note: row.note,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
  });
}

export class ArtifactRepository {
  constructor(
    private readonly db: Database,
    private readonly options: RepositoryOptions = {},
  ) {}

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
    try {
      const transact = this.db.transaction(() => {
        const previous = this.db
          .query(
            "SELECT id, revision_number FROM revisions WHERE artifact_id = ? ORDER BY revision_number DESC LIMIT 1",
          )
          .get(input.artifactId) as { id: string; revision_number: number } | null;
        const revisionNumber = (previous?.revision_number ?? 0) + 1;
        this.db
          .query(
            "INSERT INTO revisions(id, artifact_id, revision_number, parent_revision_id, artifact_type, source, sha256, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            revisionId,
            input.artifactId,
            revisionNumber,
            input.parentRevisionId === undefined ? (previous?.id ?? null) : input.parentRevisionId,
            input.artifactType,
            source,
            sha,
            input.note ?? null,
            timestamp,
          );
        const revision = RevisionSchema.parse({
          id: revisionId,
          artifactId: input.artifactId,
          revisionNumber,
          parentRevisionId:
            input.parentRevisionId === undefined ? (previous?.id ?? null) : input.parentRevisionId,
          artifactType: input.artifactType,
          source,
          sha256: sha,
          note: input.note ?? null,
          pinned: false,
          createdAt: timestamp,
        });
        this.options.writeHook?.({ phase: "after_insert" });
        this.evict(input.artifactId);
        this.options.onCommitted?.(revision);
        this.options.writeHook?.({ phase: "before_commit" });
        return revision;
      });
      return transact.immediate();
    } catch (error) {
      const mapped = asStoreError(error);
      if (mapped.code === "constraint" && mapped.message.toLowerCase().includes("unique")) {
        throw new FacetStoreError("duplicate_revision", mapped.message, { cause: error });
      }
      throw mapped;
    }
  }

  private evict(artifactId: string): void {
    while (true) {
      const count = this.db
        .query("SELECT COUNT(*) AS count FROM revisions WHERE artifact_id = ?")
        .get(artifactId) as { count: number };
      if (count.count <= 50) return;
      const candidate = this.db
        .query(
          "SELECT id FROM revisions WHERE artifact_id = ? AND pinned = 0 AND NOT EXISTS (SELECT 1 FROM templates WHERE templates.revision_id = revisions.id) ORDER BY revision_number ASC LIMIT 1",
        )
        .get(artifactId) as { id: string } | null;
      if (!candidate) return;
      this.db
        .query("UPDATE revisions SET parent_revision_id = NULL WHERE parent_revision_id = ?")
        .run(candidate.id);
      this.db.query("DELETE FROM revisions WHERE id = ?").run(candidate.id);
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

  recordRenderRun(input: RenderRunInput): RenderRun {
    const startedAt = input.startedAt ?? now();
    const finishedAt = input.finishedAt ?? now();
    const value = {
      id: crypto.randomUUID(),
      revisionId: input.revisionId,
      tier: input.tier,
      status: input.status,
      expectedJson: JSON.stringify(input.expected),
      observedJson: JSON.stringify(input.observed),
      screenshotPath: input.screenshotPath ?? null,
      consolePath: input.consolePath ?? null,
      startedAt,
      finishedAt,
    };
    try {
      this.db
        .query(
          "INSERT INTO render_runs(id, revision_id, tier, status, expected_json, observed_json, screenshot_path, console_path, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          value.startedAt,
          value.finishedAt,
        );
      return RenderRunSchema.parse(value);
    } catch (error) {
      throw asStoreError(error);
    }
  }

  promoteRevision(input: Omit<TemplateInput, "artifactId"> & { artifactId?: string }): Template {
    const artifactId =
      input.artifactId ??
      (
        this.db.query("SELECT artifact_id FROM revisions WHERE id = ?").get(input.revisionId) as {
          artifact_id: string;
        } | null
      )?.artifact_id;
    if (!artifactId)
      throw new FacetStoreError("foreign_key", `Revision not found: ${input.revisionId}`);
    return this.instantiateTemplate({ ...input, artifactId });
  }

  instantiateTemplate(input: TemplateInput): Template {
    const promotedAt = input.promotedAt ?? now();
    const value = {
      id: crypto.randomUUID(),
      artifactId: input.artifactId,
      revisionId: input.revisionId,
      name: input.name,
      description: input.description ?? null,
      promotedBy: input.promotedBy,
      promotedAt,
    };
    try {
      this.db
        .query(
          "INSERT INTO templates(id, artifact_id, revision_id, name, description, promoted_by, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          value.id,
          value.artifactId,
          value.revisionId,
          value.name,
          value.description,
          value.promotedBy,
          value.promotedAt,
        );
      return TemplateSchema.parse(value);
    } catch (error) {
      throw asStoreError(error);
    }
  }

  pinRevision(revisionId: string): void {
    try {
      this.db.query("UPDATE revisions SET pinned = 1 WHERE id = ?").run(revisionId);
    } catch (error) {
      throw asStoreError(error);
    }
  }

  updateRevisionSource(_revisionId: string, _source: Uint8Array): never {
    throw new FacetStoreError("immutable_revision", "Revision source and sha256 are immutable");
  }
}
