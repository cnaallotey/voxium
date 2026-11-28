import { notFound, redirect } from "next/navigation";
import { canManage } from "@/lib/access";
import { currentUser } from "@/lib/auth";
import { DECISION_LABEL } from "@/lib/decisions";
import { openRepo } from "@/lib/open-repo";
import { snapshotData } from "@/lib/snapshot-view";
import { latestInference, latestOrgRuleSet, listAnalyses, listDecisions, newestSnapshots } from "@/lib/store";
import type { InferenceSummary, StoredOutcome } from "@/lib/analysis-types";
import { Empty, ErrorNotice, Notice, PageHeader, RepoTabs, StateBadge } from "@/components/ui";

const STATUS: Record<string, { label: string; cls: string }> = {
  connected: { label: "Not set up", cls: "" },
  setup_pr_open: { label: "Setup PR open", cls: "warn" },
  active: { label: "Active", cls: "ok" },
};

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
  // Its own query, so it does not drop out of sight behind newer checks.
  const inference = await latestInference(env.DB, repo.id);
  const summary = inference ? (JSON.parse(inference.summary_json) as InferenceSummary) : null;
  const checks = analyses.filter((a) => a.kind === "pr_check");
  const manager = canManage(role) && level !== "read";
  const decisions = await listDecisions(env.DB, repo.github_repo_id);
  const orgSet = await latestOrgRuleSet(env.DB, open.org.id);
  const latest = snapshotData((await newestSnapshots(env.DB, repo.id)).any);
  const today = new Date().toISOString().slice(0, 10);

  const status = STATUS[repo.status] ?? STATUS.connected;
  const active = repo.status === "active";
  const behind = !!orgSet && !!latest && (latest.orgVersion ?? 0) < orgSet.version;

  return (
    <>
      <PageHeader
        crumbs={[["Dashboard", "/dashboard"], [repo.full_name]]}
        title={repo.full_name}
        meta={
          <>
            <span className={`badge ${status.cls}`}>{status.label}</span>
            <span>default branch <code>{repo.default_branch}</code></span>
            {latest && (latest.orgVersion !== null || orgSet) && (
              <span>
                Organization rules: {latest.orgVersion === null ? "not taken yet" : `version ${latest.orgVersion}`}
                {behind && <> <span className="badge warn">behind organization rules v{orgSet!.version}</span></>}
              </span>
            )}
          </>
        }
        actions={
          active ? (
            <a className="btn secondary" href={`/repos/${repo.id}/proposals#edit`}>Edit architecture</a>
          ) : manager ? (
            <a className="btn" href={`/repos/${repo.id}/setup`}>Review the setup</a>
          ) : null
        }
      />
      <RepoTabs id={repo.id} current="overview" active={active} manager={manager} />
      <ErrorNotice error={error} />

      {!active && (
        <Notice tone="info">
          Voxium is not set up on this repository yet.{" "}
          {manager ? "Review the inferred architecture, then open the setup pull request." : "An Owner or Team Leader with write access sets it up."}
          {repo.setup_pr_url && (
            <>
              {" "}Setup pull request: <a href={repo.setup_pr_url}>{repo.setup_pr_url}</a>
            </>
          )}
        </Notice>
      )}
      {active && repo.setup_pr_url && (
        <p className="muted small">
          Setup pull request: <a href={repo.setup_pr_url}>{repo.setup_pr_url}</a>
        </p>
      )}

      {latest && latest.overrides.length > 0 && (
        <div className="card">
          <h3>Overrides of organization rules</h3>
          {latest.overrides.map((o) => (
            <div key={o.rule}>
              <code>{o.rule}</code> is {o.action === "disable" ? "off" : "only a warning"} here until {o.expires} (owner {o.owner})
              {o.expires < today && <> <span className="badge bad">expired: the rule is enforced again</span></>}
            </div>
          ))}
        </div>
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
            <p className="muted small" key={n}>Note: {n}</p>
          ))}
        </>
      )}

      <h2>Recent pull request checks</h2>
      {checks.length === 0 && <Empty>No pull requests checked yet.</Empty>}
      {checks.map((c) => {
        const o = JSON.parse(c.summary_json) as StoredOutcome;
        return (
          <div className="card" key={c.id}>
            <div className="row">
              <span>
                <a className="item-title" href={`/repos/${repo.id}/pulls/${c.pr_number}`}>PR #{c.pr_number}</a> <StateBadge state={o.state} />
              </span>
              <span className="muted small">{c.created_at}</span>
            </div>
            <div className="muted">{o.description}</div>
            {o.newViolations.map((v, i) => (
              <div className="violation" key={i}>
                <code>{v.ruleId}</code> {v.file}{v.line ? `:${v.line}` : ""}
                <div className="muted">{v.message}</div>
              </div>
            ))}
          </div>
        );
      })}

      {active && manager && (
        <div className="card row" id="regenerate">
          <div>
            <h3>Generated files</h3>
            <p className="muted small">
              CLAUDE.md, AGENTS.md, the Cursor rules and the other generated files follow the rules on the default branch through a pull request.
            </p>
          </div>
          <form method="post" action={`/api/repos/${repo.id}/regenerate`}>
            <button type="submit" className="secondary">Regenerate files</button>
          </form>
        </div>
      )}

      <div className="row">
        <h2>Decision log</h2>
        {decisions.length > 0 && manager && (
          <form method="post" action={`/api/repos/${repo.id}/decisions`}>
            <button type="submit" className="secondary">Add to the repository</button>
          </form>
        )}
      </div>
      {decisions.length === 0 && <Empty>No changes to the rules have been merged yet.</Empty>}
      {decisions.map((d) => (
        <div className="card" key={d.pr_number}>
          <div className="row">
            <span>
              <a className="item-title" href={`https://github.com/${repo.full_name}/pull/${d.pr_number}`}>#{d.pr_number}</a> {d.title}{" "}
              <span className={`badge ${d.kind === "unapproved" ? "bad" : "ok"}`}>{DECISION_LABEL[d.kind]}</span>
            </span>
            <span className="muted small">{d.merged_at}</span>
          </div>
          <ul className="changes">
            {d.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          {d.reason && <p className="prewrap">{d.reason}</p>}
          <div className="muted small">
            {d.approved_by && `Approved by ${d.approved_by}. `}
            {d.merged_by && `Merged by ${d.merged_by}.`}
            {/* After a change to the rules the agent files may tell the old ones until they are regenerated. */}
            {d.kind !== "setup" && active && manager && (
              <>
                {" "}
                <a href="#regenerate">Regenerate the generated files</a> if this pull request did not.
              </>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
