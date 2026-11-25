-- Access follows GitHub. Roles and repo visibility are refreshed from GitHub at every sign in.

ALTER TABLE orgs ADD COLUMN account_id INTEGER;

-- Which repos a user can open on GitHub, so the platform never shows more than GitHub would.
CREATE TABLE repo_access (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('read', 'write', 'admin')),
  PRIMARY KEY (user_id, repo_id)
);
CREATE INDEX idx_repo_access_repo ON repo_access(repo_id);

-- A membership outlives a temporary loss of access, so an assigned role is not lost with it.
-- active: usable. gone: GitHub no longer lists the installation for this user. error: access could not be read.
ALTER TABLE memberships ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'gone', 'error'));

-- Earlier owners were simply whoever signed in first. Real ones get the role back at their next sign in.
UPDATE memberships SET role = 'member' WHERE role = 'owner';
