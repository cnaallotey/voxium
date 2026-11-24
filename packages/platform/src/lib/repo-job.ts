import { getEnv } from "./env";
import { checkPullRequest, wantFile } from "./analysis";
import { fetchTarball, getFileAtRef, getInstallationToken, setCommitStatus } from "./github";
import { readTarGz } from "./tar";
import { getOrg, getRepoByFullName, saveAnalysis } from "./store";

export interface PrEvent {
  installationId: number;
  fullName: string;
  number: number;
  headSha: string;
  baseSha: string;
}

/**
 * Check a pull request and report it as the "voxium/rules" commit status.
 * Source is streamed into memory for the check and dropped afterwards. Only results are stored.
 */
export async function runPullRequestCheck(ev: PrEvent): Promise<void> {
  const env = getEnv();
  const cfg = { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY };
  const token = await getInstallationToken(cfg, ev.installationId);
  const targetUrl = `${env.APP_URL}/dashboard`;

  try {
    const [baseArch, baseBaseline, headArch] = await Promise.all([
      getFileAtRef(token, ev.fullName, "voxium/architecture.json", ev.baseSha),
      getFileAtRef(token, ev.fullName, "voxium/baseline.json", ev.baseSha),
      getFileAtRef(token, ev.fullName, "voxium/architecture.json", ev.headSha),
    ]);
    if (!baseArch) return; // repo not set up yet: say nothing

    await setCommitStatus(token, ev.fullName, ev.headSha, "pending", "Voxium is checking the architecture.", targetUrl);
    const files = await readTarGz(await fetchTarball(token, ev.fullName, ev.headSha), { want: wantFile });
    const outcome = checkPullRequest(files, baseArch, baseBaseline, headArch);

    await setCommitStatus(token, ev.fullName, ev.headSha, outcome.state, outcome.description, targetUrl);

    const repo = await getRepoByFullName(env.DB, ev.fullName);
    if (repo && (await getOrg(env.DB, repo.org_id))) {
      await saveAnalysis(env.DB, {
        repo_id: repo.id,
        kind: "pr_check",
        commit_sha: ev.headSha,
        pr_number: ev.number,
        new_violations: outcome.newViolations.length,
        baseline_violations: outcome.baselineCount,
        summary: outcome,
      });
    }
  } catch (err) {
    console.error("voxium pr check failed", ev.fullName, ev.number, err);
    await setCommitStatus(token, ev.fullName, ev.headSha, "error", "Voxium could not complete the check.", targetUrl).catch(() => {});
  }
}
