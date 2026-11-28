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

/** The newest inference of a repo, however many checks came after it. */
export async function latestInference(db: D1Database, repoId: number): Promise<AnalysisRow | null> {
  return db.prepare("SELECT * FROM analyses WHERE repo_id = ? AND kind = 'inference' ORDER BY id DESC LIMIT 1").bind(repoId).first<AnalysisRow>();
}

export interface SetupDraftRow {
  repo_id: number;
  user_id: number | null;
  commit_sha: string;
  draft_json: string;
  updated_at: string;
}

/** Store the draft of a repo's setup, replacing the one before. */
export async function saveSetupDraft(db: D1Database, d: Pick<SetupDraftRow, "repo_id" | "user_id" | "commit_sha" | "draft_json">): Promise<void> {
  await db
    .prepare(
      `INSERT INTO setup_drafts (repo_id, user_id, commit_sha, draft_json) VALUES (?, ?, ?, ?)
       ON CONFLICT(repo_id) DO UPDATE SET user_id = excluded.user_id, commit_sha = excluded.commit_sha, draft_json = excluded.draft_json, updated_at = datetime('now')`,
    )
    .bind(d.repo_id, d.user_id, d.commit_sha, d.draft_json)
    .run();
}

/** Replace a draft only while it is still the one that was read, so that of two people who send the same form only one goes ahead. */
export async function updateSetupDraft(db: D1Database, repoId: number, was: string, now: string): Promise<boolean> {
  const row = await db
    .prepare("UPDATE setup_drafts SET draft_json = ?, updated_at = datetime('now') WHERE repo_id = ? AND draft_json = ? RETURNING repo_id")
    .bind(now, repoId, was)
    .first();
  return row !== null;
}

