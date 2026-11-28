import { snapshotOf } from "./analysis";
import { readBranch } from "./change-pr";
import { getEnv, type Env } from "./env";
import { getBranchSha, getInstallationToken } from "./github";
import { knownRepo } from "./repo-job";
import { audit, claimSnapshotRun, pruneHistory, saveSnapshot, type OrgRow, type RepoRow } from "./store";

/** How long a repo waits between snapshot runs, however many merges or clicks there are. */
export const SNAPSHOT_INTERVAL_MS = 60_000;

export type SnapshotOutcome = "saved" | "busy" | "not_set_up" | "unknown_repo" | "failed";

/** What a snapshot run is about: a repo by its GitHub id and installation, as a webhook names it. */
export interface SnapshotTarget {
  installationId: number;
  repoId: number;
  fullName: string;
  defaultBranch: string;
}

/**
 * Analyse the tip of a repo's default branch and save what it found as a snapshot, after a merge into it or when someone
 * asks. Only a repo Voxium knows under that installation, at most once a minute. Errors are logged and never touch a
 * status. `by` is the person who asked, for the audit log.
 */
export async function runSnapshot(target: SnapshotTarget, by?: { userId: number }, now: () => Date = () => new Date()): Promise<SnapshotOutcome> {
  const env = getEnv();
  let known: { repo: RepoRow; org: OrgRow } | null;
  try {
    // A webhook from another installation names a repo it does not own.
    known = await knownRepo(env, target);
    if (!known || known.repo.default_branch !== target.defaultBranch) return "unknown_repo";
    const started = now();
    if (!(await claimSnapshotRun(env.DB, known.repo.id, iso(started), iso(new Date(started.getTime() - SNAPSHOT_INTERVAL_MS))))) return "busy";
    if (by) await audit(env.DB, known.org.id, by.userId, "snapshot_run", target.fullName);
    return await analyse(env, target, known.repo, started);
  } catch (err) {
    console.error("voxium could not take a snapshot", target.fullName, err);
    return "failed";
  }
}

async function analyse(env: Env, target: SnapshotTarget, repo: RepoRow, started: Date): Promise<SnapshotOutcome> {
  const token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, target.installationId);
  const branch = await readBranch(token, target.fullName, repo.default_branch);
  const base = { repo_id: repo.id, created_at: iso(started) };
  if (!branch) {
    // GitHub could not list every file, so nothing can be said but that.
    const sha = await getBranchSha(token, target.fullName, repo.default_branch);
    await saveSnapshot(env.DB, { ...base, commit_sha: sha, complete: 0, new_count: 0, baseline_count: 0, excepted_count: 0, warn_count: 0, snapshot_json: "null" });
    await pruneHistory(env.DB, repo.id);
    return "saved";
  }
  const taken = snapshotOf(branch.files, branch.treePaths, branch.protectedFiles, started);
  if (!taken) return "not_set_up";
  await saveSnapshot(env.DB, {
    ...base,
    commit_sha: branch.sha,
    complete: taken.complete ? 1 : 0,
    new_count: taken.counts.new,
    baseline_count: taken.counts.baseline,
    excepted_count: taken.counts.excepted,
    warn_count: taken.counts.warn,
    snapshot_json: JSON.stringify(taken.snapshot),
  });
  await pruneHistory(env.DB, repo.id);
  return "saved";
}

/** As SQLite writes datetime('now'), so that both sort together. */
const iso = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
