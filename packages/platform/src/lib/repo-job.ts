import {
  AGENT_FILES,
  blocksToCompare,
  changedBlocks,
  describeRuleChanges,
  expectedBlock,
  findProtectedChanges,
  isBlockLabel,
  isConfigPath,
  MAX_PROPOSAL_BYTES,
  PROTECTED_FILES,
  ARCH_FILE_PATH,
  type FileMap,
  type ProtectedContents,
} from "@voxium/core";
import { getEnv, type Env } from "./env";
import { checkPullRequest, locateNewCycles, settleWarnings, wantFile, type PrCheckOutcome, type StoredOutcome } from "./analysis";
import { canManage, githubRepoLevel, githubStanding, resolveRole } from "./access";
import { currentApprovals } from "./approval";
import { changedLines, commentOnPull } from "./comments";
import { importProposals, newProposalPaths, proposalApprovalProblem, PROPOSAL_BRANCH } from "./proposals";
import { selfApprovalProblem } from "./self-approval";
import {
  fetchTarball,
  getBranchSha,
  getFileAtRef,
  getInstallationToken,
  getMergeBase,
  listPullFiles,
  listReviews,
  listTree,
  setCommitStatus,
} from "./github";
import { readTarGz } from "./tar";
import { beginCheck, getOrg, getProposalByPr, getRepoByGithubId, getRoleByGithubUser, getSelfApproval, isLatestCheck, saveAnalysis, setRepoSetup, type OrgRow, type ProposalRow, type RepoRow } from "./store";