export async function getSetupDraft(db: D1Database, repoId: number): Promise<SetupDraftRow | null> {
  return db.prepare("SELECT * FROM setup_drafts WHERE repo_id = ?").bind(repoId).first<SetupDraftRow>();
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

/** 'self' is a solo owner's approval of their own pull request, 'proposal' one of a pull request Voxium wrote. */
export type ApprovalKind = "self" | "proposal";

export async function saveSelfApproval(db: D1Database, pull: PullCommit, userId: number, reason: string, kind: ApprovalKind = "self"): Promise<void> {
  await db
    .prepare(
      `INSERT INTO self_approvals (repo_id, pr_number, head_sha, base_ref, user_id, reason, kind) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, pr_number, head_sha, base_ref) DO UPDATE SET user_id = excluded.user_id, reason = excluded.reason, kind = excluded.kind, created_at = datetime('now')`,
    )
    .bind(pull.repoId, pull.number, pull.headSha, pull.baseRef, userId, reason, kind)
    .run();
}

export async function getSelfApproval(db: D1Database, pull: PullCommit, kind: ApprovalKind = "self"): Promise<SelfApprovalRow | null> {
  return db
    .prepare(
      `SELECT s.id, s.user_id, u.github_id, u.login, s.reason, s.created_at FROM self_approvals s JOIN users u ON u.id = s.user_id
       WHERE s.repo_id = ? AND s.pr_number = ? AND s.head_sha = ? AND s.base_ref = ? AND s.kind = ?`,
    )
    .bind(pull.repoId, pull.number, pull.headSha, pull.baseRef, kind)
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
  /** Who asked for it, when it came from a proposal. */
  proposed_by?: string | null;
}

/** Log a merged rule change. The first record stands, so an event that is delivered again cannot rewrite it. */
export async function saveDecision(db: D1Database, d: Decision): Promise<void> {
  await db
    .prepare(
      `INSERT INTO decisions (github_repo_id, pr_number, kind, title, changes_json, reason, approved_by, merged_by, head_sha, merged_at, proposed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(github_repo_id, pr_number) DO NOTHING`,
    )
    .bind(d.github_repo_id, d.pr_number, d.kind, d.title, JSON.stringify(d.changes), d.reason, d.approved_by, d.merged_by, d.head_sha, d.merged_at, d.proposed_by ?? null)
    .run();
}

export async function listDecisions(db: D1Database, githubRepoId: number, limit = 200): Promise<Decision[]> {
  const res = await db
    .prepare("SELECT * FROM decisions WHERE github_repo_id = ? ORDER BY merged_at DESC, id DESC LIMIT ?")
    .bind(githubRepoId, limit)
    .all<Omit<Decision, "changes"> & { changes_json: string }>();
  return res.results.map(({ changes_json, ...d }) => ({ ...d, changes: JSON.parse(changes_json) as string[] }));
}

export interface PullKey {
  githubRepoId: number;
  number: number;
}

export interface CommentRow {
  kind: string;
  comment_id: number | null;
  state: "open" | "resolved" | "deleted";
}

/** Comments Voxium wrote on a pull request. */
export async function listComments(db: D1Database, pull: PullKey): Promise<CommentRow[]> {
  const res = await db
    .prepare("SELECT kind, comment_id, state FROM pr_comments WHERE github_repo_id = ? AND pr_number = ?")
    .bind(pull.githubRepoId, pull.number)
    .all<CommentRow>();
  return res.results;
}

/**
 * Take the right to write one comment, so overlapping checks do not both write it. False when another check has it.
 * A claim that never got its comment is up for grabs again after ten minutes.
 */
export async function claimComment(db: D1Database, pull: PullKey, kind: string, commentId: number | null): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO pr_comments (github_repo_id, pr_number, kind, comment_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(github_repo_id, pr_number, kind) DO UPDATE SET updated_at = datetime('now'), comment_id = excluded.comment_id
         WHERE pr_comments.comment_id IS NULL AND pr_comments.state = 'open' AND pr_comments.updated_at < datetime('now', '-10 minutes')
       RETURNING kind`,
    )
    .bind(pull.githubRepoId, pull.number, kind, commentId)
    .first();
  return row !== null;
}

export async function setComment(db: D1Database, pull: PullKey, kind: string, commentId: number | null, state: CommentRow["state"]): Promise<void> {
  await db
    .prepare("UPDATE pr_comments SET comment_id = ?, state = ?, updated_at = datetime('now') WHERE github_repo_id = ? AND pr_number = ? AND kind = ?")
    .bind(commentId, state, pull.githubRepoId, pull.number, kind)
    .run();
}

export async function releaseComment(db: D1Database, pull: PullKey, kind: string): Promise<void> {
  await db.prepare("DELETE FROM pr_comments WHERE github_repo_id = ? AND pr_number = ? AND kind = ?").bind(pull.githubRepoId, pull.number, kind).run();
}

export type ProposalStatus = "pending" | "pr_open" | "merged" | "rejected";

export interface ProposalRow {
  id: number;
  repo_id: number;
  source: "web" | "pr";
  source_key: string;
  requester_user_id: number | null;
  requester_github_id: number;
  requester_login: string;
  title: string;
  summary: string;
  rationale: string;
  change_json: string | null;
  status: ProposalStatus;
  pr_number: number | null;
  /** A hash of the protected files on the commit Voxium wrote for its pull request. */
  pr_rules: string | null;
  /** GitHub ids, as a JSON array, of others who count as having asked for it: authors and committers of the carrying pull request. */
  co_requesters: string;
  decided_by: string | null;
  decided_reason: string | null;
  created_at: string;
}

export type NewProposal = Pick<ProposalRow, "repo_id" | "source" | "source_key" | "requester_github_id" | "requester_login" | "title" | "summary" | "rationale" | "change_json"> & {
  co_requesters?: number[];
};

/** Save a proposal, unless one from the same source is there. Returns its id, or null when it was there already. */
export async function insertProposal(db: D1Database, p: NewProposal): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO proposals (repo_id, source, source_key, requester_user_id, requester_github_id, requester_login, title, summary, rationale, change_json, co_requesters)
       VALUES (?, ?, ?, (SELECT id FROM users WHERE github_id = ?), ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, source, source_key) DO NOTHING RETURNING id`,
    )
    .bind(
      p.repo_id, p.source, p.source_key, p.requester_github_id, p.requester_github_id, p.requester_login, p.title, p.summary, p.rationale, p.change_json,
      JSON.stringify(p.co_requesters ?? []),
    )
    .first<{ id: number }>();
  return row?.id ?? null;
}

/** A proposal of this repo. Ids of other repos find nothing. */
export async function getProposal(db: D1Database, repoId: number, id: number): Promise<ProposalRow | null> {
  return db.prepare("SELECT * FROM proposals WHERE repo_id = ? AND id = ?").bind(repoId, id).first<ProposalRow>();
}

