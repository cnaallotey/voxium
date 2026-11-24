-- Voxium platform schema. Stores analysis results only, never source code.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One org per GitHub App installation (a user or organization account).
CREATE TABLE orgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Roles: owner, team_leader, member. Team Leaders approve architecture changes org wide.
CREATE TABLE memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'team_leader', 'member')),
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  github_repo_id INTEGER NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  is_private INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'connected', -- connected, setup_pr_open, active
  setup_pr_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_repos_org ON repos(org_id);

-- Results of inference runs and PR checks. summary_json holds module maps and violation
-- records (paths and messages), never file contents.
CREATE TABLE analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('inference', 'pr_check')),
  commit_sha TEXT,
  pr_number INTEGER,
  confidence REAL,
  new_violations INTEGER NOT NULL DEFAULT 0,
  baseline_violations INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_analyses_repo ON analyses(repo_id, created_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER REFERENCES orgs(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
