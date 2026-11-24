import type { D1Database } from "./d1";

export type Role = "owner" | "team_leader" | "member";

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

export async function upsertOrg(db: D1Database, o: { installation_id: number; account_login: string; account_type: string }): Promise<OrgRow> {
  await db
    .prepare(
      `INSERT INTO orgs (installation_id, account_login, account_type) VALUES (?, ?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type`,
    )
    .bind(o.installation_id, o.account_login, o.account_type)
    .run();
  return (await db.prepare("SELECT * FROM orgs WHERE installation_id = ?").bind(o.installation_id).first<OrgRow>())!;
}

/** The first person linked to an org becomes its owner. Everyone after that starts as a member. */
export async function ensureMembership(db: D1Database, userId: number, orgId: number): Promise<Role> {
  const existing = await db.prepare("SELECT role FROM memberships WHERE user_id = ? AND org_id = ?").bind(userId, orgId).first<{ role: Role }>();
  if (existing) return existing.role;
  const any = await db.prepare("SELECT 1 AS x FROM memberships WHERE org_id = ? LIMIT 1").bind(orgId).first();
  const role: Role = any ? "member" : "owner";
  await db.prepare("INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, ?)").bind(userId, orgId, role).run();
  return role;
}

export async function getRole(db: D1Database, userId: number, orgId: number): Promise<Role | null> {
  const r = await db.prepare("SELECT role FROM memberships WHERE user_id = ? AND org_id = ?").bind(userId, orgId).first<{ role: Role }>();
  return r?.role ?? null;
}

export async function listOrgsForUser(db: D1Database, userId: number): Promise<Array<OrgRow & { role: Role }>> {
  const res = await db
    .prepare(
      `SELECT o.*, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id
       WHERE m.user_id = ? ORDER BY o.account_login`,
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

export async function listRepos(db: D1Database, orgId: number): Promise<RepoRow[]> {
  return (await db.prepare("SELECT * FROM repos WHERE org_id = ? ORDER BY full_name").bind(orgId).all<RepoRow>()).results;
}

export async function getRepo(db: D1Database, id: number): Promise<RepoRow | null> {
  return db.prepare("SELECT * FROM repos WHERE id = ?").bind(id).first<RepoRow>();
}

export async function getRepoByGithubId(db: D1Database, githubRepoId: number): Promise<RepoRow | null> {
  return db.prepare("SELECT * FROM repos WHERE github_repo_id = ?").bind(githubRepoId).first<RepoRow>();
}

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
