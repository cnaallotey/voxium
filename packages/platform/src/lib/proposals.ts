import { isConfigPath, parseProposal, PROTECTED_FILES, type Architecture, type FileMap, type ProposalChange, type ProtectedContents } from "@voxium/core";
import { canManage, githubRepoLevel, githubStanding, resolveRole, type GithubUser } from "./access";
import type { ChangePlan } from "./change-pr";
import { toHex } from "./crypto";
import type { Env } from "./env";
import { listPullCommitPeople } from "./github";
import { code, plain } from "./markdown";
import type { PrEvent } from "./repo-job";
import { selfApprovalProblem } from "./self-approval";
import { audit, insertProposal, type OrgRow, type ProposalRow, type RepoRow, type Role } from "./store";

/** The branches of proposals' pull requests start with this, followed by the proposal's id. */
export const PROPOSAL_BRANCH = "voxium/proposal-";

/** At most this many proposal files are read from one pull request. */
export const MAX_IMPORTS = 20;

/** A file directly in voxium/proposals with a plain name. Config file names are left to the check, which reads those. */
export function isProposalPath(path: string): boolean {
  return /^voxium\/proposals\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/.test(path) && !isConfigPath(path);
}

/** Proposal files a pull request adds or changes, compared with where it branched off. The first few, in a fixed order. */
export function newProposalPaths(tree: ReadonlyMap<string, string>, baseTree: ReadonlyMap<string, string>): string[] {
  return [...tree]
    .filter(([p, sha]) => isProposalPath(p) && baseTree.get(p) !== sha)
    .map(([p]) => p)
    .sort()
    .slice(0, MAX_IMPORTS);
}

/** What a proposal asks for, and for a whole architecture a hash of the rules it was written against. */
export interface StoredChange extends ProposalChange {
  against?: string;
}

export function storedChange(p: Pick<ProposalRow, "change_json">): StoredChange | null {
  return p.change_json ? (JSON.parse(p.change_json) as StoredChange) : null;
}

/** A hash of the architecture file, to tell whether the rules changed since a proposal was written. */
export async function rulesHash(text: string | null | undefined): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text ?? "")));
}

/** A hash of the protected files of a commit, to tell whether a branch still has exactly the rules Voxium wrote on it. */
export async function protectedHash(contents: ProtectedContents): Promise<string> {
  // Files protected since the first three count only when they are there, so that hashes stored before stay the same.
  const values = PROTECTED_FILES.map((p) => contents[p] ?? null).filter((v, i) => i < 3 || v !== null);
  return rulesHash(JSON.stringify(values));
}

/** The architecture a proposal leads to, or null when it leaves the architecture as it is. */
export function proposedArchitecture(current: Architecture, change: ProposalChange | null): Architecture | null {
  if (change?.architecture) return change.architecture;
  if (change?.exception) return { ...current, exceptions: [...current.exceptions, change.exception] };
  return null;
}

/**
 * Save the proposals a pull request carries, when its author can write to the repo, so strangers' forks cannot fill the
 * list. Files that are not valid proposals are left out. The same file imported again is the same proposal.
 * Everyone who wrote or committed a commit of the pull request counts as having asked, as its author does, because any
 * of them may have put the file there. When GitHub cannot name them all, nothing is imported.
 */
export async function importProposals(
  env: Env,
  token: string,
  ev: Pick<PrEvent, "fullName" | "number" | "authorId" | "authorLogin">,
  known: { repo: RepoRow; org: OrgRow },
  files: FileMap,
  tree: ReadonlyMap<string, string>,
  mergeBaseArch: string | null | undefined,
): Promise<number> {
  const found = Object.keys(files)
    .sort()
    .flatMap((path) => {
      const res = parseProposal(files[path]);
      return res.ok ? [{ path, ...res.proposal }] : [];
    });
  if (!found.length || !ev.authorLogin) return 0;
  const level = await githubRepoLevel(token, ev.fullName, { github_id: ev.authorId, login: ev.authorLogin });
  if (level !== "write" && level !== "admin") return 0;
  const people = await listPullCommitPeople(token, ev.fullName, ev.number);
  if (!people) return 0;
  const co_requesters = [...new Set(people.map((p) => p.id).filter((id) => id !== ev.authorId))].sort((a, b) => a - b);
  const against = await rulesHash(mergeBaseArch);
  let added = 0;
  for (const p of found) {
    const id = await insertProposal(env.DB, {
      repo_id: known.repo.id,
      source: "pr",
      source_key: `${p.path}@${tree.get(p.path)}`,
      requester_github_id: ev.authorId,
      requester_login: ev.authorLogin,
      title: p.title,
      summary: p.summary,
      rationale: p.suggestedChange ? `${p.rationale}\n\nSuggested change: ${p.suggestedChange}` : p.rationale,
      change_json: p.change ? JSON.stringify({ ...p.change, ...(p.change.architecture ? { against } : {}) }) : null,
      co_requesters,
    });
    if (id === null) continue;
    added++;
    await audit(env.DB, known.org.id, null, "proposal_imported", `${known.repo.full_name} #${id} ${p.path}`);
  }
  return added;
}

/** The GitHub ids of everyone who counts as having asked for a proposal, or null when the row cannot say. */
export function requesters(p: Pick<ProposalRow, "requester_github_id" | "co_requesters">): Set<number> | null {
  let more: unknown;
  try {
    more = JSON.parse(p.co_requesters);
  } catch {
    return null;
  }
  if (!Array.isArray(more) || !more.every((n) => Number.isInteger(n))) return null;
  return new Set([p.requester_github_id, ...(more as number[])]);
}