/** The proposal whose pull request this is. Only Voxium sets pr_number, from a pull request it created itself. */
export async function getProposalByPr(db: D1Database, repoId: number, number: number): Promise<ProposalRow | null> {
  return db.prepare("SELECT * FROM proposals WHERE repo_id = ? AND pr_number = ?").bind(repoId, number).first<ProposalRow>();
}

export async function listProposals(db: D1Database, repoId: number, limit = 100): Promise<ProposalRow[]> {
  return (await db.prepare("SELECT * FROM proposals WHERE repo_id = ? ORDER BY id DESC LIMIT ?").bind(repoId, limit).all<ProposalRow>()).results;
}

/** Claim a pending proposal for a pull request about to be opened. False when someone else did, or it is decided. */
export async function claimProposal(db: D1Database, id: number, decidedBy: string): Promise<boolean> {
  const row = await db
    .prepare("UPDATE proposals SET status = 'pr_open', decided_by = ? WHERE id = ? AND status = 'pending' AND pr_number IS NULL RETURNING id")
    .bind(decidedBy, id)
    .first();
  return row !== null;
}

/** Give a claim back when its pull request could not be opened. */
export async function releaseProposal(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE proposals SET status = 'pending', decided_by = NULL WHERE id = ? AND status = 'pr_open' AND pr_number IS NULL").bind(id).run();
}

/** Record the pull request Voxium opened for a claimed proposal, and the hash of the protected files it wrote. */
export async function setProposalPr(db: D1Database, id: number, prNumber: number, prRules: string): Promise<void> {
  await db.prepare("UPDATE proposals SET pr_number = ?, pr_rules = ? WHERE id = ? AND status = 'pr_open' AND pr_number IS NULL").bind(prNumber, prRules, id).run();
}

/** Reject a pending proposal. False when it is not pending any more. */
export async function rejectProposal(db: D1Database, id: number, by: string, reason: string): Promise<boolean> {
  const row = await db
    .prepare("UPDATE proposals SET status = 'rejected', decided_by = ?, decided_reason = ? WHERE id = ? AND status = 'pending' RETURNING id")
    .bind(by, reason, id)
    .first();
  return row !== null;
}

const CLOSED_UNMERGED = "Its pull request was closed without merging.";

/**
 * The pull request of a proposal was merged or closed. A merge counts even when an earlier close had rejected the
 * proposal: the pull request was reopened, and what was merged is what the decision log says.
 */
export async function closeProposal(db: D1Database, id: number, merged: boolean): Promise<void> {
  if (merged) {
    await db
      .prepare("UPDATE proposals SET status = 'merged', decided_reason = NULL WHERE id = ? AND pr_number IS NOT NULL AND status IN ('pr_open', 'rejected')")
      .bind(id)
      .run();
    return;
  }
  await db
    .prepare("UPDATE proposals SET status = 'rejected', decided_reason = COALESCE(decided_reason, ?) WHERE id = ? AND status = 'pr_open'")
    .bind(CLOSED_UNMERGED, id)
    .run();
}

/** The pull request of a proposal was reopened, so it is open again. Proposals rejected in Voxium have no pull request. */
export async function reopenProposal(db: D1Database, repoId: number, prNumber: number): Promise<void> {
  await db
    .prepare("UPDATE proposals SET status = 'pr_open', decided_reason = NULL WHERE repo_id = ? AND pr_number = ? AND status = 'rejected'")
    .bind(repoId, prNumber)
    .run();
}

export interface SnapshotRow {
  id: number;
  repo_id: number;
  commit_sha: string;
  complete: number;
  new_count: number;
  baseline_count: number;
  excepted_count: number;
  warn_count: number;
  snapshot_json: string;
  created_at: string;
}

/** Snapshots a repo keeps. Older ones are pruned. */
export const MAX_SNAPSHOTS = 400;
/** Checks of pull requests a repo keeps. Older ones are pruned; inferences never are. */
export const MAX_PR_CHECKS = 500;

/**
 * Claim the snapshot run of a repo, unless one started after `notBefore`. Atomic, so that of many merges or clicks at
 * once only one runs. True when this caller may run.
 */
