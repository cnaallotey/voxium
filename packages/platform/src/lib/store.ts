import type { D1Database } from "./d1";

export type Role = "owner" | "team_leader" | "member";
export type AccessLevel = "read" | "write" | "admin";

export interface UserRow {
  id: number;
  github_id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}
export interface OrgRow {
  id: number;
  installation_id: number;
  account_id: number | null;
  account_login: string;
  account_type: string;
}
export interface RepoRow {
  id: number;
  org_id: number;
  github_repo_id: number;
  full_name: string;
  default_branch: string;
  is_private: number;
  status: string;
  setup_pr_url: string | null;
}
export interface AnalysisRow {
  id: number;
  repo_id: number;
  kind: string;
  commit_sha: string | null;
  pr_number: number | null;
  confidence: number | null;
  new_violations: number;
  baseline_violations: number;
  summary_json: string;
  created_at: string;
}

export async function upsertUser(db: D1Database, u: { github_id: number; login: string; name: string | null; avatar_url: string | null }): Promise<UserRow> {
  await db
    .prepare(
      `INSERT INTO users (github_id, login, name, avatar_url) VALUES (?, ?, ?, ?)
       ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url`,
    )
    .bind(u.github_id, u.login, u.name, u.avatar_url)
    .run();
  return (await db.prepare("SELECT * FROM users WHERE github_id = ?").bind(u.github_id).first<UserRow>())!;
}

