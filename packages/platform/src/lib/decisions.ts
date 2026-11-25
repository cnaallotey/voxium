import { ARCH_FILE_PATH, describeRuleChanges, findProtectedChanges } from "@voxium/core";
import { getEnv } from "./env";
import { getInstallationToken, getMergeBase } from "./github";
import { findApprover, knownRepo, readProtected, type ClosedPr } from "./repo-job";
import { saveDecision, type Decision, type DecisionKind } from "./store";

/**
 * Log a merged change to the rules: what changed, who approved it and why. A change that was merged without an
 * approval is logged too, because GitHub lets people merge past a check that is not required.
 */
export async function recordDecision(ev: ClosedPr): Promise<void> {
  if (!ev.merged) return;
  const env = getEnv();
  try {
    const known = await knownRepo(env, ev);
    if (!known) return;
    const token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, ev.installationId);
    const from = await getMergeBase(token, ev.fullName, ev.baseSha, ev.headSha);
    const [before, after] = await Promise.all([readProtected(token, ev.fullName, from), readProtected(token, ev.fullName, ev.headSha)]);
    const changed = findProtectedChanges(before, before, after);
    if (!changed.length) return;

    const isSetup = !before[ARCH_FILE_PATH];
    const approver = isSetup ? null : await findApprover(env, token, ev, known);
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
    });
  } catch (err) {
    console.error("voxium could not log the decision", ev.fullName, ev.number, err);
  }
}

export const DECISION_LABEL: Record<DecisionKind, string> = {
  setup: "Set up",
  approved: "Approved",
  self_approved: "Approved by its author",
  unapproved: "Merged without approval",
};

export const decisionPath = (d: Pick<Decision, "pr_number">) => `voxium/decisions/pr-${d.pr_number}.md`;

/** Text from people, kept from acting as Markdown headings, HTML or mentions. */
function plain(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[\\`*_{}[\]<>#|~!]/g, "\\$&").replace(/@/g, "@\u2060");
}

/** The decision as a file for the repo, so the log does not live only in the platform. */
export function renderDecision(d: Decision): string {
  const quote = d.reason ? d.reason.split("\n").map((l) => `> ${plain(l)}`.trimEnd()).join("\n") : "No reason was given.";
  return [
    `# ${plain(d.title)}`,
    "",
    `* Pull request: #${d.pr_number}`,
    `* Commit: ${d.head_sha}`,
    `* Merged: ${d.merged_at}${d.merged_by ? ` by ${plain(d.merged_by)}` : ""}`,
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
