import { findProtectedChanges, PROTECTED_FILES, ARCH_FILE_PATH, type ProtectedContents } from "@voxium/core";
import { getEnv, type Env } from "./env";
import { checkPullRequest, wantFile, type PrCheckOutcome } from "./analysis";
import { canManage, githubRepoLevel, githubStanding, resolveRole } from "./access";
import { currentApprovals } from "./approval";
import { selfApprovalProblem } from "./self-approval";
import {
  fetchTarball,
  getBranchSha,
  getFileAtRef,
  getInstallationToken,
  getMergeBase,
  listReviews,
  listTree,
  setCommitStatus,
} from "./github";
import { readTarGz } from "./tar";
import { beginCheck, getOrg, getRepoByGithubId, getRoleByGithubUser, getSelfApproval, isLatestCheck, saveAnalysis, setRepoSetup, type OrgRow, type RepoRow } from "./store";

export interface PrEvent {
  installationId: number;
  repoId: number;
  fullName: string;
  defaultBranch: string;
  number: number;
  authorId: number;
  headSha: string;
  baseRef: string;
  /** Who submitted or lost the review, when a review started this check. */
  reviewerId?: number;
}

/**
 * A status belongs to a commit, not to a pull request, so every PR with the same head commit shares it.
 * Only a check against the default branch may write "voxium/rules". Other base branches get their own name,
 * otherwise opening the commit against a branch with weak rules would turn the real check green.
 */
export function statusContext(baseRef: string, defaultBranch: string): string {
  return baseRef === defaultBranch ? "voxium/rules" : `voxium/rules (${baseRef})`;
}

export async function readProtected(token: string, fullName: string, sha: string): Promise<ProtectedContents> {
  const entries = await Promise.all(PROTECTED_FILES.map(async (p) => [p, await getFileAtRef(token, fullName, p, sha)] as const));
  return Object.fromEntries(entries);
}

/** The repo and its org, only when they belong to the installation the event came from. */
export async function knownRepo(env: Env, ev: Pick<PrEvent, "repoId" | "installationId">): Promise<{ repo: RepoRow; org: OrgRow } | null> {
  const repo = await getRepoByGithubId(env.DB, ev.repoId);
  const org = repo && (await getOrg(env.DB, repo.org_id));
  return repo && org?.installation_id === ev.installationId ? { repo, org } : null;
}

export interface Approval {
  kind: "approved" | "self_approved";
  login: string;
  reason: string | null;
}

/**
 * An Owner or Team Leader, with write access, whose approval covers this exact commit: from a GitHub review, or for
 * their own pull request given in Voxium by someone who is alone.
 * Standing and access are asked from GitHub now, so someone who left since signing in cannot approve.
 */
export async function findApprover(
  env: Env,
  token: string,
  ev: Pick<PrEvent, "fullName" | "number" | "headSha" | "baseRef" | "authorId">,
  known: { repo: RepoRow; org: OrgRow } | null,
): Promise<Approval | null> {
  if (!known) return null;
  for (const a of currentApprovals(await listReviews(token, ev.fullName, ev.number), ev.headSha, ev.authorId)) {
    const user = { github_id: a.id, login: a.login };
    const stored = await getRoleByGithubUser(env.DB, a.id, known.org.id);
    if (!stored || !canManage(resolveRole(await githubStanding(token, known.org, user), stored))) continue;
    const level = await githubRepoLevel(token, ev.fullName, user);
    if (level === "write" || level === "admin") return { kind: "approved", login: a.login, reason: a.reason };
  }
  const own = await getSelfApproval(env.DB, { repoId: known.repo.id, number: ev.number, headSha: ev.headSha, baseRef: ev.baseRef });
  if (own && own.github_id === ev.authorId) {
    const role = await getRoleByGithubUser(env.DB, own.github_id, known.org.id);
    if (!(await selfApprovalProblem(token, known.org, ev.fullName, own, role))) {
      return { kind: "self_approved", login: own.login, reason: own.reason };
    }
  }
  return null;
}

export interface Rules {
  base: ProtectedContents;
  mergeBase: ProtectedContents;
  head: ProtectedContents;
}

/** The protected files a PR is about, or null when its base branch is not set up. */
export async function readRules(token: string, ev: Pick<PrEvent, "fullName" | "baseRef" | "headSha">): Promise<Rules | null> {
  // Read the branch itself. The base commit in the event can be older than the current rules.
  const baseSha = await getBranchSha(token, ev.fullName, ev.baseRef);
  const base = await readProtected(token, ev.fullName, baseSha);
  if (!base[ARCH_FILE_PATH]) return null;
  const mergeBaseSha = await getMergeBase(token, ev.fullName, baseSha, ev.headSha);
  const [mergeBase, head] = await Promise.all([
    readProtected(token, ev.fullName, mergeBaseSha),
    readProtected(token, ev.fullName, ev.headSha),
  ]);
  return { base, mergeBase, head };
}

/** Whether a review can matter: the reviewer is known here and the PR has something to approve. */
async function reviewMatters(env: Env, token: string, ev: PrEvent, reviewerId: number): Promise<boolean> {
  const known = await knownRepo(env, ev);
  if (!known || !(await getRoleByGithubUser(env.DB, reviewerId, known.org.id))) return false;
  const rules = await readRules(token, ev);
  return rules !== null && findProtectedChanges(rules.base, rules.mergeBase, rules.head).length > 0;
}

