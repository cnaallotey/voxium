-- The architecture inferred for a repo that is not set up yet, for an Owner or Team Leader to review and edit before
-- Voxium opens the setup pull request. Analysis output only: module names, globs, rule ids, counts and notes, never
-- the contents of a file. One draft a repo; inferring again replaces it.
CREATE TABLE setup_drafts (
  repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  commit_sha TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The repo page reads the latest inference of a repo, which is usually its oldest analysis. Without this index that read
-- goes through every analysis of the repo, one for each pull request check.
CREATE INDEX idx_analyses_repo_kind ON analyses(repo_id, kind, id);
