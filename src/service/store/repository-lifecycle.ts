import type { Database } from "bun:sqlite";

import { type Template, TemplateSchema } from "../../shared/contracts/artifact";
import { now } from "../../shared/util/time";
import { FacetError } from "../../shared/errors/facet-error";
import { PROMOTION_GATE } from "../../shared/contracts/promotion";
import type { RenderStatus } from "../../shared/contracts/validation";
import { verdictFromStoredRun } from "../stored-verdict";
import type { ArtifactRepository } from "./repository";
import { asStoreError, FacetStoreError } from "./database";

export interface TemplateInput {
  readonly artifactId: string;
  readonly revisionId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly promotedBy: string;
  readonly promotedAt?: string;
  readonly promotionOverride?: string | null;
}

export interface PromoteRevisionInput {
  readonly artifactId?: string;
  readonly revisionId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly promotedBy: string;
  readonly promotedAt?: string;
  readonly allowUnverified?: boolean;
}

export function evictRevisions(
  db: Database,
  artifactId: string,
  protectedRevisionId?: string,
): void {
  while (true) {
    const count = db
      .query("SELECT COUNT(*) AS count FROM revisions WHERE artifact_id = ?")
      .get(artifactId) as {
      count: number;
    };
    if (count.count <= 50) return;
    const candidate =
      protectedRevisionId === undefined
        ? (db
            .query(
              "SELECT id FROM revisions WHERE artifact_id = ? AND pinned = 0 AND NOT EXISTS (SELECT 1 FROM templates WHERE templates.revision_id = revisions.id) ORDER BY revision_number ASC LIMIT 1",
            )
            .get(artifactId) as { id: string } | null)
        : (db
            .query(
              "SELECT id FROM revisions WHERE artifact_id = ? AND id <> ? AND pinned = 0 AND NOT EXISTS (SELECT 1 FROM templates WHERE templates.revision_id = revisions.id) ORDER BY revision_number ASC LIMIT 1",
            )
            .get(artifactId, protectedRevisionId) as { id: string } | null);
    if (!candidate) {
      throw new FacetStoreError(
        "revision_capacity_pinned",
        `Revision capacity is full for artifact ${artifactId}; all revisions are pinned or template-bound`,
      );
    }
    db.query("UPDATE revisions SET parent_revision_id = NULL WHERE parent_revision_id = ?").run(
      candidate.id,
    );
    db.query("DELETE FROM revisions WHERE id = ?").run(candidate.id);
  }
}

export function promoteRevision(
  db: Database,
  repository: ArtifactRepository,
  input: PromoteRevisionInput,
): Template {
  return db
    .transaction(() => {
      const owner = db
        .query("SELECT artifact_id FROM revisions WHERE id = ?")
        .get(input.revisionId) as { artifact_id: string } | null;
      if (!owner)
        throw new FacetStoreError("foreign_key", `Revision not found: ${input.revisionId}`);
      // The template table has independent foreign keys on artifact_id and
      // revision_id, not a composite ownership constraint, so an explicit
      // artifactId that disagrees with the revision's real owner would
      // otherwise insert silently — instantiation would then copy the wrong
      // artifact's bytes under the caller-supplied artifact's identity.
      if (input.artifactId !== undefined && input.artifactId !== owner.artifact_id) {
        throw new FacetStoreError(
          "foreign_key",
          `Revision ${input.revisionId} belongs to artifact ${owner.artifact_id}, not ${input.artifactId}`,
        );
      }
      const revision = repository.getRevisionById(input.revisionId);
      if (revision === null)
        throw new FacetStoreError("foreign_key", `Revision not found: ${input.revisionId}`);
      const tier1 = repository.listRenderRuns({ revisionId: revision.id, tier: 1 })[0];
      const tier0 = repository.listRenderRuns({ revisionId: revision.id, tier: 0 })[0];
      const tier1Status = tier1 === undefined ? null : verdictFromStoredRun(revision, tier1).status;
      const tier0Status = tier0 === undefined ? null : verdictFromStoredRun(revision, tier0).status;
      const reason =
        tier1Status === null
          ? "no_visual_verification"
          : tier0Status === "error"
            ? "error"
            : PROMOTION_GATE[tier1Status as RenderStatus] === "allow"
              ? null
              : tier1Status;
      if (reason !== null && input.allowUnverified !== true) {
        throw new FacetError(
          "promotion_refused",
          `Promotion refused (${reason}). Run facet read-back --artifact-id ${owner.artifact_id} --tier visual on revision ${input.revisionId}, or pass --allow-unverified to record an override.`,
          {
            details: { revisionId: input.revisionId, reason, tier1Status, tier0Status },
          },
        );
      }
      return createTemplate(db, {
        ...input,
        artifactId: owner.artifact_id,
        promotionOverride: reason,
      });
    })
    .immediate();
}

export function createTemplate(db: Database, input: TemplateInput): Template {
  const promotedAt = input.promotedAt ?? now();
  const value = {
    id: crypto.randomUUID(),
    artifactId: input.artifactId,
    revisionId: input.revisionId,
    name: input.name,
    description: input.description ?? null,
    promotedBy: input.promotedBy,
    promotedAt,
    promotionOverride: input.promotionOverride ?? null,
  };
  try {
    db.query(
      "INSERT INTO templates(id, artifact_id, revision_id, name, description, promoted_by, promoted_at, promotion_override) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      value.id,
      value.artifactId,
      value.revisionId,
      value.name,
      value.description,
      value.promotedBy,
      value.promotedAt,
      value.promotionOverride,
    );
    return TemplateSchema.parse(value);
  } catch (error) {
    const mapped = asStoreError(error);
    if (mapped.code === "template_name_taken") {
      throw new FacetStoreError(
        "template_name_taken",
        `Template name already exists: ${input.name}`,
        {
          cause: error,
          details: { name: input.name },
        },
      );
    }
    throw mapped;
  }
}

export function pinRevision(db: Database, revisionId: string, pinned = true): void {
  try {
    const result = db
      .query("UPDATE revisions SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, revisionId);
    if (result.changes === 0) {
      throw new FacetStoreError("foreign_key", `Revision not found: ${revisionId}`);
    }
  } catch (error) {
    throw asStoreError(error);
  }
}