/**
 * Why someone may not approve the pull request of a proposal, or null when they may: the head still has exactly the
 * rules Voxium wrote, and they are an Owner or Team Leader as GitHub confirms now, with write access, who did not ask for
 * the change, unless they are alone. Voxium wrote the pull request, so its author is not a person who could have
 * approved it. head is the protected files at the pull request's head.
 */
export async function proposalApprovalProblem(
  token: string,
  org: OrgRow,
  repo: RepoRow,
  user: GithubUser,
  storedRole: Role | null,
  proposal: Pick<ProposalRow, "requester_github_id" | "co_requesters" | "pr_rules">,
  pull: { authorId: number; baseRef: string },
  head: ProtectedContents,
): Promise<string | null> {
  if (pull.baseRef !== repo.default_branch) return "This pull request is not into the default branch.";
  // Anyone who can push may have changed them, and an approval is for the change Voxium wrote, not for theirs.
  if (!proposal.pr_rules || proposal.pr_rules !== (await protectedHash(head))) {
    return "The rules on this pull request are not the ones Voxium wrote for the proposal: a commit on its branch changed them. Close it and propose the change again.";
  }
  if (!storedRole || !canManage(resolveRole(await githubStanding(token, org, user), storedRole))) {
    return "Only an Owner or Team Leader can approve a proposal.";
  }
  const level = await githubRepoLevel(token, repo.full_name, user);
  if (level !== "write" && level !== "admin") return "You need write access to this repository.";
  const asked = requesters(proposal);
  if (!asked) return "Voxium cannot tell who asked for this proposal, so nobody can approve it.";
  if (asked.has(user.github_id) || user.github_id === pull.authorId) {
    if (await selfApprovalProblem(token, org, repo.full_name, user, storedRole)) {
      return "You asked for this change, so someone else has to approve it: another Owner, or a Team Leader.";
    }
  }
  return null;
}

export function proposalPrTitle(p: Pick<ProposalRow, "id" | "title">): string {
  const title = p.title.replace(/[\s\p{C}\p{Z}]+/gu, " ").trim().replace(/@/g, "@⁠");
  return `Voxium proposal #${p.id}: ${title.length > 100 ? `${title.slice(0, 97)}...` : title}`;
}

/**
 * Lines quoted as text. plain() leaves alone what only means something at the start of a line: a list item, a rule or
 * the underline of a heading, so those get escaped here.
 */
const quote = (text: string) =>
  text
    .split("\n")
    .map((l) => `> ${plain(l).replace(/^([-+=])/, "\\$1").replace(/^(\d+)([.)])/, "$1\\$2")}`.trimEnd())
    .join("\n");
const MAX_LISTED = 100;

function ids(list: string[]): string[] {
  return [...list.slice(0, MAX_LISTED).map((id) => `* ${code(id)}`), ...(list.length > MAX_LISTED ? [`* and ${list.length - MAX_LISTED} more`] : [])];
}

/** The pull request's description. Everything people wrote stays text: no headings, links, mentions or HTML. */
export function proposalPrBody(p: ProposalRow, plan: ChangePlan, opts: { branch: string; openedBy: string; pageUrl: string }): string {
  const fresh = plan.newViolations.map((v) => v.id);
  return [
    `Voxium proposal #${p.id}, asked for by ${plain(p.requester_login)} ${p.source === "pr" ? "in a file of a pull request" : "on Voxium"}. Opened by ${plain(opts.openedBy)}.`,
    "",
    `**${plain(p.title)}**`,
    "",
    quote(p.summary),
    "",
    "### Why",
    "",
    quote(p.rationale),
    "",
    "### What changes",
    "",
    ...plan.changes.map((c) => `* ${plain(c)}`),
    ...(plan.files["CLAUDE.md"] || plan.files["AGENTS.md"] ? ["* Regenerates the agent rules in CLAUDE.md and AGENTS.md"] : []),
    "",
    ...(plan.accepted.length
      ? [
          "### Accepted debt",
          "",
          plan.debtOnly
            ? `Accepts ${plan.accepted.length} violation(s) that fail on ${code(opts.branch)} under the current rules. Exactly these are added to voxium/baseline.json:`
            : `Accepts ${plan.accepted.length} violation(s) on ${code(opts.branch)} that these rules make new. Exactly these are added to voxium/baseline.json:`,
          "",
          ...ids(plan.accepted),
          "",
        ]
      : fresh.length
        ? [
            "### Violations this makes new",
            "",
            `${fresh.length} violation(s) on ${code(opts.branch)} would be new under these rules, so the check fails until they are fixed:`,
            "",
            ...ids(fresh),
            "",
          ]
        : []),
    ...(plan.preexisting.length
      ? [
          "### Already failing",
          "",
          `${plan.preexisting.length} violation(s) on ${code(opts.branch)} fail under the current rules too, so this change did not make them. It does not accept them:`,
          "",
          ...ids(plan.preexisting.map((v) => v.id)),
          "",
        ]
      : []),
    "### Approving",
    "",
    "GitHub reviews do not count for this pull request, because Voxium wrote it. An Owner or Team Leader with write access approves it in Voxium, with a reason, for one exact commit. Whoever asked for it cannot, unless they are alone in the organization.",
    "",
    opts.pageUrl,
    "",
  ].join("\n");
}

export const PROPOSAL_STATUS: Record<ProposalRow["status"], string> = {
  pending: "Pending",
  pr_open: "Pull request open",
  merged: "Merged",
  rejected: "Rejected",
};
