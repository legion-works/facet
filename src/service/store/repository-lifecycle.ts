import type { Database } from "bun:sqlite";

import { type Template, TemplateSchema } from "../../shared/contracts/artifact";
import { asStoreError, FacetStoreError } from "./database";

export interface TemplateInput {
  readonly artifactId: string;
  readonly revisionId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly promotedBy: string;
  readonly promotedAt?: string;
}

export interface PromoteRevisionInput {
  readonly artifactId?: string;
  readonly revisionId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly promotedBy: string;
  readonly promotedAt?: string;
}

function now(): string {
  return new Date().toISOString();
}

export function evictRevisions(db: Database, artifactId: string): void {
  while (true) {
    const count = db
      .query("SELECT COUNT(*) AS count FROM revisions WHERE artifact_id = ?")
      .get(artifactId) as {
      count: number;
    };
    if (count.count <= 50) return;
    const candidate = db
      .query(
        "SELECT id FROM revisions WHERE artifact_id = ? AND pinned = 0 AND NOT EXISTS (SELECT 1 FROM templates WHERE templates.revision_id = revisions.id) ORDER BY revision_number ASC LIMIT 1",
      )
      .get(artifactId) as { id: string } | null;
    if (!candidate) return;
    db.query("UPDATE revisions SET parent_revision_id = NULL WHERE parent_revision_id = ?").run(
      candidate.id,
    );
    db.query("DELETE FROM revisions WHERE id = ?").run(candidate.id);
  }
}

export function promoteRevision(db: Database, input: PromoteRevisionInput): Template {
  const artifactId =
    input.artifactId ??
    (
      db.query("SELECT artifact_id FROM revisions WHERE id = ?").get(input.revisionId) as {
        artifact_id: string;
      } | null
    )?.artifact_id;
  if (!artifactId)
    throw new FacetStoreError("foreign_key", `Revision not found: ${input.revisionId}`);
  return instantiateTemplate(db, { ...input, artifactId });
}

export function instantiateTemplate(db: Database, input: TemplateInput): Template {
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
    db.query(
      "INSERT INTO templates(id, artifact_id, revision_id, name, description, promoted_by, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
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

export function pinRevision(db: Database, revisionId: string): void {
  try {
    db.query("UPDATE revisions SET pinned = 1 WHERE id = ?").run(revisionId);
  } catch (error) {
    throw asStoreError(error);
  }
}
