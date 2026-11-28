import { NextResponse, type NextRequest } from "next/server";
import { getEnv, waitUntil } from "@/lib/env";
import { getPull } from "@/lib/github";
import { openRepo } from "@/lib/open-repo";
import { proposalApprovalProblem } from "@/lib/proposals";
import { findRuleChanges, readRules, runPullRequestCheck } from "@/lib/repo-job";
import { fromThisSite } from "@/lib/same-origin";
import { cleanReason, MAX_REASON, selfApprovalProblem } from "@/lib/self-approval";
import { audit, getProposalByPr, saveSelfApproval, withdrawSelfApproval } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Approve, or take back approving, your own change to the rules, or a pull request Voxium wrote for a proposal. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; number: string }> }) {
  const env = getEnv();
  const { id, number } = await params;
  const back = (path: string, error?: string) => {
    const url = new URL(path, env.APP_URL);
    if (error) url.searchParams.set("error", error);
    return NextResponse.redirect(url, 303);
  };
  if (!fromThisSite(req, env.APP_URL)) return back("/dashboard", "That request did not come from Voxium.");
  const open = /^\d{1,10}$/.test(number) ? await openRepo(id) : null;
  if (!open) return back("/dashboard", "Pull request not found.");
  const { user, org, repo, role, token } = open;
  const page = `/repos/${repo.id}/pulls/${Number(number)}`;
  const form = await req.formData();
  const action = form.get("action");

  try {
    const pull = await getPull(token, repo.full_name, Number(number));
    if (!pull) return back("/dashboard", "Pull request not found.");
    const commit = { repoId: repo.id, number: pull.number, headSha: pull.head.sha, baseRef: pull.base.ref };
    const proposal = await getProposalByPr(env.DB, repo.id, pull.number);

    if (action === "withdraw") {
      await withdrawSelfApproval(env.DB, repo.id, pull.number, user.id);
      await audit(env.DB, org.id, user.id, "self_approval_withdrawn", `${pull.html_url} ${pull.head.sha}`);
    } else if (action === "approve") {
      if (pull.state !== "open") return back(page, "This pull request is closed.");
      if (!proposal && pull.user.id !== user.github_id) return back(page, "You did not write this pull request. Approve it with a GitHub review.");
      if (form.get("sha") !== pull.head.sha || form.get("base") !== pull.base.ref) {
        return back(page, "The pull request changed while you were reading it. Look at the changes again.");
      }
      const reason = cleanReason(form.get("reason"));
      if (!reason) return back(page, `Write a reason of at least a few words and at most ${MAX_REASON} characters.`);
      const own = proposal ? null : await selfApprovalProblem(token, org, repo.full_name, user, role);
      if (own) return back(page, own);
      const rules = await readRules(token, { fullName: repo.full_name, ...commit });
      if (!rules || !(await findRuleChanges(token, repo.full_name, rules, pull.head.sha)).length) {
        return back(page, "This pull request does not change the rules.");
      }
      // A proposal's approval also depends on the rules at the head, so it is judged once they are read.
      const problem = proposal && (await proposalApprovalProblem(token, org, repo, user, role, proposal, { authorId: pull.user.id, baseRef: pull.base.ref }, rules.head));
      if (problem) return back(page, problem);
      await saveSelfApproval(env.DB, commit, user.id, reason, proposal ? "proposal" : "self");
      await audit(env.DB, org.id, user.id, proposal ? "proposal_approved" : "self_approved", `${pull.html_url} ${pull.head.sha}`);
    } else {
      return back(page, "Unknown action.");
    }

    if (pull.state === "open") {
      waitUntil(
        runPullRequestCheck({
          installationId: org.installation_id,
          repoId: repo.github_repo_id,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch,
          number: pull.number,
          authorId: pull.user.id,
          authorLogin: pull.user.login,
          headSha: pull.head.sha,
          baseRef: pull.base.ref,
          headRef: pull.head.ref,
        }),
      );
    }
    return back(page);
  } catch (err) {
    console.error("approval failed", repo.full_name, number, err);
    return back(page, "Voxium could not confirm this with GitHub. Nothing was approved. Try again.");
  }
}
