-- What a check of the default branch found after a merge, or when someone asked for it: counts by module, rule and
-- module pair, and the exceptions with their expiry, for the drift and diagram pages. Analysis output only, never a line
-- of code or a violation message. created_at is when the run started, so that a run that finishes late does not pass for
-- newer data. complete = 0 when some code could not be read; such a snapshot is shown as incomplete, never as zero.
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  new_count INTEGER NOT NULL DEFAULT 0,
  baseline_count INTEGER NOT NULL DEFAULT 0,
  excepted_count INTEGER NOT NULL DEFAULT 0,
  warn_count INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, commit_sha)
);
CREATE INDEX idx_snapshots_repo ON snapshots(repo_id, id);

-- When a repo's last snapshot run started, so that at most one runs a minute, however many merges or clicks there are.
CREATE TABLE snapshot_runs (
  repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL
);

-- The pull request page reads the check of one pull request directly, instead of looking through recent analyses.
CREATE INDEX idx_analyses_pr ON analyses(repo_id, pr_number, commit_sha);