/**
 * Check a pull request and report it as a commit status.
 * Source is streamed into memory for the check and dropped afterwards. Only results are stored.
 */
export async function runPullRequestCheck(ev: PrEvent): Promise<void> {
  const env = getEnv();
  let targetUrl = `${env.APP_URL}/dashboard`;
  const context = statusContext(ev.baseRef, ev.defaultBranch);

  let token: string;
  try {
    token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, ev.installationId);
  } catch (err) {
    console.error("voxium pr check could not authenticate", ev.fullName, ev.number, err);
    return;
  }
  const status = (state: PrCheckOutcome["state"] | "pending", text: string) =>
    setCommitStatus(token, ev.fullName, ev.headSha, context, state, text, targetUrl);

  let run: number;
  let known: { repo: RepoRow; org: OrgRow } | null;
  try {
    known = await knownRepo(env, ev);
    if (known) targetUrl = `${env.APP_URL}/repos/${known.repo.id}/pulls/${ev.number}`;
    // A review that cannot change anything must not disturb the status that is already there.
    if (ev.reviewerId !== undefined && !(await reviewMatters(env, token, ev, ev.reviewerId))) return;
    run = await beginCheck(env.DB, ev.repoId, ev.headSha, context);
  } catch (err) {
    console.error("voxium pr check could not start", ev.fullName, ev.number, err);
    // An approval may just have been withdrawn, so an earlier pass must not stay.
    await status("error", "Voxium could not complete the check.").catch(() => {});
    return;
  }
  /** Publish, unless a newer run has started. It knows more and will publish its own. */
  const publish = async (state: PrCheckOutcome["state"] | "pending", text: string): Promise<boolean> => {
    if (!(await isLatestCheck(env.DB, ev.repoId, ev.headSha, context, run))) return false;
    await status(state, text);
    return true;
  };

  let outcome: PrCheckOutcome;
  try {
    const rules = await readRules(token, ev);
    if (!rules) return; // repo not set up yet: say nothing

    if (!(await publish("pending", "Voxium is checking the architecture."))) return;
    const tree = await listTree(token, ev.fullName, ev.headSha);
    const headFiles = await readTarGz(await fetchTarball(token, ev.fullName, ev.headSha), { want: wantFile, expect: tree ?? undefined });

    const changes = findProtectedChanges(rules.base, rules.mergeBase, rules.head);
    const approval = changes.length ? await findApprover(env, token, ev, known) : null;
    const approvedBy = approval && (approval.kind === "self_approved" ? `${approval.login} (own pull request)` : approval.login);
    outcome = checkPullRequest({ headFiles, treePaths: tree && [...tree.keys()], ...rules, approvedBy });
    if (!(await publish(outcome.state, outcome.description))) return;
  } catch (err) {
    console.error("voxium pr check failed", ev.fullName, ev.number, err);
    await publish("error", "Voxium could not complete the check.").catch(() => {});
    return;
  }

  // The verdict is already published, so a storage problem must not change it.
  if (!known) return;
  try {
    await saveAnalysis(env.DB, {
      repo_id: known.repo.id,
      kind: "pr_check",
      commit_sha: ev.headSha,
      pr_number: ev.number,
      new_violations: outcome.newViolations.length,
      baseline_violations: outcome.baselineCount,
      summary: outcome,
    });
    // The default branch has rules, so it is set up, even if the event for that merge never arrived.
    if (ev.baseRef === ev.defaultBranch && known.repo.status !== "active") {
      await setRepoSetup(env.DB, known.repo.id, "active", known.repo.setup_pr_url);
    }
  } catch (err) {
    console.error("voxium could not store the check", ev.fullName, ev.number, err);
  }
}

export interface ClosedPr {
  installationId: number;
  repoId: number;
  fullName: string;
  defaultBranch: string;
  merged: boolean;
  url: string | null;
  number: number;
  title: string;
  authorId: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  mergedBy: string | null;
  closedAt: string;
}

/** Keep a repo's setup status in step with its setup pull request. */
export async function updateSetupStatus(ev: ClosedPr): Promise<void> {
  const env = getEnv();
  try {
    const known = await knownRepo(env, ev);
    if (!known || known.repo.status === "active") return;
    const { repo } = known;
    if (ev.merged) {
      // Any merge can bring the rules in, so ask the branch instead of trusting which pull request it was.
      const token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, ev.installationId);
      const sha = await getBranchSha(token, ev.fullName, ev.defaultBranch);
      if ((await getFileAtRef(token, ev.fullName, ARCH_FILE_PATH, sha)) !== null) {
        await setRepoSetup(env.DB, repo.id, "active", repo.setup_pr_url);
      }
    } else if (repo.status === "setup_pr_open" && ev.url !== null && ev.url === repo.setup_pr_url) {
      await setRepoSetup(env.DB, repo.id, "connected", null);
    }
  } catch (err) {
    console.error("voxium could not update the setup status", ev.fullName, err);
  }
}
