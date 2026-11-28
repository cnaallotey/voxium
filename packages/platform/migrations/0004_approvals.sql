-- A solo owner's approval of their own pull request. GitHub does not let an author approve, so it is given here,
-- with a reason, for one exact commit into one base branch.
CREATE TABLE self_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, pr_number, head_sha, base_ref)
);

-- The decision log: every merged change to the rules. Keyed by GitHub's repo id, so it outlives a disconnect.
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'approved', 'self_approved', 'unapproved')),
  title TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  reason TEXT,
  approved_by TEXT,
  merged_by TEXT,
  head_sha TEXT NOT NULL,
  merged_at TEXT NOT NULL,
  UNIQUE (github_repo_id, pr_number)
);
