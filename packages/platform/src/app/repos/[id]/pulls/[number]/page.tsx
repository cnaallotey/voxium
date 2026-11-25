import { describeRuleChanges, findProtectedChanges } from "@voxium/core";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getPull } from "@/lib/github";
import { openRepo } from "@/lib/open-repo";
import { findApprover, readRules } from "@/lib/repo-job";
import { MAX_REASON, selfApprovalProblem } from "@/lib/self-approval";
import { getSelfApproval, listAnalyses } from "@/lib/store";
import type { PrCheckOutcome } from "@/lib/analysis-types";

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
  const changed = rules ? findProtectedChanges(rules.base, rules.mergeBase, rules.head) : [];
  const changes = rules ? describeRuleChanges(rules.base, rules.head, changed) : [];
  const approval = changed.length
    ? await findApprover(env, token, { fullName: repo.full_name, authorId: pull.user.id, ...commit }, { repo, org })
    : null;
  const mine = pull.user.id === user.github_id;
  const own = mine ? await getSelfApproval(env.DB, commit) : null;
  const problem = mine && changed.length ? await selfApprovalProblem(token, org, repo.full_name, user, role) : null;
  const check = (await listAnalyses(env.DB, repo.id, 100)).find((a) => a.kind === "pr_check" && a.commit_sha === pull.head.sha && a.pr_number === pull.number);
  const outcome = check ? (JSON.parse(check.summary_json) as PrCheckOutcome) : null;

  return (
    <>
      <p className="muted">
        <a href="/dashboard">Dashboard</a> / <a href={`/repos/${repo.id}`}>{repo.full_name}</a> / #{pull.number}
      </p>
      <h1>{pull.title}</h1>
      <p className="muted">
        <a href={pull.html_url}>Open on GitHub</a> · by {pull.user.login} · into {pull.base.ref} · commit <code>{pull.head.sha.slice(0, 7)}</code>
        {pull.state === "closed" && ` · ${pull.merged ? "merged" : "closed"}`}
      </p>
      {error && <div className="card error">{error}</div>}

      {outcome && (
        <div className="card">
          <span className={`badge ${outcome.state === "success" ? "ok" : "bad"}`}>{outcome.state}</span> {outcome.description}
          {outcome.newViolations.map((v, i) => (
            <div key={i} style={{ marginTop: 6 }}>
              <code>{v.ruleId}</code> {v.file}
              <div className="muted">{v.message}</div>
            </div>
          ))}
        </div>
      )}

      {pull.state === "open" && (
        <>
          <h2>Changes to the rules</h2>
          {!rules && <p className="muted">Voxium is not set up on {pull.base.ref}.</p>}
          {rules && changed.length === 0 && <p className="muted">This pull request does not change the rules, so it needs no approval.</p>}
          {changed.length > 0 && (
            <div className="card">
              <ul>
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
              {approval.reason && <p style={{ whiteSpace: "pre-wrap" }}>{approval.reason}</p>}
              {own && (
                <form method="post" action={`/api/repos/${repo.id}/pulls/${pull.number}/approval`}>
                  <input type="hidden" name="action" value="withdraw" />
                  <button type="submit" className="secondary">Withdraw approval</button>
                </form>
              )}
            </div>
          ) : !mine ? (
            <p>An Owner or Team Leader with write access has to approve this commit in a GitHub review.</p>
          ) : problem ? (
            <p>{problem}</p>
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
