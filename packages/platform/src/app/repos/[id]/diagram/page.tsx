import { notFound, redirect } from "next/navigation";
import type { Snapshot } from "@voxium/core";
import { currentUser } from "@/lib/auth";
import { openRepo } from "@/lib/open-repo";
import { snapshotData } from "@/lib/snapshot-view";
import { newestSnapshots } from "@/lib/store";
import { canManage } from "@/lib/access";
import { Empty, Notice, PageHeader, RepoTabs, TableWrap } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ module?: string }>;
}

/** Above this many modules the picture would be unreadable, so only the table is shown. */
const MAX_DRAWN_MODULES = 60;
const BOX_W = 130;
const BOX_H = 36;
const ROW_H = 96;
const WIDTH = 860;

const short = (name: string) => (name.length > 16 ? `${name.slice(0, 15)}…` : name);

/** Where each module's box goes: a row for each layer from the top, and one more for the modules outside the layers. */
function place(snapshot: Snapshot): Map<string, { x: number; y: number }> {
  const rows: string[][] = [];
  for (const m of snapshot.modules) {
    const row = m.layer ?? -1;
    if (row >= 0) (rows[row] ??= []).push(m.name);
  }
  const outside = snapshot.modules.filter((m) => m.layer === null).map((m) => m.name);
  const all = [...rows.filter(Boolean), ...(outside.length ? [outside] : [])];
  const at = new Map<string, { x: number; y: number }>();
  all.forEach((row, r) => {
    const gap = WIDTH / row.length;
    row.forEach((name, i) => at.set(name, { x: gap * i + gap / 2 - BOX_W / 2, y: r * ROW_H }));
  });
  return at;
}

/** The modules and the imports between them, as a picture and as a table, with the imports the rules forbid marked. */
export default async function DiagramPage({ params, searchParams }: Props) {
  if (!(await currentUser())) redirect("/api/auth/login");
  const open = await openRepo((await params).id);
  if (!open) notFound();
  const { env, repo, role, level } = open;
  const manager = canManage(role) && level !== "read";
  const { module: wanted } = await searchParams;
  const newest = await newestSnapshots(env.DB, repo.id);
  const row = newest.complete ?? newest.any;
  const snapshot = snapshotData(row);
  const header = (lead?: string) => (
    <>
      <PageHeader crumbs={[["Dashboard", "/dashboard"], [repo.full_name, `/repos/${repo.id}`], ["Diagram"]]} title="Diagram" lead={lead} />
      <RepoTabs id={repo.id} current="diagram" active={repo.status === "active"} manager={manager} />
    </>
  );
  if (!snapshot || !row) {
    return (
      <>
        {header()}
        <Empty>The default branch has not been analysed yet. It is after the next merged pull request, or with Analyse now on the drift page.</Empty>
      </>
    );
  }

  const focus = snapshot.modules.some((m) => m.name === wanted) ? wanted! : null;
  const edges = snapshot.edges.filter((e) => !focus || e.from === focus || e.to === focus);
  const drawn = snapshot.modules.length <= MAX_DRAWN_MODULES;
  const at = place(snapshot);
  const rowsUsed = Math.max(1, ...[...at.values()].map((p) => p.y / ROW_H + 1));
  const forbidden = edges.filter((e) => e.violating > 0);

  return (
    <>
      {header()}
      <p className="muted">
        Modules of the default branch at <code>{row.commit_sha.slice(0, 7)}</code>, layers from the top. An arrow is an import from one module into another; those the rules forbid are red, thick and dashed, with how many imports break them.
      </p>
      {row.complete !== 1 && <Notice tone="warn"><span className="badge warn">incomplete</span> Some code could not be read in this analysis, so imports may be missing.</Notice>}
      {snapshot.truncated && <Notice tone="info">There were too many imports between modules to keep them all: those the rules forbid are kept first.</Notice>}
      <p>
        {focus ? (
          <>
            Showing the imports of <code>{focus}</code> and into it. <a href={`/repos/${repo.id}/diagram`}>Show all</a>
          </>
        ) : (
          <span className="muted">Choose a module in the table to see only its imports.</span>
        )}
      </p>

      {drawn ? (
        <div className="figure">
          <svg role="img" aria-labelledby="diagram-title" viewBox={`-10 -10 ${WIDTH + 20} ${rowsUsed * ROW_H}`} width="100%">
            {/* One string: React leaves a title with several children empty. */}
            <title id="diagram-title">
              {`${snapshot.modules.length} modules and ${edges.length} imports between them, ${forbidden.length} of them forbidden by the rules. The table below lists them.`}
            </title>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
              </marker>
              <marker id="arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--bad)" />
              </marker>
            </defs>
            {edges.map((e) => {
              const a = at.get(e.from);
              const b = at.get(e.to);
              if (!a || !b) return null;
              const down = b.y >= a.y;
              const x1 = a.x + BOX_W / 2;
              const y1 = a.y + (down ? BOX_H : 0);
              const x2 = b.x + BOX_W / 2;
              const y2 = b.y + (down ? 0 : BOX_H);
              const bad = e.violating > 0;
              return (
                <g key={`${e.from}\u0000${e.to}`}>
                  <title>{`${e.from} imports ${e.to} ${e.imports} time(s)${bad ? `, ${e.violating} of them forbidden by the rules` : ""}`}</title>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={bad ? "var(--bad)" : "var(--muted)"} strokeWidth={bad ? 3 : 1} strokeDasharray={bad ? "7 4" : undefined} opacity={bad ? 1 : 0.6} markerEnd={`url(#${bad ? "arrow-bad" : "arrow"})`} />
                  {bad && (
                    <text x={(x1 + x2) / 2 + 4} y={(y1 + y2) / 2} fill="var(--bad)" fontSize={12} fontWeight={700}>
                      ✕ {e.violating}
                    </text>
                  )}
                </g>
              );
            })}
            {snapshot.modules.map((m) => {
              const p = at.get(m.name)!;
              return (
                <g key={m.name}>
                  <title>{`${m.name}: ${m.files} file(s), ${m.debt} accepted violation(s)`}</title>
                  <rect x={p.x} y={p.y} width={BOX_W} height={BOX_H} rx={8} fill="var(--panel)" stroke={m.name === focus ? "var(--accent)" : "var(--line)"} strokeWidth={m.name === focus ? 2 : 1} />
                  <text x={p.x + BOX_W / 2} y={p.y + BOX_H / 2 + 4} textAnchor="middle" fill="var(--text)" fontSize={12}>{short(m.name)}</text>
                </g>
              );
            })}
          </svg>
        </div>
      ) : (
        <Notice tone="info">With {snapshot.modules.length} modules the picture would be unreadable, so only the table is shown.</Notice>
      )}

      <h2>Imports between modules</h2>
      <TableWrap>
        <table>
          <thead><tr><th>From</th><th>To</th><th>Imports</th><th>Forbidden by the rules</th></tr></thead>
          <tbody>
            {edges.map((e) => (
              <tr key={`${e.from}\u0000${e.to}`}>
                <td><a href={`/repos/${repo.id}/diagram?module=${encodeURIComponent(e.from)}`}><code>{e.from}</code></a></td>
                <td><a href={`/repos/${repo.id}/diagram?module=${encodeURIComponent(e.to)}`}><code>{e.to}</code></a></td>
                <td>{e.imports}</td>
                <td>{e.violating > 0 ? <span className="badge bad">{e.violating} forbidden</span> : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {edges.length === 0 && <Empty>No imports between modules.</Empty>}
    </>
  );
}
