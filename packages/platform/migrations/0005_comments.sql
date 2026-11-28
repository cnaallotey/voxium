-- Comments Voxium wrote on a pull request, so it edits its own instead of adding more, and never touches anyone else's.
CREATE TABLE pr_comments (
  github_repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- 'summary', or 'inline:' and the violation id
  comment_id INTEGER,          -- null while it is being posted
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'deleted')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (github_repo_id, pr_number, kind)
);