export async function claimSnapshotRun(db: D1Database, repoId: number, startedAt: string, notBefore: string): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO snapshot_runs (repo_id, started_at) VALUES (?, ?)
       ON CONFLICT (repo_id) DO UPDATE SET started_at = excluded.started_at WHERE snapshot_runs.started_at <= ?
       RETURNING repo_id`,
    )
    .bind(repoId, startedAt, notBefore)
    .first<{ repo_id: number }>();
  return row !== null;
}

/** Save a snapshot. The same commit twice is one snapshot: the first stays. */
export async function saveSnapshot(db: D1Database, s: Omit<SnapshotRow, "id">): Promise<void> {
  await db
    .prepare(
      `INSERT INTO snapshots (repo_id, commit_sha, complete, new_count, baseline_count, excepted_count, warn_count, snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (repo_id, commit_sha) DO NOTHING`,
    )
    .bind(s.repo_id, s.commit_sha, s.complete, s.new_count, s.baseline_count, s.excepted_count, s.warn_count, s.snapshot_json, s.created_at)
    .run();
}

/** Keep the newest MAX_SNAPSHOTS snapshots and MAX_PR_CHECKS checks of pull requests of a repo. Nothing else is touched. */
export async function pruneHistory(db: D1Database, repoId: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM snapshots WHERE repo_id = ? AND id NOT IN
       (SELECT id FROM snapshots WHERE repo_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
    )
    .bind(repoId, repoId, MAX_SNAPSHOTS)
    .run();
  await db
    .prepare(
      `DELETE FROM analyses WHERE repo_id = ? AND kind = 'pr_check' AND id NOT IN
       (SELECT id FROM analyses WHERE repo_id = ? AND kind = 'pr_check' ORDER BY id DESC LIMIT ?)`,
    )
    .bind(repoId, repoId, MAX_PR_CHECKS)
    .run();
}

export type SnapshotCounts = Omit<SnapshotRow, "snapshot_json">;

/**
 * The counts of a repo's snapshots, oldest first, by when their run started. Without their contents, which can be
 * 200 KB each: only the newest are read whole (newestSnapshots).
 */
export async function listSnapshots(db: D1Database, repoId: number, limit = MAX_SNAPSHOTS): Promise<SnapshotCounts[]> {
  const rows = (
    await db
      .prepare(
        `SELECT id, repo_id, commit_sha, complete, new_count, baseline_count, excepted_count, warn_count, created_at FROM snapshots
         WHERE repo_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(repoId, limit)
      .all<SnapshotCounts>()
  ).results;
  return rows.reverse();
}

/** The newest snapshot of a repo that has contents, and the newest complete one, each read whole. */
export async function newestSnapshots(db: D1Database, repoId: number): Promise<{ any: SnapshotRow | null; complete: SnapshotRow | null }> {
  const newest = (complete: boolean) =>
    db
      .prepare(`SELECT * FROM snapshots WHERE repo_id = ? AND snapshot_json != 'null'${complete ? " AND complete = 1" : ""} ORDER BY created_at DESC, id DESC LIMIT 1`)
      .bind(repoId)
      .first<SnapshotRow>();
  return { any: await newest(false), complete: await newest(true) };
}

/** The newest snapshot of a repo by when its run started, complete or not. */
export async function latestSnapshot(db: D1Database, repoId: number): Promise<SnapshotRow | null> {
  return db.prepare("SELECT * FROM snapshots WHERE repo_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").bind(repoId).first<SnapshotRow>();
}

/** The check of one pull request at one commit, the newest when there are several. */
export async function getPrCheck(db: D1Database, repoId: number, number: number, sha: string): Promise<AnalysisRow | null> {
  return db
    .prepare("SELECT * FROM analyses WHERE repo_id = ? AND pr_number = ? AND commit_sha = ? AND kind = 'pr_check' ORDER BY id DESC LIMIT 1")
    .bind(repoId, number, sha)
    .first<AnalysisRow>();
}

/** How many pull requests a check blocked, by ISO-like week (year and week number), for the newest weeks. */
export async function blockedPerWeek(db: D1Database, repoId: number, weeks = 12): Promise<Array<{ week: string; pulls: number }>> {
  const rows = (
    await db
      .prepare(
        `SELECT strftime('%Y-%W', created_at) AS week, COUNT(DISTINCT pr_number) AS pulls FROM analyses
         WHERE repo_id = ? AND kind = 'pr_check' AND json_extract(summary_json, '$.state') = 'failure'
         GROUP BY week ORDER BY week DESC LIMIT ?`,
      )
      .bind(repoId, weeks)
      .all<{ week: string; pulls: number }>()
  ).results;
  return rows.reverse();
}

