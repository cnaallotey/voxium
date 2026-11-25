import { notFound, redirect } from "next/navigation";
import { canManage } from "@/lib/access";
import { currentUser } from "@/lib/auth";
import { DECISION_LABEL } from "@/lib/decisions";
import { openRepo } from "@/lib/open-repo";
import { listAnalyses, listDecisions } from "@/lib/store";
import type { InferenceSummary, PrCheckOutcome } from "@/lib/analysis-types";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

export default async function RepoPage({ params, searchParams }: Props) {
  if (!(await currentUser())) redirect("/api/auth/login");
  // Asks GitHub now. Results name files and rules, so they are only for people who can open the repo.
  const open = await openRepo((await params).id);
  if (!open) notFound();
  const { env, repo, role, level } = open;
  const { error } = await searchParams;

  const analyses = await listAnalyses(env.DB, repo.id);
  const inference = analyses.find((a) => a.kind === "inference");
  const summary = inference ? (JSON.parse(inference.summary_json) as InferenceSummary) : null;
  const checks = analyses.filter((a) => a.kind === "pr_check");
  const decisions = await listDecisions(env.DB, repo.github_repo_id);

  return (
    <>
      <p className="muted"><a href="/dashboard">Dashboard</a> / {repo.full_name}</p>
      <h1>{repo.full_name}</h1>
      {error && <div className="card error">{error}</div>}
      {repo.setup_pr_url && (
        <p>
          Setup pull request: <a href={repo.setup_pr_url}>{repo.setup_pr_url}</a>
        </p>
      )}

      {summary && (
        <>
          <h2>Inferred architecture</h2>
          <p className="muted">
            Confidence {(summary.confidence * 100).toFixed(0)}% · {summary.files} files · {summary.existingViolations} existing violation(s) recorded as baseline
          </p>
          <div className="layers">
            {summary.layers.map((l, i) => (
              <div className="layer" key={l}>
                <strong>{i + 1}. {l}</strong> <span className="muted">{(summary.modules[l] ?? []).join(", ")}</span>
              </div>
            ))}
          </div>
          {summary.notes.map((n) => (
            <p className="muted" key={n}>Note: {n}</p>
          ))}
        </>
      )}

      <h2>Recent pull request checks</h2>
      {checks.length === 0 && <p className="muted">No pull requests checked yet.</p>}
      {checks.map((c) => {
        const o = JSON.parse(c.summary_json) as PrCheckOutcome;
        return (
          <div className="card" key={c.id}>
            <div className="row">
              <span>
                <a href={`/repos/${repo.id}/pulls/${c.pr_number}`}>PR #{c.pr_number}</a> <span className={`badge ${o.state === "success" ? "ok" : "bad"}`}>{o.state}</span>
              </span>
              <span className="muted">{c.created_at}</span>
            </div>
            <div className="muted">{o.description}</div>
            {o.newViolations.map((v, i) => (
              <div key={i} style={{ marginTop: 6 }}>
                <code>{v.ruleId}</code> {v.file}
                <div className="muted">{v.message}</div>
              </div>
            ))}
          </div>
        );
      })}

      <div className="row">
        <h2>Decision log</h2>
        {decisions.length > 0 && canManage(role) && level !== "read" && (
          <form method="post" action={`/api/repos/${repo.id}/decisions`}>
            <button type="submit" className="secondary">Add to the repository</button>
          </form>
        )}
      </div>
      {decisions.length === 0 && <p className="muted">No changes to the rules have been merged yet.</p>}
      {decisions.map((d) => (
        <div className="card" key={d.pr_number}>
          <div className="row">
            <span>
              <a href={`https://github.com/${repo.full_name}/pull/${d.pr_number}`}>#{d.pr_number}</a> {d.title}{" "}
              <span className={`badge ${d.kind === "unapproved" ? "bad" : "ok"}`}>{DECISION_LABEL[d.kind]}</span>
            </span>
            <span className="muted">{d.merged_at}</span>
          </div>
          <ul>
            {d.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          {d.reason && <p style={{ whiteSpace: "pre-wrap" }}>{d.reason}</p>}
          <div className="muted">
            {d.approved_by && `Approved by ${d.approved_by}. `}
            {d.merged_by && `Merged by ${d.merged_by}.`}
          </div>
        </div>
      ))}
    </>
  );
}