export async function getUser(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function upsertOrg(db: D1Database, o: { installation_id: number; account_id: number; account_login: string; account_type: string }): Promise<OrgRow> {
  await db
    .prepare(
      `INSERT INTO orgs (installation_id, account_id, account_login, account_type) VALUES (?, ?, ?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET account_id = excluded.account_id, account_login = excluded.account_login, account_type = excluded.account_type`,
    )
    .bind(o.installation_id, o.account_id, o.account_login, o.account_type)
    .run();
  return (await db.prepare("SELECT * FROM orgs WHERE installation_id = ?").bind(o.installation_id).first<OrgRow>())!;
}

/**
 * Make someone's membership match GitHub and return the resulting role. A Team Leader role is kept or dropped by the
 * database itself, so a sign in that overlaps an Owner's change to it cannot undo that change.
 */
export async function syncMembership(db: D1Database, userId: number, orgId: number, standing: "owner" | "member" | "outside"): Promise<Role> {
  const row = await db
    .prepare(
      `INSERT INTO memberships (user_id, org_id, role, state) VALUES (?, ?, ?, 'active')
       ON CONFLICT(user_id, org_id) DO UPDATE SET state = 'active', role = CASE
         WHEN excluded.role = 'owner' THEN 'owner'
         WHEN ? = 'member' AND memberships.role = 'team_leader' THEN 'team_leader'
         ELSE 'member' END
       RETURNING role`,
    )
    .bind(userId, orgId, standing === "owner" ? "owner" : "member", standing)
    .first<{ role: Role }>();
  return row!.role;
}

/** Assign or take away Team Leader. Owners mirror GitHub, so their role cannot be set. False when nothing changed. */
export async function setTeamLeader(db: D1Database, userId: number, orgId: number, leader: boolean): Promise<boolean> {
  const [from, to] = leader ? ["member", "team_leader"] : ["team_leader", "member"];
  const row = await db
    .prepare("UPDATE memberships SET role = ? WHERE user_id = ? AND org_id = ? AND role = ? RETURNING role")
    .bind(to, userId, orgId, from)
    .first();
  return row !== null;
}

export interface PersonRow {
  user_id: number;
  github_id: number;
  login: string;
  name: string | null;
  role: Role;
  state: "active" | "gone" | "error";
}

/** Everyone who has signed in to Voxium and has a membership in the org. */
export async function listPeople(db: D1Database, orgId: number): Promise<PersonRow[]> {
  const res = await db
    .prepare(
      `SELECT u.id AS user_id, u.github_id, u.login, u.name, m.role, m.state FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ? ORDER BY u.login`,
    )
    .bind(orgId)
    .all<PersonRow>();
  return res.results;
}

/** The role on record, whether or not the membership is usable right now. Only for deciding a new one. */
export async function getStoredRole(db: D1Database, userId: number, orgId: number): Promise<Role | null> {
  const r = await db.prepare("SELECT role FROM memberships WHERE user_id = ? AND org_id = ?").bind(userId, orgId).first<{ role: Role }>();
  return r?.role ?? null;
}

export interface MembershipRow {
  org_id: number;
  account_login: string;
  role: Role;
  state: "active" | "gone" | "error";
}

export async function listMemberships(db: D1Database, userId: number): Promise<MembershipRow[]> {
  const res = await db
    .prepare(
      `SELECT m.org_id, o.account_login, m.role, m.state FROM memberships m JOIN orgs o ON o.id = m.org_id
       WHERE m.user_id = ? ORDER BY o.account_login`,
    )
    .bind(userId)
    .all<MembershipRow>();
  return res.results;
}

/** Take away all access in an org while keeping the role on record. */
export async function suspendMembership(db: D1Database, userId: number, orgId: number, state: "gone" | "error"): Promise<void> {
  await db.batch([
    accessDelete(db, userId, orgId),
    db
      .prepare(
        `INSERT INTO memberships (user_id, org_id, role, state) VALUES (?, ?, 'member', ?)
         ON CONFLICT(user_id, org_id) DO UPDATE SET state = excluded.state`,
      )
      .bind(userId, orgId, state),
  ]);
}

function accessDelete(db: D1Database, userId: number, orgId: number) {
  return db.prepare("DELETE FROM repo_access WHERE user_id = ? AND repo_id IN (SELECT id FROM repos WHERE org_id = ?)").bind(userId, orgId);
}

/** Replace what a user can see in an org. Repos that are not listed lose access. */
export async function replaceRepoAccess(
  db: D1Database,
  userId: number,
  orgId: number,
  repos: Array<{ id: number; permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } }>,
): Promise<void> {
  const insert = db.prepare(
    // GitHub can repeat a repo across pages when the list changes while it is being read.
    `INSERT INTO repo_access (user_id, repo_id, level) SELECT ?, id, ? FROM repos WHERE github_repo_id = ? AND org_id = ?
     ON CONFLICT(user_id, repo_id) DO UPDATE SET level = excluded.level`,
  );
  const rows = repos.map((r) => {
    const p = r.permissions ?? {};
    const level: AccessLevel = p.admin ? "admin" : p.maintain || p.push ? "write" : "read";
    return insert.bind(userId, level, r.id, orgId);
  });
  await db.batch([accessDelete(db, userId, orgId), ...rows.slice(0, 49)]);
  for (let i = 49; i < rows.length; i += 50) await db.batch(rows.slice(i, i + 50));
}

export async function getRole(db: D1Database, userId: number, orgId: number): Promise<Role | null> {
  const r = await db.prepare("SELECT role FROM memberships WHERE user_id = ? AND org_id = ? AND state = 'active'").bind(userId, orgId).first<{ role: Role }>();
  return r?.role ?? null;
}

export async function listOrgsForUser(db: D1Database, userId: number): Promise<Array<OrgRow & { role: Role }>> {
  const res = await db
    .prepare(
      `SELECT o.*, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id
       WHERE m.user_id = ? AND m.state = 'active' ORDER BY o.account_login`,
    )
    .bind(userId)
    .all<OrgRow & { role: Role }>();
  return res.results;
}

export async function upsertRepos(
  db: D1Database,
  orgId: number,
  repos: Array<{ id: number; full_name: string; default_branch: string; private: boolean }>,
): Promise<void> {
  if (!repos.length) return;
  const stmt = db.prepare(
    `INSERT INTO repos (org_id, github_repo_id, full_name, default_branch, is_private) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(github_repo_id) DO UPDATE SET full_name = excluded.full_name, default_branch = excluded.default_branch, is_private = excluded.is_private, org_id = excluded.org_id`,
  );
  for (let i = 0; i < repos.length; i += 50) {
    await db.batch(repos.slice(i, i + 50).map((r) => stmt.bind(orgId, r.id, r.full_name, r.default_branch, r.private ? 1 : 0)));
  }
}