export interface PrEvent {
  installationId: number;
  repoId: number;
  fullName: string;
  defaultBranch: string;
  number: number;
  authorId: number;
  /** Needed to ask GitHub whether the author may write, before proposals in the pull request are imported. */
  authorLogin?: string;
  headSha: string;
  baseRef: string;
  /** The branch of the pull request, when the event says. */
  headRef?: string;
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
 * their own pull request given in Voxium by someone who is alone. A pull request Voxium wrote for a proposal counts
 * only an approval given in Voxium (see proposalApprover).
 * Standing and access are asked from GitHub now, so someone who left since signing in cannot approve.
 */
export async function findApprover(
  env: Env,
  token: string,
  ev: Pick<PrEvent, "fullName" | "number" | "headSha" | "baseRef" | "authorId" | "headRef">,
  known: { repo: RepoRow; org: OrgRow } | null,
  head: ProtectedContents,
): Promise<Approval | null> {
  if (!known) return null;
  const proposal = await getProposalByPr(env.DB, known.repo.id, ev.number);
  if (proposal) return proposalApprover(env, token, ev, known, proposal, head);
  // The pull request of a proposal exists a moment before Voxium records its number. GitHub reviews never count for it.
  if (ev.headRef?.startsWith(PROPOSAL_BRANCH)) return null;
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

/**
 * The approval of a proposal's pull request. Its author is Voxium, so GitHub reviews do not count: anyone holding a
 * Team Leader's token could submit one. Only an approval given in a Voxium session for this exact commit and base counts,
 * by someone who may give it now, while the head has the rules Voxium wrote (head is its protected files).
 */
async function proposalApprover(
  env: Env,
  token: string,
  ev: Pick<PrEvent, "number" | "headSha" | "baseRef" | "authorId">,
  known: { repo: RepoRow; org: OrgRow },
  proposal: ProposalRow,
  head: ProtectedContents,
): Promise<Approval | null> {
  const given = await getSelfApproval(env.DB, { repoId: known.repo.id, number: ev.number, headSha: ev.headSha, baseRef: ev.baseRef }, "proposal");
  if (!given) return null;
  const role = await getRoleByGithubUser(env.DB, given.github_id, known.org.id);
  if (await proposalApprovalProblem(token, known.org, known.repo, given, role, proposal, ev, head)) return null;
  return { kind: "approved", login: given.login, reason: given.reason };
}

export interface Rules {
  base: ProtectedContents;
  mergeBase: ProtectedContents;
  head: ProtectedContents;
  /** The commit where the PR branched off. */
  mergeBaseSha: string;
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
  return { base, mergeBase, head, mergeBaseSha };
}

/** What a check already has of the head and the merge base, so that agent files are only fetched when it lacks them. */
export interface KnownTrees {
  /** Agent files of the head that are at hand already. One that is missing here is fetched, unless the tree lacks it. */
  headFiles: FileMap;
  /** Every file of the head and of the merge base with its blob hash, when GitHub could list them. */
  tree: ReadonlyMap<string, string> | null;
  baseTree: ReadonlyMap<string, string> | null;
}

/**
 * Everything a pull request changes that needs approval: the protected files, and the agent files whose Voxium block it
 * altered. A block is only compared when the head's is not the one the judged rules give, and the merge base is only
 * read for files that differ from it. Throws when a file cannot be read, so that a check errors rather than passes.
 */
export async function findRuleChanges(token: string, fullName: string, rules: Rules, headSha: string, known?: KnownTrees): Promise<string[]> {
  const files = findProtectedChanges(rules.base, rules.mergeBase, rules.head);
  const block = expectedBlock(rules.base, rules.head, files);
  if (block === null) return files;
  const headAgents: ProtectedContents = {};
  for (const p of AGENT_FILES) {
    if (known && Object.hasOwn(known.headFiles, p)) headAgents[p] = known.headFiles[p];
    else headAgents[p] = known?.tree && !known.tree.has(p) ? null : await getFileAtRef(token, fullName, p, headSha);
  }
  // A file with the same blob at both commits has the same block at both, but only when the blob is what was read: the
  // archive keeps a regular file whose contents match its blob. A symlink is not kept, and its blob is only where it
  // points, while its contents are those of the file it points to, which can change while the link stays the same.
  const same = (p: string) =>
    !!known?.tree && !!known.baseTree && Object.hasOwn(known.headFiles, p) && known.tree.has(p) && known.tree.get(p) === known.baseTree.get(p);
  const compare = blocksToCompare(headAgents, block).filter((p) => !same(p));
  const earlier: ProtectedContents = {};
  for (const p of compare) earlier[p] = known?.baseTree && !known.baseTree.has(p) ? null : await getFileAtRef(token, fullName, p, rules.mergeBaseSha);
  return [...files, ...changedBlocks(compare, earlier, headAgents, block)];
}

/**
 * The files of an earlier commit that a filter wants, reading only what differs from the files at hand, and only when
 * something does. tree is the earlier commit's file list.
 */
async function readEarlier(
  token: string,
  fullName: string,
  sha: string,
  tree: ReadonlyMap<string, string>,
  laterTree: ReadonlyMap<string, string>,
  later: FileMap,
  want: (path: string) => boolean,
): Promise<FileMap> {
  const same = (p: string) => Object.hasOwn(later, p) && tree.get(p) === laterTree.get(p);
  const differ = [...tree.keys()].some((p) => want(p) && !same(p));
  const files = differ ? await readTarGz(await fetchTarball(token, fullName, sha), { want: (p) => want(p) && !same(p), expect: tree }) : {};
  for (const p of tree.keys()) if (want(p) && same(p)) files[p] = later[p];
  return files;
}

/**
 * The config files where a pull request branched off, which say what names stood for before it. Null when they cannot
 * all be listed and read: a config file left out could be the one whose mapping the pull request removes.
 */
async function readEarlierConfig(token: string, fullName: string, sha: string, tree: ReadonlyMap<string, string> | null, laterTree: ReadonlyMap<string, string>, later: FileMap): Promise<FileMap | null> {
  if (!tree) return null;
  const files = await readEarlier(token, fullName, sha, tree, laterTree, later, isConfigPath);
  return [...tree.keys()].every((p) => !isConfigPath(p) || Object.hasOwn(files, p)) ? files : null;
}

/** Whether a review can matter: the reviewer is known here and the PR has something to approve. */
async function reviewMatters(env: Env, token: string, ev: PrEvent, reviewerId: number): Promise<boolean> {
  const known = await knownRepo(env, ev);
  if (!known || !(await getRoleByGithubUser(env.DB, reviewerId, known.org.id))) return false;
  const rules = await readRules(token, ev);
  if (!rules) return false;
  return findProtectedChanges(rules.base, rules.mergeBase, rules.head).length > 0 || (await findRuleChanges(token, ev.fullName, rules, ev.headSha)).length > 0;
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
  let ruleChanges: string[];
  let importLater: (() => Promise<unknown>) | null = null;
  let readMergeBase: (() => Promise<{ files: FileMap; paths: string[] } | null>) | null = null;
  try {
    const rules = await readRules(token, ev);
    if (!rules) return; // repo not set up yet: say nothing

    if (!(await publish("pending", "Voxium is checking the architecture."))) return;
    const tree = await listTree(token, ev.fullName, ev.headSha);
    const baseTree = tree && (await listTree(token, ev.fullName, rules.mergeBaseSha));
    // Proposal files are read with their own small limit, so a pull request full of them cannot crowd out the code.
    const proposals = known && tree && baseTree && ev.baseRef === ev.defaultBranch ? newProposalPaths(tree, baseTree) : [];
    const proposalFiles: FileMap = {};
    const extra = proposals.length ? { want: (p: string) => proposals.includes(p), maxFileBytes: MAX_PROPOSAL_BYTES, into: proposalFiles } : undefined;
    // wantFile takes the agent files too, so that their Voxium block costs no request of its own.
    const headFiles = await readTarGz(await fetchTarball(token, ev.fullName, ev.headSha), { want: wantFile, expect: tree ?? undefined, extra });
    if (known && tree && proposals.length) {
      importLater = () => importProposals(env, token, ev, known!, proposalFiles, tree, rules.mergeBase[ARCH_FILE_PATH]);
    }

    const changes = await findRuleChanges(token, ev.fullName, rules, ev.headSha, { headFiles, tree, baseTree });
    const approval = changes.length ? await findApprover(env, token, ev, known, rules.head) : null;
    const approvedBy = approval && (approval.kind === "self_approved" ? `${approval.login} (own pull request)` : approval.login);
    ruleChanges = describeRuleChanges(rules.base, rules.head, changes);
    // What names stood for where the PR branched off still counts, so that it cannot remove a mapping to hide an import.
    const mergeBaseConfig = tree && (await readEarlierConfig(token, ev.fullName, rules.mergeBaseSha, baseTree, tree, headFiles));
    const blockChanges = changes.filter(isBlockLabel);
    const input = { headFiles, treePaths: tree && [...tree.keys()], base: rules.base, mergeBase: rules.mergeBase, head: rules.head, approvedBy, mergeBaseConfig, blockChanges };
    outcome = checkPullRequest(input);
    // With every path of that commit, so that its graph is built the way the head's is.
    readMergeBase = async () =>
      tree && baseTree ? { files: await readEarlier(token, ev.fullName, rules.mergeBaseSha, baseTree, tree, headFiles, wantFile), paths: [...baseTree.keys()] } : null;
    if (outcome.needsBase && tree && baseTree) {
      const earlier = (await readMergeBase())!;
      outcome = checkPullRequest({ ...input, mergeBaseFiles: earlier.files, mergeBasePaths: earlier.paths });
    }
    if (!(await publish(outcome.state, outcome.description))) return;
  } catch (err) {
    console.error("voxium pr check failed", ev.fullName, ev.number, err);
    await publish("error", "Voxium could not complete the check.").catch(() => {});
    return;
  }

  // Which warnings are new needs the code where the pull request branched off. They never change the verdict, which is
  // already published, so when that code cannot be read they are only said to be unknown.
  if (outcome.pendingWarnings) {
    let earlier: { files: FileMap; paths: string[] } | null = null;
    try {
      earlier = await readMergeBase!();
    } catch (err) {
      console.error("voxium could not read the code for warnings", ev.fullName, ev.number, err);
    }
    try {
      outcome = settleWarnings(outcome, earlier && earlier.files, earlier && earlier.paths);
    } catch (err) {
      console.error("voxium could not work out the warnings", ev.fullName, ev.number, err);
      outcome = settleWarnings(outcome, null);
    }
  }

  let diff: ReturnType<typeof listPullFiles> | undefined;
  const pullFiles = () => (diff ??= listPullFiles(token, ev.fullName, ev.number));
  if (outcome.cycles.size) {
    try {
      outcome = locateNewCycles(outcome, changedLines(await pullFiles()));
    } catch (err) {
      console.error("voxium could not read the diff", ev.fullName, ev.number, err);
    }
  }

  // The verdict is already published, so a storage problem must not change it.
  try {
    if (known) await storeCheck(env, ev, outcome, known.repo);
  } catch (err) {
    console.error("voxium could not store the check", ev.fullName, ev.number, err);
  }

  await commentOnPull(token, ev, outcome, {
    ruleChanges,
    pageUrl: known ? targetUrl : null,
    pullFiles,
    isLatest: () => isLatestCheck(env.DB, ev.repoId, ev.headSha, context, run),
  });

  // Last, so that it never changes the verdict.
  try {
    await importLater?.();
  } catch (err) {
    console.error("voxium could not import proposals", ev.fullName, ev.number, err);
  }
}

async function storeCheck(env: Env, ev: PrEvent, outcome: PrCheckOutcome, repo: RepoRow): Promise<void> {
  const { cycles: _, needsBase: __, pendingWarnings: ___, ...rest } = outcome;
  const summary: StoredOutcome = rest;
  await saveAnalysis(env.DB, {
    repo_id: repo.id,
    kind: "pr_check",
    commit_sha: ev.headSha,
    pr_number: ev.number,
    new_violations: outcome.newViolations.length,
    baseline_violations: outcome.baselineCount,
    summary,
  });
  // The default branch has rules, so it is set up, even if the event for that merge never arrived.
  if (ev.baseRef === ev.defaultBranch && repo.status !== "active") {
    await setRepoSetup(env.DB, repo.id, "active", repo.setup_pr_url);
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
