-- Proposals to change the rules: from a form in Voxium, or from a file in voxium/proposals that a pull request adds.
-- They hold words and rules, never source code. A manager turns one into a pull request that Voxium writes.
CREATE TABLE proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('web', 'pr')),
  -- For a file, its path and git hash, so importing the same file twice makes one proposal.
  source_key TEXT NOT NULL,
  requester_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requester_github_id INTEGER NOT NULL,
  requester_login TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  rationale TEXT NOT NULL,
  change_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'pr_open', 'merged', 'rejected')),
  pr_number INTEGER,
  -- A hash of the protected files on the commit Voxium wrote for the pull request. An approval counts only while the
  -- head still has exactly those, so nobody can push other rules onto the branch and have them approved.
  pr_rules TEXT,
  -- For a file, the GitHub ids of everyone who wrote or committed a commit of the pull request that carried it. They
  -- count as having asked for it, like the pull request's author. A JSON array.
  co_requesters TEXT NOT NULL DEFAULT '[]',
  decided_by TEXT,
  decided_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, source, source_key)
);
CREATE INDEX idx_proposals_pr ON proposals(repo_id, pr_number);

-- An approval given in Voxium: 'self' for a solo owner's own pull request, 'proposal' for a pull request Voxium wrote.
ALTER TABLE self_approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'self' CHECK (kind IN ('self', 'proposal'));

ALTER TABLE decisions ADD COLUMN proposed_by TEXT;