export async function removeRepos(db: D1Database, githubRepoIds: number[]): Promise<void> {
  for (const id of githubRepoIds) await db.prepare("DELETE FROM repos WHERE github_repo_id = ?").bind(id).run();
}

export async function deleteOrgByInstallation(db: D1Database, installationId: number): Promise<void> {
  await db.prepare("DELETE FROM orgs WHERE installation_id = ?").bind(installationId).run();
}

/** Repos in an org that the user can open on GitHub, as of their last sign in. */
export async function listReposForUser(db: D1Database, userId: number, orgId: number): Promise<Array<RepoRow & { level: AccessLevel }>> {
  const res = await db
    .prepare(
      `SELECT r.*, a.level FROM repos r
       JOIN repo_access a ON a.repo_id = r.id AND a.user_id = ?
       JOIN memberships m ON m.org_id = r.org_id AND m.user_id = a.user_id AND m.state = 'active'
       WHERE r.org_id = ? ORDER BY r.full_name`,
    )
    .bind(userId, orgId)
    .all<RepoRow & { level: AccessLevel }>();
  return res.results;
}

export async function getRepo(db: D1Database, id: number): Promise<RepoRow | null> {
  return db.prepare("SELECT * FROM repos WHERE id = ?").bind(id).first<RepoRow>();
}

export async function getRepoByGithubId(db: D1Database, githubRepoId: number): Promise<RepoRow | null> {
  return db.prepare("SELECT * FROM repos WHERE github_repo_id = ?").bind(githubRepoId).first<RepoRow>();
}

/** Role on record. Callers must confirm it with GitHub, so a lapsed sign in does not matter here. */
export async function getRoleByGithubUser(db: D1Database, githubUserId: number, orgId: number): Promise<Role | null> {
  const r = await db
    .prepare("SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.github_id = ? AND m.org_id = ?")
    .bind(githubUserId, orgId)
    .first<{ role: Role }>();
  return r?.role ?? null;
}

export async function getOrg(db: D1Database, id: number): Promise<OrgRow | null> {
  return db.prepare("SELECT * FROM orgs WHERE id = ?").bind(id).first<OrgRow>();
}

export async function getOrgByInstallation(db: D1Database, installationId: number): Promise<OrgRow | null> {
  return db.prepare("SELECT * FROM orgs WHERE installation_id = ?").bind(installationId).first<OrgRow>();
}

export async function setRepoSetup(db: D1Database, repoId: number, status: string, prUrl: string | null): Promise<void> {
  await db.prepare("UPDATE repos SET status = ?, setup_pr_url = ? WHERE id = ?").bind(status, prUrl, repoId).run();
}

/** Claim the next run number for a check of one commit. */
export async function beginCheck(db: D1Database, githubRepoId: number, sha: string, context: string): Promise<number> {
  await db.prepare("DELETE FROM check_runs WHERE updated_at < datetime('now', '-7 days')").run();
  const row = await db
    .prepare(
      `INSERT INTO check_runs (github_repo_id, sha, context) VALUES (?, ?, ?)
       ON CONFLICT(github_repo_id, sha, context) DO UPDATE SET run = run + 1, updated_at = datetime('now') RETURNING run`,
    )
    .bind(githubRepoId, sha, context)
    .first<{ run: number }>();
  return row!.run;
}

/** False when a newer run for the same commit has started. */
export async function isLatestCheck(db: D1Database, githubRepoId: number, sha: string, context: string, run: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT run FROM check_runs WHERE github_repo_id = ? AND sha = ? AND context = ?")
    .bind(githubRepoId, sha, context)
    .first<{ run: number }>();
  return row?.run === run;
}

