import { findProtectedChanges, PROTECTED_FILES, ARCH_FILE_PATH, type ProtectedContents } from "@voxium/core";
import { getEnv, type Env } from "./env";
import { checkPullRequest, wantFile, type PrCheckOutcome } from "./analysis";
import { currentApprovals } from "./approval";
import {
  canWrite,
  fetchTarball,
  getBranchSha,
  getFileAtRef,
  getInstallationToken,
  getMergeBase,
  listReviews,
  listTreePaths,
  setCommitStatus,
} from "./github";
import { readTarGz } from "./tar";
import { getOrg, getRepoByGithubId, getRoleByGithubUser, saveAnalysis, type RepoRow } from "./store";

export interface PrEvent {
  installationId: number;
  repoId: number;
  fullName: string;
  defaultBranch: string;
  number: number;
  authorId: number;
  headSha: string;
  baseRef: string;
}

/**
 * A status belongs to a commit, not to a pull request, so every PR with the same head commit shares it.
 * Only a check against the default branch may write "voxium/rules". Other base branches get their own name,
 * otherwise opening the commit against a branch with weak rules would turn the real check green.
 */
export function statusContext(baseRef: string, defaultBranch: string): string {
  return baseRef === defaultBranch ? "voxium/rules" : `voxium/rules (${baseRef})`;
}

async function readProtected(token: string, fullName: string, sha: string): Promise<ProtectedContents> {
  const entries = await Promise.all(PROTECTED_FILES.map(async (p) => [p, await getFileAtRef(token, fullName, p, sha)] as const));
  return Object.fromEntries(entries);
}

/** The repo row, only when it belongs to the installation the event came from. */
async function knownRepo(env: Env, ev: PrEvent): Promise<RepoRow | null> {
  const repo = await getRepoByGithubId(env.DB, ev.repoId);
  const org = repo && (await getOrg(env.DB, repo.org_id));
  return repo && org?.installation_id === ev.installationId ? repo : null;
}

/** Login of an Owner or Team Leader, with write access, whose approval covers this exact commit. */
async function findApprover(env: Env, token: string, ev: PrEvent, repo: RepoRow | null): Promise<string | null> {
  if (!repo) return null;
  for (const a of currentApprovals(await listReviews(token, ev.fullName, ev.number), ev.headSha, ev.authorId)) {
    const role = await getRoleByGithubUser(env.DB, a.id, repo.org_id);
    if ((role === "owner" || role === "team_leader") && (await canWrite(token, ev.fullName, a.login))) return a.login;
  }
  return null;
}

/**
 * Check a pull request and report it as a commit status.
 * Source is streamed into memory for the check and dropped afterwards. Only results are stored.
 */
export async function runPullRequestCheck(ev: PrEvent): Promise<void> {
  const env = getEnv();
  const targetUrl = `${env.APP_URL}/dashboard`;
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

  let outcome: PrCheckOutcome;
  let repo: RepoRow | null;
  try {
    // Read the branch itself. The base commit in the event can be older than the current rules.
    const baseSha = await getBranchSha(token, ev.fullName, ev.baseRef);
    const base = await readProtected(token, ev.fullName, baseSha);
    if (!base[ARCH_FILE_PATH]) return; // repo not set up yet: say nothing

    await status("pending", "Voxium is checking the architecture.");
    const mergeBaseSha = await getMergeBase(token, ev.fullName, baseSha, ev.headSha);
    const [mergeBase, head, treePaths] = await Promise.all([
      readProtected(token, ev.fullName, mergeBaseSha),
      readProtected(token, ev.fullName, ev.headSha),
      listTreePaths(token, ev.fullName, ev.headSha),
    ]);
    const headFiles = await readTarGz(await fetchTarball(token, ev.fullName, ev.headSha), { want: wantFile });

    repo = await knownRepo(env, ev);
    const approvedBy = findProtectedChanges(base, mergeBase, head).length ? await findApprover(env, token, ev, repo) : null;
    outcome = checkPullRequest({ headFiles, treePaths, base, mergeBase, head, approvedBy });
    await status(outcome.state, outcome.description);
  } catch (err) {
    console.error("voxium pr check failed", ev.fullName, ev.number, err);
    await status("error", "Voxium could not complete the check.").catch(() => {});
    return;
  }

  // The verdict is already published, so a storage problem must not change it.
  if (!repo) return;
  try {
    await saveAnalysis(env.DB, {
      repo_id: repo.id,
      kind: "pr_check",
      commit_sha: ev.headSha,
      pr_number: ev.number,
      new_violations: outcome.newViolations.length,
      baseline_violations: outcome.baselineCount,
      summary: outcome,
    });
  } catch (err) {
    console.error("voxium could not store the check", ev.fullName, ev.number, err);
  }
}
