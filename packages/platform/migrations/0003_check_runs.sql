-- Orders checks of the same commit, so an older run that finishes late cannot replace a newer verdict.
CREATE TABLE check_runs (
  github_repo_id INTEGER NOT NULL,
  sha TEXT NOT NULL,
  context TEXT NOT NULL,
  run INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (github_repo_id, sha, context)
);