export async function saveAnalysis(
  db: D1Database,
  a: {
    repo_id: number;
    kind: "inference" | "pr_check";
    commit_sha?: string | null;
    pr_number?: number | null;
    confidence?: number | null;
    new_violations?: number;
    baseline_violations?: number;
    summary: unknown;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO analyses (repo_id, kind, commit_sha, pr_number, confidence, new_violations, baseline_violations, summary_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(a.repo_id, a.kind, a.commit_sha ?? null, a.pr_number ?? null, a.confidence ?? null, a.new_violations ?? 0, a.baseline_violations ?? 0, JSON.stringify(a.summary))
    .run();
}

export async function listAnalyses(db: D1Database, repoId: number, limit = 20): Promise<AnalysisRow[]> {
  return (await db.prepare("SELECT * FROM analyses WHERE repo_id = ? ORDER BY id DESC LIMIT ?").bind(repoId, limit).all<AnalysisRow>()).results;
}

export async function audit(db: D1Database, orgId: number | null, userId: number | null, action: string, detail?: string): Promise<void> {
  await db.prepare("INSERT INTO audit_log (org_id, user_id, action, detail) VALUES (?, ?, ?, ?)").bind(orgId, userId, action, detail ?? null).run();
}

export interface SelfApprovalRow {
  id: number;
  user_id: number;
  github_id: number;
  login: string;
  reason: string;
  created_at: string;
}

export interface PullCommit {
  repoId: number;
  number: number;
  headSha: string;
  baseRef: string;
}

export async function saveSelfApproval(db: D1Database, pull: PullCommit, userId: number, reason: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO self_approvals (repo_id, pr_number, head_sha, base_ref, user_id, reason) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, pr_number, head_sha, base_ref) DO UPDATE SET user_id = excluded.user_id, reason = excluded.reason, created_at = datetime('now')`,
    )
    .bind(pull.repoId, pull.number, pull.headSha, pull.baseRef, userId, reason)
    .run();
}

export async function getSelfApproval(db: D1Database, pull: PullCommit): Promise<SelfApprovalRow | null> {
  return db
    .prepare(
      `SELECT s.id, s.user_id, u.github_id, u.login, s.reason, s.created_at FROM self_approvals s JOIN users u ON u.id = s.user_id
       WHERE s.repo_id = ? AND s.pr_number = ? AND s.head_sha = ? AND s.base_ref = ?`,
    )
    .bind(pull.repoId, pull.number, pull.headSha, pull.baseRef)
    .first<SelfApprovalRow>();
}

/** Take back an approval of this pull request, whichever commit it was for. Only the person who gave it can. */
export async function withdrawSelfApproval(db: D1Database, repoId: number, number: number, userId: number): Promise<void> {
  await db.prepare("DELETE FROM self_approvals WHERE repo_id = ? AND pr_number = ? AND user_id = ?").bind(repoId, number, userId).run();
}

export type DecisionKind = "setup" | "approved" | "self_approved" | "unapproved";

export interface Decision {
  github_repo_id: number;
  pr_number: number;
  kind: DecisionKind;
  title: string;
  changes: string[];
  reason: string | null;
  approved_by: string | null;
  merged_by: string | null;
  head_sha: string;
  merged_at: string;
}

/** Log a merged rule change. The first record stands, so an event that is delivered again cannot rewrite it. */
export async function saveDecision(db: D1Database, d: Decision): Promise<void> {
  await db
    .prepare(
      `INSERT INTO decisions (github_repo_id, pr_number, kind, title, changes_json, reason, approved_by, merged_by, head_sha, merged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(github_repo_id, pr_number) DO NOTHING`,
    )
    .bind(d.github_repo_id, d.pr_number, d.kind, d.title, JSON.stringify(d.changes), d.reason, d.approved_by, d.merged_by, d.head_sha, d.merged_at)
    .run();
}

export async function listDecisions(db: D1Database, githubRepoId: number, limit = 200): Promise<Decision[]> {
  const res = await db
    .prepare("SELECT * FROM decisions WHERE github_repo_id = ? ORDER BY merged_at DESC, id DESC LIMIT ?")
    .bind(githubRepoId, limit)
    .all<Omit<Decision, "changes"> & { changes_json: string }>();
  return res.results.map(({ changes_json, ...d }) => ({ ...d, changes: JSON.parse(changes_json) as string[] }));
}