/** When a pull request of a repo was last checked. */
export async function lastCheckAt(db: D1Database, repoId: number): Promise<string | null> {
  const row = await db.prepare("SELECT created_at FROM analyses WHERE repo_id = ? AND kind = 'pr_check' ORDER BY id DESC LIMIT 1").bind(repoId).first<{ created_at: string }>();
  return row?.created_at ?? null;
}

export interface AuditRow {
  id: number;
  action: string;
  detail: string | null;
  created_at: string;
  login: string | null;
}

/** An organization's audit log, newest first, a page at a time: entries before `before` (an id), of one action if given. */
export async function listAudit(db: D1Database, orgId: number, opts: { before?: number; action?: string; limit: number }): Promise<AuditRow[]> {
  return (
    await db
      .prepare(
        `SELECT a.id, a.action, a.detail, a.created_at, u.login FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         WHERE a.org_id = ? AND a.id < ? AND (? IS NULL OR a.action = ?) ORDER BY a.id DESC LIMIT ?`,
      )
      .bind(orgId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.action ?? null, opts.action ?? null, opts.limit)
      .all<AuditRow>()
  ).results;
}

/** The actions an organization's audit log has, for the filter. */
export async function auditActions(db: D1Database, orgId: number): Promise<string[]> {
  return (await db.prepare("SELECT DISTINCT action FROM audit_log WHERE org_id = ? ORDER BY action").bind(orgId).all<{ action: string }>()).results.map((r) => r.action);
}

export interface OrgRuleSetRow {
  org_id: number;
  version: number;
  rules_json: string;
  note: string;
  updated_by: number | null;
  created_at: string;
  login?: string | null;
}

/** The newest version of an organization's rule set, or null before the first. */
export async function latestOrgRuleSet(db: D1Database, orgId: number): Promise<OrgRuleSetRow | null> {
  return db.prepare("SELECT * FROM org_rule_sets WHERE org_id = ? ORDER BY version DESC LIMIT 1").bind(orgId).first<OrgRuleSetRow>();
}

export async function listOrgRuleSets(db: D1Database, orgId: number, limit = 20): Promise<OrgRuleSetRow[]> {
  return (
    await db
      .prepare("SELECT s.*, u.login FROM org_rule_sets s LEFT JOIN users u ON u.id = s.updated_by WHERE s.org_id = ? ORDER BY s.version DESC LIMIT ?")
      .bind(orgId, limit)
      .all<OrgRuleSetRow>()
  ).results;
}

/**
 * Save the version after `basedOn` (0 before the first). Only when the newest version is still `basedOn`, so that of
 * two people who save at once only the first gets that version; the other gets null. Append only.
 */
export async function saveOrgRuleSet(db: D1Database, s: { org_id: number; based_on: number; rules_json: string; note: string; updated_by: number }): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO org_rule_sets (org_id, version, rules_json, note, updated_by)
       SELECT ?, ? + 1, ?, ?, ? WHERE COALESCE((SELECT MAX(version) FROM org_rule_sets WHERE org_id = ?), 0) = ?
       ON CONFLICT (org_id, version) DO NOTHING RETURNING version`,
    )
    .bind(s.org_id, s.based_on, s.rules_json, s.note, s.updated_by, s.org_id, s.based_on)
    .first<{ version: number }>();
  return row?.version ?? null;
}

export interface OrgRuleDraftRow {
  org_id: number;
  based_on: number;
  rules_json: string;
  note: string;
  user_id: number | null;
  updated_at: string;
}

export async function getOrgRuleDraft(db: D1Database, orgId: number): Promise<OrgRuleDraftRow | null> {
  return db.prepare("SELECT * FROM org_rule_drafts WHERE org_id = ?").bind(orgId).first<OrgRuleDraftRow>();
}

export async function saveOrgRuleDraft(db: D1Database, d: Omit<OrgRuleDraftRow, "updated_at">): Promise<void> {
  await db
    .prepare(
      `INSERT INTO org_rule_drafts (org_id, based_on, rules_json, note, user_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (org_id) DO UPDATE SET based_on = excluded.based_on, rules_json = excluded.rules_json, note = excluded.note, user_id = excluded.user_id, updated_at = datetime('now')`,
    )
    .bind(d.org_id, d.based_on, d.rules_json, d.note, d.user_id)
    .run();
}

export async function deleteOrgRuleDraft(db: D1Database, orgId: number): Promise<void> {
  await db.prepare("DELETE FROM org_rule_drafts WHERE org_id = ?").bind(orgId).run();
}
