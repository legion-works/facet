# Storage reference

## Revisions

Each artifact keeps a ring of at most 50 revisions. Publication evicts the oldest revision that is neither pinned nor bound to a template. If every retained revision is pinned or template-bound, publication fails with `revision_capacity_pinned`; protected history is never deleted.

`pin` changes retention metadata only. It does not copy or rewrite source bytes. Unpinning makes a revision eligible for future ring eviction.

## Templates

A template records one immutable revision ID. Later publication to the source artifact cannot change that revision's SHA or bytes. Promotion records `promoted_by` and `promoted_at`.

Instantiation creates a new artifact and publishes a byte-for-byte copy of the template revision with the same artifact type. The new revision is independent of the source artifact.
