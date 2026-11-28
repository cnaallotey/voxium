-- An organization's rule set, a new row for each version, never changed or removed: rules that mean the same in every
-- repo, which each repo takes into its own voxium/architecture.json through an approved pull request. Enforcement reads
-- only the repo's file, so saving a version changes no repo.
CREATE TABLE org_rule_sets (
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  rules_json TEXT NOT NULL,
  note TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, version)
);

-- The next version while it is checked and previewed, one an organization, before someone saves it.
CREATE TABLE org_rule_drafts (
  org_id INTEGER PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  based_on INTEGER NOT NULL,
  rules_json TEXT NOT NULL,
  note TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
