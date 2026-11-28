import { ARCH_FILE_PATH, PROTECTED_FILES } from "@voxium/core";
import { NextResponse, type NextRequest } from "next/server";
import { canManage, githubStanding, resolveRole } from "@/lib/access";
import { describeUnchecked, parseArch } from "@/lib/analysis";
import { prepareChange, readBranch } from "@/lib/change-pr";
import { getEnv } from "@/lib/env";
import { BranchExistsError, createSetupPr } from "@/lib/github";
import { openRepo } from "@/lib/open-repo";
import { PROPOSAL_BRANCH, proposalPrBody, proposalPrTitle, proposedArchitecture, protectedHash, rulesHash, storedChange } from "@/lib/proposals";
import { fromThisSite } from "@/lib/same-origin";
import { cleanReason, MAX_REASON } from "@/lib/self-approval";
import { audit, claimProposal, getProposal, rejectProposal, releaseProposal, setProposalPr } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Decide on a proposal: open the pull request Voxium writes for it, or reject it with a reason. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; pid: string }> }) {
  const env = getEnv();
  const { id, pid } = await params;
  const back = (path: string, error?: string) => {
    const url = new URL(path, env.APP_URL);
    if (error) url.searchParams.set("error", error);
    return NextResponse.redirect(url, 303);
  };
  if (!fromThisSite(req, env.APP_URL)) return back("/dashboard", "That request did not come from Voxium.");
  const open = /^\d{1,10}$/.test(pid) ? await openRepo(id) : null;
  // Only proposals of this repo, so an id from another repo or installation finds nothing.
  const proposal = open && (await getProposal(env.DB, open.repo.id, Number(pid)));
  if (!open || !proposal) return back("/dashboard", "Proposal not found.");
  const { user, org, repo, role, level, token } = open;
  const page = `/repos/${repo.id}/proposals/${proposal.id}`;
  const form = await req.formData();
  const action = form.get("action");

  try {
    if (!canManage(resolveRole(await githubStanding(token, org, user), role)) || level === "read") {
      return back(page, "Only an Owner or Team Leader with write access can decide on proposals.");
    }
    if (action === "reject") {
      const reason = cleanReason(form.get("reason"));
      if (!reason) return back(page, `Write a reason of at least a few words and at most ${MAX_REASON} characters.`);
      if (!(await rejectProposal(env.DB, proposal.id, user.login, reason))) {
        return back(page, "Only a pending proposal can be rejected. Close its pull request on GitHub instead.");
      }
      await audit(env.DB, org.id, user.id, "proposal_rejected", `${repo.full_name} #${proposal.id}`);
      return back(page);
    }
    if (action !== "open_pr") return back(page, "Unknown action.");
    if (proposal.status !== "pending") return back(page, "This proposal is not pending.");
    const change = storedChange(proposal);
    if (!change?.architecture && !change?.exception && !change?.acceptDebt) {
      return back(page, "This proposal names no change to make. Propose one with the form.");
    }

    const branch = await readBranch(token, repo.full_name, repo.default_branch);
    if (!branch) return back(page, "The repository is too large to read completely.");
    const archText = branch.protectedFiles[ARCH_FILE_PATH];
    const current = parseArch(archText);
    if (!current) return back(page, "The rules on the default branch are missing or invalid.");
    // A whole architecture would quietly undo whatever changed since it was written.
    if (change.architecture && change.against !== (await rulesHash(archText))) {
      return back(page, "The rules changed since this proposal was made, and it replaces them as a whole. Reject it and propose again from the current rules.");
    }
    const plan = prepareChange(branch.files, branch.treePaths, branch.protectedFiles, proposedArchitecture(current, change), change.acceptDebt === true);
    if (plan.unchecked.length) {
      return back(page, `The default branch has ${describeUnchecked(plan.unchecked)} that cannot be read, for example ${plan.unchecked[0]}, so the change cannot be checked.`);
    }
    if (plan.expired) return back(page, "The proposed rules have exceptions that have run out, so every check would fail.");
    if (!Object.keys(plan.files).length) return back(page, "This proposal would not change anything.");

    // The protected files of the commit about to be written: the branch's, with the planned ones on top.
    const prRules = await protectedHash({
      ...branch.protectedFiles,
      ...Object.fromEntries(PROTECTED_FILES.filter((p) => Object.hasOwn(plan.files, p)).map((p) => [p, plan.files[p]])),
    });
    if (!(await claimProposal(env.DB, proposal.id, user.login))) return back(page, "This proposal is not pending any more.");
    const name = `${PROPOSAL_BRANCH}${proposal.id}`;
    let pr;
    try {
      pr = await createSetupPr(token, repo.full_name, repo.default_branch, plan.files, {
        title: proposalPrTitle(proposal),
        body: proposalPrBody(proposal, plan, { branch: repo.default_branch, openedBy: user.login, pageUrl: new URL(page, env.APP_URL).href }),
        branch: name,
        fresh: true,
        // On the commit the plan was made from, so that nothing merged since is quietly undone.
        baseSha: branch.sha,
      });
    } catch (err) {
      await releaseProposal(env.DB, proposal.id);
      if (err instanceof BranchExistsError) {
        return back(page, `A branch named ${name} exists already. Voxium only uses one it made itself: delete it on GitHub, then try again.`);
      }
      throw err;
    }
    await setProposalPr(env.DB, proposal.id, pr.number, prRules);
    await audit(env.DB, org.id, user.id, "proposal_pr", pr.url);
    return back(`/repos/${repo.id}/pulls/${pr.number}`);
  } catch (err) {
    console.error("proposal decision failed", repo.full_name, proposal.id, err);
    return back(page, "That did not work. Try again.");
  }
}
