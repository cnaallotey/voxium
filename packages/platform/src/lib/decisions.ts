import { ARCH_FILE_PATH, describeRuleChanges } from "@voxium/core";
import { getEnv } from "./env";
import { getInstallationToken, getMergeBase } from "./github";
import { plain } from "./markdown";
import { findApprover, findRuleChanges, knownRepo, readProtected, type ClosedPr, type PrEvent } from "./repo-job";
import { closeProposal, getProposalByPr, reopenProposal, saveDecision, type Decision, type DecisionKind } from "./store";

/**
 * Log a merged change to the rules: what changed, who asked for it, who approved it and why. A change that was merged
 * without an approval is logged too, because GitHub lets people merge past a check that is not required. Closing the
 * pull request of a proposal decides the proposal.
 */
export async function recordDecision(ev: ClosedPr): Promise<void> {
  const env = getEnv();
  try {
    const known = await knownRepo(env, ev);
    if (!known) return;
    const proposal = await getProposalByPr(env.DB, known.repo.id, ev.number);
    if (proposal) await closeProposal(env.DB, proposal.id, ev.merged);
    if (!ev.merged) return;
    const token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, ev.installationId);
    const from = await getMergeBase(token, ev.fullName, ev.baseSha, ev.headSha);
    const [before, after] = await Promise.all([readProtected(token, ev.fullName, from), readProtected(token, ev.fullName, ev.headSha)]);
    const changed = await findRuleChanges(token, ev.fullName, { base: before, mergeBase: before, head: after, mergeBaseSha: from }, ev.headSha);
    if (!changed.length) return;

    const isSetup = !before[ARCH_FILE_PATH];
    const approver = isSetup ? null : await findApprover(env, token, ev, known, after);
    const kind: DecisionKind = isSetup ? "setup" : (approver?.kind ?? "unapproved");
    await saveDecision(env.DB, {
      github_repo_id: ev.repoId,
      pr_number: ev.number,
      kind,
      title: ev.title,
      changes: describeRuleChanges(before, after, changed),
      reason: approver?.reason ?? null,
      approved_by: approver?.login ?? null,
      merged_by: ev.mergedBy,
      head_sha: ev.headSha,
      merged_at: ev.closedAt,
      proposed_by: proposal?.requester_login ?? null,
    });
  } catch (err) {
    console.error("voxium could not log the decision", ev.fullName, ev.number, err);
  }
}

/** A reopened pull request of a proposal makes the proposal open again, which closing it had made rejected. */
export async function recordReopened(ev: Pick<PrEvent, "repoId" | "installationId" | "number">): Promise<void> {
  const env = getEnv();
  try {
    const known = await knownRepo(env, ev);
    if (known) await reopenProposal(env.DB, known.repo.id, ev.number);
  } catch (err) {
    console.error("voxium could not reopen the proposal", ev.repoId, ev.number, err);
  }
}

export const DECISION_LABEL: Record<DecisionKind, string> = {
  setup: "Set up",
  approved: "Approved",
  self_approved: "Approved by its author",
  unapproved: "Merged without approval",
};

export const decisionPath = (d: Pick<Decision, "pr_number">) => `voxium/decisions/pr-${d.pr_number}.md`;

/** The decision as a file for the repo, so the log does not live only in the platform. */
export function renderDecision(d: Decision): string {
  const quote = d.reason ? d.reason.split("\n").map((l) => `> ${plain(l)}`.trimEnd()).join("\n") : "No reason was given.";
  return [
    `# ${plain(d.title)}`,
    "",
    `* Pull request: #${d.pr_number}`,
    `* Commit: ${d.head_sha}`,
    `* Merged: ${d.merged_at}${d.merged_by ? ` by ${plain(d.merged_by)}` : ""}`,
    ...(d.proposed_by ? [`* Proposed by: ${plain(d.proposed_by)}`] : []),
    `* Decision: ${DECISION_LABEL[d.kind]}${d.approved_by ? ` (${plain(d.approved_by)})` : ""}`,
    "",
    "## What changed",
    "",
    ...d.changes.map((c) => `* ${plain(c)}`),
    "",
    "## Why",
    "",
    quote,
    "",
  ].join("\n");
}
