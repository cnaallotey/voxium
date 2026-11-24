import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { getRepo, getRole, listAnalyses } from "@/lib/store";
import type { InferenceSummary, PrCheckOutcome } from "@/lib/analysis-types";

export const dynamic = "force-dynamic";

export default async function RepoPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/api/auth/login");
  const env = getEnv();
  const repo = await getRepo(env.DB, Number((await params).id));
  if (!repo) notFound();
  if (!(await getRole(env.DB, user.id, repo.org_id))) notFound();

  const analyses = await listAnalyses(env.DB, repo.id);
  const inference = analyses.find((a) => a.kind === "inference");
  const summary = inference ? (JSON.parse(inference.summary_json) as InferenceSummary) : null;
  const checks = analyses.filter((a) => a.kind === "pr_check");

  return (
    <>
      <p className="muted"><a href="/dashboard">Dashboard</a> / {repo.full_name}</p>
      <h1>{repo.full_name}</h1>
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
                PR #{c.pr_number} <span className={`badge ${o.state === "success" ? "ok" : "bad"}`}>{o.state}</span>
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
    </>
  );
}
