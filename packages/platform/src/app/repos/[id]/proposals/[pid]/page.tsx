import { ARCH_FILE_PATH, describeRuleChanges, findProtectedChanges, type ProtectedContents } from "@voxium/core";
import { notFound, redirect } from "next/navigation";
import { canManage, githubStanding, resolveRole } from "@/lib/access";
import { parseArch } from "@/lib/analysis";
import { currentUser } from "@/lib/auth";
import { getBranchSha } from "@/lib/github";
import { openRepo } from "@/lib/open-repo";
import { PROPOSAL_STATUS, proposedArchitecture, rulesHash, storedChange } from "@/lib/proposals";
import { readProtected } from "@/lib/repo-job";
import { MAX_REASON } from "@/lib/self-approval";
import { getProposal } from "@/lib/store";
import { ErrorNotice, Notice, PageHeader, ProposalBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string; pid: string }>;
  searchParams: Promise<{ error?: string }>;
}

export default async function ProposalPage({ params, searchParams }: Props) {
  if (!(await currentUser())) redirect("/api/auth/login");
  const { id, pid } = await params;
  const open = /^\d{1,10}$/.test(pid) ? await openRepo(id) : null;
  const proposal = open && (await getProposal(open.env.DB, open.repo.id, Number(pid)));
  if (!open || !proposal) notFound();
  const { user, org, repo, role, level, token } = open;
  const { error } = await searchParams;
  const change = storedChange(proposal);
  const pending = proposal.status === "pending";
  const manager = pending && level !== "read" && canManage(resolveRole(await githubStanding(token, org, user), role));

  // What it would do to the rules as they are now.
  let preview: string[] = [];
  let stale = false;
  if (pending && change) {
    const before: ProtectedContents = await readProtected(token, repo.full_name, await getBranchSha(token, repo.full_name, repo.default_branch));
    const current = parseArch(before[ARCH_FILE_PATH]);
    const next = current && proposedArchitecture(current, change);
    if (next) {
      const after = { ...before, [ARCH_FILE_PATH]: `${JSON.stringify(next, null, 2)}\n` };
      preview = describeRuleChanges(before, after, findProtectedChanges(before, before, after));
    }
    stale = !!change.architecture && change.against !== (await rulesHash(before[ARCH_FILE_PATH]));
  }
  const action = `/api/repos/${repo.id}/proposals/${proposal.id}`;

  return (
    <>
      <PageHeader
        crumbs={[["Dashboard", "/dashboard"], [repo.full_name, `/repos/${repo.id}`], ["Proposals", `/repos/${repo.id}/proposals`], [`#${proposal.id}`]]}
        title={proposal.title}
        meta={
          <>
            <ProposalBadge status={proposal.status} label={PROPOSAL_STATUS[proposal.status]} />
            <span>
              Asked for by {proposal.requester_login} {proposal.source === "pr" ? "in a file of a pull request" : "on Voxium"}
            </span>
            <span>{proposal.created_at}</span>
          </>
        }
      />
      <ErrorNotice error={error} />

      <div className="card">
        <p className="prewrap">{proposal.summary}</p>
        <h3>Why</h3>
        <p className="prewrap">{proposal.rationale}</p>
      </div>

      {proposal.pr_number !== null && (
        <Notice tone="info">
          Pull request: <a href={`/repos/${repo.id}/pulls/${proposal.pr_number}`}>#{proposal.pr_number}</a>
          {proposal.decided_by && `, opened by ${proposal.decided_by}`}
        </Notice>
      )}
      {proposal.status === "rejected" && (
        <Notice tone="error">
          Rejected{proposal.decided_by && ` by ${proposal.decided_by}`}
          {proposal.decided_reason && <p className="prewrap">{proposal.decided_reason}</p>}
        </Notice>
      )}

      {pending && (
        <>
          <h2>What it changes</h2>
          {!change && <p className="muted">It names no change, only words. Someone can propose a concrete change with the form.</p>}
          {stale && <p className="error">The rules changed since this proposal was made. It replaces them as a whole, so it cannot be opened as it is.</p>}
          {preview.length > 0 && (
            <ul className="card changes">
              {preview.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          {change?.acceptDebt && (
            <p>Accepts as debt the violations on {repo.default_branch} that the rules would make new. The pull request names each of them.</p>
          )}
        </>
      )}

      {manager && change && !stale && (
        <form method="post" action={action} className="form-actions">
          <input type="hidden" name="action" value="open_pr" />
          <button type="submit">Open a pull request</button>
          <span className="muted small">Voxium writes it on a new branch, on top of the commit it checks.</span>
        </form>
      )}
      {manager && (
        <form className="card" method="post" action={action}>
          <h3>Reject</h3>
          <input type="hidden" name="action" value="reject" />
          <label>
            Why not?
            <textarea name="reason" required minLength={10} maxLength={MAX_REASON} rows={3} />
          </label>
          <button type="submit" className="danger">Reject</button>
        </form>
      )}
    </>
  );
}
