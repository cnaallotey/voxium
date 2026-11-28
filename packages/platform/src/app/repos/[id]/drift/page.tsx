import { notFound, redirect } from "next/navigation";
import { canManage } from "@/lib/access";
import { currentUser } from "@/lib/auth";
import { openRepo } from "@/lib/open-repo";
import { polyline, snapshotData } from "@/lib/snapshot-view";
import { blockedPerWeek, listSnapshots, newestSnapshots } from "@/lib/store";
import { Empty, ErrorNotice, Notice, PageHeader, RepoTabs, Stat, TableWrap } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

const W = 640;
const H = 180;

/** Drift of a repo over time: accepted debt and new violations on the default branch, debt by rule and module, exceptions. */
export default async function DriftPage({ params, searchParams }: Props) {
  if (!(await currentUser())) redirect("/api/auth/login");
  const open = await openRepo((await params).id);
  if (!open) notFound();
  const { env, repo, role, level } = open;
  const { error } = await searchParams;
  const rows = await listSnapshots(env.DB, repo.id);
  const weeks = await blockedPerWeek(env.DB, repo.id);
  const manager = canManage(role) && level !== "read";

  // An incomplete snapshot could say zero for what it did not read, so it is never part of the trend.
  const trend = rows.filter((r) => r.complete === 1);
  const max = Math.max(1, ...trend.map((r) => Math.max(r.baseline_count, r.new_count)));
  const newest = await newestSnapshots(env.DB, repo.id);
  const latest = snapshotData(newest.complete ?? newest.any);
  const today = new Date().toISOString().slice(0, 10);

  const counts = newest.complete;

  return (
    <>
      <PageHeader
        crumbs={[["Dashboard", "/dashboard"], [repo.full_name, `/repos/${repo.id}`], ["Drift"]]}
        title="Drift history"
        lead="The default branch is analysed after every merged pull request, by the rules it has. Accepted debt is in the baseline; new violations got past a check, for example when a pull request was merged without it."
        actions={
          manager && (
            <form method="post" action={`/api/repos/${repo.id}/snapshot`}>
              <button type="submit" className="secondary">Analyse now</button>
            </form>
          )
        }
      />
      <RepoTabs id={repo.id} current="drift" active={repo.status === "active"} manager={manager} />
      <ErrorNotice error={error} />

      {rows.length === 0 ? (
        <Empty>The default branch has not been analysed yet. It is after the next merged pull request{manager ? ", or now with Analyse now" : ""}.</Empty>
      ) : (
        <>
          {counts && (
            <div className="stats">
              <Stat label="Accepted debt" value={counts.baseline_count} />
              <Stat label="New violations" value={counts.new_count} tone={counts.new_count > 0 ? "bad" : "ok"} />
              <Stat label="Excepted" value={counts.excepted_count} />
              <Stat label="Warnings" value={counts.warn_count} />
            </div>
          )}
          {counts && <p className="muted small">From the analysis of <code>{counts.commit_sha.slice(0, 7)}</code> on {counts.created_at}.</p>}

          <h2>Trend</h2>
          {trend.length < 2 ? (
            <Empty>There is no trend yet: it needs two complete analyses of the default branch.</Empty>
          ) : (
            <div className="figure">
              <svg role="img" aria-labelledby="trend-title" viewBox={`-40 -10 ${W + 60} ${H + 40}`} width="100%" style={{ maxWidth: W + 60 }}>
                {/* One string: React leaves a title with several children empty. */}
                <title id="trend-title">
                  {`Accepted debt went from ${trend[0].baseline_count} to ${trend.at(-1)!.baseline_count}, and new violations from ${trend[0].new_count} to ${trend.at(-1)!.new_count}, over ${trend.length} analyses.`}
                </title>
                <line x1={0} y1={H} x2={W} y2={H} stroke="var(--line)" />
                <line x1={0} y1={0} x2={0} y2={H} stroke="var(--line)" />
                <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="var(--line)" strokeDasharray="2 4" />
                <text x={-8} y={4} textAnchor="end" fill="var(--muted)" fontSize={11}>{max}</text>
                <text x={-8} y={H} textAnchor="end" fill="var(--muted)" fontSize={11}>0</text>
                <polyline points={polyline(trend.map((r) => r.baseline_count), W, H, max)} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" />
                <polyline points={polyline(trend.map((r) => r.new_count), W, H, max)} fill="none" stroke="var(--bad)" strokeWidth={2.5} strokeDasharray="6 4" strokeLinejoin="round" />
                <text x={0} y={H + 24} fill="var(--accent)" fontSize={12}>── accepted debt</text>
                <text x={160} y={H + 24} fill="var(--bad)" fontSize={12}>- - new violations</text>
              </svg>
            </div>
          )}
          <h3>Every analysis</h3>
          <TableWrap>
            <table>
              <thead>
                <tr><th>Analysed</th><th>Commit</th><th className="num">Debt</th><th className="num">New</th><th className="num">Excepted</th><th className="num">Warnings</th></tr>
              </thead>
              <tbody>
                {[...rows].reverse().slice(0, 50).map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{r.created_at}</td>
                    <td><code>{r.commit_sha.slice(0, 7)}</code></td>
                    {r.complete === 1 ? (
                      <>
                        <td className="num">{r.baseline_count}</td><td className="num">{r.new_count}</td><td className="num">{r.excepted_count}</td><td className="num">{r.warn_count}</td>
                      </>
                    ) : (
                      <td colSpan={4}><span className="badge warn">incomplete</span> some code could not be read, so these counts are not known</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      )}

      {latest && (
        <>
          <h2>Debt by rule</h2>
          {!newest.complete && <Notice tone="warn"><span className="badge warn">incomplete</span> From an analysis that could not read all of the code.</Notice>}
          <TableWrap>
            <table>
              <thead><tr><th>Rule</th><th>Type</th><th className="num">Debt</th><th className="num">New</th><th className="num">Excepted</th><th className="num">Warnings</th></tr></thead>
              <tbody>
                {latest.rules.map((r) => (
                  <tr key={r.id}><td><code>{r.id}</code></td><td className="muted">{r.type}</td><td className="num">{r.baseline}</td><td className="num">{r.new}</td><td className="num">{r.excepted}</td><td className="num">{r.warn}</td></tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

          <h2>Debt by module</h2>
          <TableWrap>
            <table>
              <thead><tr><th>Module</th><th className="num">Files</th><th className="num">Debt</th></tr></thead>
              <tbody>
                {latest.modules.map((m) => (
                  <tr key={m.name}><td><code>{m.name}</code></td><td className="num">{m.files}</td><td className="num">{m.debt}</td></tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

          <h2>Exceptions by expiry</h2>
          {latest.exceptions.length === 0 ? (
            <Empty>No exceptions.</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead><tr><th>Runs out</th><th>Rule</th><th>Files</th><th>Owner</th></tr></thead>
                <tbody>
                  {latest.exceptions.map((e, i) => (
                    <tr key={i}>
                      <td>{e.expires < today ? <span className="badge bad">expired</span> : <span className="badge">until</span>} {e.expires}</td>
                      <td><code>{e.rule}</code></td>
                      <td>{e.file}</td>
                      <td className="muted">{e.owner}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </>
      )}

      <h2>Pull requests blocked, by week</h2>
      {weeks.length === 0 ? (
        <Empty>No pull request was blocked.</Empty>
      ) : (
        <TableWrap>
          <table>
            <thead><tr><th>Week</th><th className="num">Pull requests</th></tr></thead>
            <tbody>{weeks.map((w) => <tr key={w.week}><td>{w.week}</td><td className="num">{w.pulls}</td></tr>)}</tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}
