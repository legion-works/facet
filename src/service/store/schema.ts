export const INITIAL_SCHEMA = `
CREATE TABLE projects(
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE artifacts(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, slug)
);
CREATE TABLE revisions(
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  revision_number INTEGER NOT NULL,
  parent_revision_id TEXT REFERENCES revisions(id),
  artifact_type TEXT NOT NULL CHECK(artifact_type IN ('markdown','mermaid','svg','chart')),
  source BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  note TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id, revision_number),
  UNIQUE(artifact_id, sha256)
);
CREATE TABLE render_runs(
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  tier INTEGER NOT NULL CHECK(tier IN (0,1)),
  status TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  screenshot_path TEXT,
  console_path TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE TABLE templates(
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  promoted_by TEXT NOT NULL,
  promoted_at TEXT NOT NULL
);
`;
