import { describeRuleChanges } from "@voxium/core";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getPull } from "@/lib/github";
import { openRepo } from "@/lib/open-repo";
import { proposalApprovalProblem } from "@/lib/proposals";
import { findApprover, findRuleChanges, readRules } from "@/lib/repo-job";
import { MAX_REASON, selfApprovalProblem } from "@/lib/self-approval";
import { getProposalByPr, getSelfApproval, getPrCheck } from "@/lib/store";
import type { StoredOutcome } from "@/lib/analysis-types";

import { ErrorNotice, Notice, PageHeader, StateBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string; number: string }>;
  searchParams: Promise<{ error?: string }>;
}

export default async function PullPage({ params, searchParams }: Props) {
  if (!(await currentUser())) redirect("/api/auth/login");
  const { id, number } = await params;
  const open = /^\d{1,10}$/.test(number) ? await openRepo(id) : null;
  if (!open) notFound();
  const { env, user, org, repo, role, token } = open;
  const pull = await getPull(token, repo.full_name, Number(number));
  if (!pull) notFound();
  const { error } = await searchParams;

  const commit = { repoId: repo.id, number: pull.number, headSha: pull.head.sha, baseRef: pull.base.ref };
  const rules = pull.state === "open" ? await readRules(token, { fullName: repo.full_name, ...commit }) : null;
  const changed = rules ? await findRuleChanges(token, repo.full_name, rules, pull.head.sha) : [];
  const changes = rules ? describeRuleChanges(rules.base, rules.head, changed) : [];
  const approval = changed.length
    ? await findApprover(env, token, { fullName: repo.full_name, authorId: pull.user.id, headRef: pull.head.ref, ...commit }, { repo, org }, rules!.head)
    : null;
  // Voxium wrote the pull request of a proposal, so only an approval given here counts for it.
  const proposal = await getProposalByPr(env.DB, repo.id, pull.number);
  const mine = !proposal && pull.user.id === user.github_id;
  const given = proposal ? await getSelfApproval(env.DB, commit, "proposal") : null;
  const own = proposal ? (given?.user_id === user.id ? given : null) : mine ? await getSelfApproval(env.DB, commit) : null;
  const problem = !changed.length || !rules
    ? null
    : proposal
      ? await proposalApprovalProblem(token, org, repo, user, role, proposal, { authorId: pull.user.id, baseRef: pull.base.ref }, rules.head)
      : mine
        ? await selfApprovalProblem(token, org, repo.full_name, user, role)
        : null;
  // Directly, however many checks of other pull requests came after it.
  const check = await getPrCheck(env.DB, repo.id, pull.number, pull.head.sha);
  const outcome = check ? (JSON.parse(check.summary_json) as StoredOutcome) : null;

  return (
    <>
      <PageHeader
        crumbs={[["Dashboard", "/dashboard"], [repo.full_name, `/repos/${repo.id}`], [`#${pull.number}`]]}
        title={pull.title}
        meta={
          <>
            <span className={`badge ${pull.state === "open" ? "info" : pull.merged ? "ok" : ""}`}>{pull.state === "open" ? "open" : pull.merged ? "merged" : "closed"}</span>
            <span>by {pull.user.login}</span>
            <span>into <code>{pull.base.ref}</code></span>
            <span>commit <code>{pull.head.sha.slice(0, 7)}</code></span>
          </>
        }
        actions={<a className="btn secondary" href={pull.html_url}>Open on GitHub</a>}
      />
      <ErrorNotice error={error} />
      {proposal && (
        <Notice tone="info">
          Voxium wrote this pull request for <a href={`/repos/${repo.id}/proposals/${proposal.id}`}>proposal #{proposal.id}</a>, asked for by{" "}
          {proposal.requester_login}.
        </Notice>
      )}

      <h2>Check</h2>
      {!outcome && <p className="muted">Voxium has not checked this commit yet.</p>}

      {outcome && (
        <div className="card">
          <StateBadge state={outcome.state} /> {outcome.description}
          {outcome.newViolations.map((v, i) => (
            <div className="violation" key={i}>
              <code>{v.ruleId}</code> {v.file}{v.line ? `:${v.line}` : ""}
              <div className="muted">{v.message}</div>
            </div>
          ))}
        </div>
      )}

      {outcome && (outcome.warnings ?? []).length > 0 && (
        <div className="card">
          <h3>Warnings, not blocking</h3>
          {outcome.warnings!.map((v, i) => (
            <div className="violation" key={i}>
              <code>{v.ruleId}</code> {v.file}{v.line ? `:${v.line}` : ""}
              <div className="muted">{v.message}</div>
            </div>
          ))}
          {(outcome.warningCount ?? 0) > outcome.warnings!.length && <p className="muted">And {outcome.warningCount! - outcome.warnings!.length} more.</p>}
        </div>
      )}

      {outcome?.warningsUnknown && (
        <div className="card">
          <h3>Warnings, not blocking</h3>
          <p className="muted">They could not be worked out, because the code where this pull request branched off could not be read.</p>
        </div>
      )}

      {pull.state === "open" && (
        <>
          <h2>Changes to the rules</h2>
          {!rules && <p className="muted">Voxium is not set up on {pull.base.ref}.</p>}
          {rules && changed.length === 0 && <p className="muted">This pull request does not change the rules, so it needs no approval.</p>}
          {changed.length > 0 && (
            <div className="card">
              <ul className="changes">
                {changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              <p className="muted">
                Files: {changed.join(", ")}. <a href={`${pull.html_url}/files`}>Read the full change on GitHub</a>
              </p>
            </div>
          )}
        </>
      )}

      {changed.length > 0 && (
        <>
          <h2>Approval</h2>
          {approval ? (
            <div className="card">
              <span className="badge ok">Approved</span> by {approval.login}
              {approval.kind === "self_approved" && ", for their own pull request"}
              {approval.reason && <p className="prewrap">{approval.reason}</p>}
              {own && (
                <form method="post" action={`/api/repos/${repo.id}/pulls/${pull.number}/approval`}>
                  <input type="hidden" name="action" value="withdraw" />
                  <button type="submit" className="secondary">Withdraw approval</button>
                </form>
              )}
            </div>
          ) : proposal ? (
            problem ? (
              <Notice tone="warn">GitHub reviews do not count for this pull request, because Voxium wrote it. {problem}</Notice>
            ) : (
              <form className="card" method="post" action={`/api/repos/${repo.id}/pulls/${pull.number}/approval`}>
                <p>
                  GitHub reviews do not count for this pull request, because Voxium wrote it. Approve it here, with a reason that is kept in the
                  decision log. It covers only commit <code>{pull.head.sha.slice(0, 7)}</code>, so a new push needs a new approval.
                </p>
                <input type="hidden" name="action" value="approve" />
                <input type="hidden" name="sha" value={pull.head.sha} />
                <input type="hidden" name="base" value={pull.base.ref} />
                <label>
                  Why should the rules change?
                  <textarea name="reason" required minLength={10} maxLength={MAX_REASON} rows={4} />
                </label>
                <button type="submit">Approve this change</button>
              </form>
            )
          ) : !mine ? (
            <Notice tone="info">An Owner or Team Leader with write access has to approve this commit in a GitHub review.</Notice>
          ) : problem ? (
            <Notice tone="warn">{problem}</Notice>
          ) : (
            <form className="card" method="post" action={`/api/repos/${repo.id}/pulls/${pull.number}/approval`}>
              <p>
                You wrote this pull request, and nobody else can approve it. You can, with a reason that is kept in the decision log. It
                covers only commit <code>{pull.head.sha.slice(0, 7)}</code>, so a new push needs a new approval.
              </p>
              <input type="hidden" name="action" value="approve" />
              <input type="hidden" name="sha" value={pull.head.sha} />
              <input type="hidden" name="base" value={pull.base.ref} />
              <label>
                Why should the rules change?
                <textarea name="reason" required minLength={10} maxLength={MAX_REASON} rows={4} />
              </label>
              <button type="submit">Approve this change</button>
            </form>
          )}
        </>
      )}
    </>
  );
}
