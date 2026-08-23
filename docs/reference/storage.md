# Storage reference

Facet stores source bytes in SQLite and keeps render evidence on disk. The
service does not parse or render source while writing it.

## Runtime paths and permissions

`computeFacetPaths` (`src/shared/config/paths.ts`) uses `FACET_HOME` when set:

| path          | location under `FACET_HOME` | XDG default                                  |
| ------------- | --------------------------- | -------------------------------------------- |
| database      | `db/facet.sqlite`           | `$XDG_DATA_HOME/facet/db/facet.sqlite`       |
| evidence      | `evidence/`                 | `$XDG_STATE_HOME/facet/evidence/`            |
| promote token | `secrets/promote.token`     | `$XDG_DATA_HOME/facet/secrets/promote.token` |
| lock          | `run/facet.lock`            | `$XDG_STATE_HOME/facet/run/facet.lock`       |
| metadata      | `metadata.json`             | `$XDG_CONFIG_HOME/facet/metadata.json`       |

`openDatabase` enables SQLite WAL mode, a 1,000 ms default busy timeout, and
foreign keys. `hardenDatabaseFiles` applies mode `0600` to the database and its
`-wal` and `-shm` sidecars. Owner-only directories use mode `0700`, including
the evidence root and every per-run evidence directory.

## Schema migrations

`runMigrations` records applied versions in `schema_migrations` and applies
additive fragments in order. The current schema is v9:

| version | change                                                                                                                                                                 |
| ------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|      v1 | Creates `projects`, `artifacts`, `revisions`, `render_runs`, and `templates`. Revision source is a BLOB; artifact types are `markdown`, `mermaid`, `svg`, and `chart`. |
|      v2 | Adds `render_runs.retained`, exempting selected evidence from cleanup.                                                                                                 |
|      v3 | Adds `revisions.renderer`, constrained to `svg` or `canvas`. `canvas` is a chart renderer, not an artifact type.                                                       |
|      v4 | Adds `render_runs.screenshot_error_json` for typed transient screenshot-capture failures.                                                                              |
|      v5 | Adds `render_runs.insecure_json` for the effective insecure execution marker and reason.                                                                               |
|      v6 | Adds static `html` revisions and HTML observations.                                                                                                                    |
|      v7 | Backfills HTML observation defaults.                                                                                                                                   |
|      v8 | Adds `tsx`, declared revision execution, and nullable `render_runs.compiled_path`.                                                                                     |
|      v9 | Adds `render_runs.screenshot_format`, recorded as `png` or `webp` for retained evidence.                                                                               |

Migrations are additive and transactional. Existing revisions are not rewritten
when a later schema version is applied.

## Revisions

Each artifact keeps a ring of at most 50 revisions. Publication evicts the
oldest revision that is neither pinned nor bound to a template. If every
retained revision is pinned or template-bound, publication fails with
`revision_capacity_pinned`; protected history is never deleted.

`pin` changes retention metadata only. It does not copy or rewrite source bytes.
Unpinning makes a revision eligible for future ring eviction.

Each revision has an immutable source BLOB, SHA-256, revision number, optional
parent revision, note, artifact type, renderer, and timestamps. A revision SHA
is unique per artifact. Read-back looks up `(artifactId, revisionSha)` before
reading verdict rows, so verdicts cannot cross revisions.

## Render evidence

Tier 0 stores its row and, for successful TSX compilation, derived compiled
bytes at `compiled_path`. Tier 1 stores the row plus a deterministic per-run directory:

```text
<evidence>/tier1/<revisionSha>/<runId>/
├── screenshot.webp
├── console.txt
└── protocol-observation.json
```

New captures use `screenshot.webp`; legacy retained rows may keep
`screenshot.png`. The v9 `render_runs.screenshot_format` value is `webp` or
`png`, but bytes are authoritative on read and export: the service sniffs PNG
and WebP signatures and treats unknown signatures as unavailable rather than
trusting stale metadata. The service stores and serves bytes; it does not
encode screenshots.

The row also points to `protocol-observation.json` when present. The evidence
root and each run directory are mode `0700`. `EVIDENCE_LAST_N_PER_ARTIFACT`
defaults to `10`: the write path keeps the ten newest non-retained runs for an
artifact and unlinks older screenshot and console files. Rows marked
`retained = 1` are exempt. Cleanup is best-effort; the database row remains the
authority and the orphan sweep can recover from stale files.

## Templates

A template records one immutable revision ID. Later publication to the source
artifact cannot change that revision's SHA or bytes. Promotion records
`promoted_by` and `promoted_at`. Promotion and instantiation require the
operator capability.

Instantiation creates a new artifact and publishes a byte-for-byte copy of the
template revision with the same artifact type. The new revision is independent
of the source artifact.
