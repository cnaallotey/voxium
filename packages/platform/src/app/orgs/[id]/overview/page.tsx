import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { snapshotData } from "@/lib/snapshot-view";
import { getOrg, getRole, lastCheckAt, listReposForUser, newestSnapshots } from "@/lib/store";
import { Empty, OrgTabs, PageHeader, Stat, TableWrap } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/** Exceptions that run out within this many days are shown as expiring. */
const EXPIRING_DAYS = 14;

/**
 * Debt, exceptions and the last check of each repo of an organization that the person can open. Only the repos they
 * have access to are read, and nothing is added up across repos, so a repo they cannot open leaves no trace here.
 */
export default async function OverviewPage({ params }: Props) {
  const user = await currentUser();
  if (!user) redirect("/api/auth/login");
  const env = getEnv();
  const org = await getOrg(env.DB, Number((await params).id));
  const role = org && (await getRole(env.DB, user.id, org.id));
  if (!org || !role) notFound();
  const repos = await listReposForUser(env.DB, user.id, org.id);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const soon = new Date(now.getTime() + EXPIRING_DAYS * 86_400_000).toISOString().slice(0, 10);

  const rows = await Promise.all(
    repos.map(async (repo) => {
      const newest = await newestSnapshots(env.DB, repo.id);
      const row = newest.complete ?? newest.any;
      const data = snapshotData(row);
      const exceptions = data?.exceptions ?? [];
      return {
        repo,
        row,
        expired: exceptions.filter((e) => e.expires < today).length,
        expiring: exceptions.filter((e) => e.expires >= today && e.expires <= soon).length,
        checked: await lastCheckAt(env.DB, repo.id),
      };
    }),
  );

  return (
    <>
      <PageHeader
        crumbs={[["Dashboard", "/dashboard"], [org.account_login]]}
        title={org.account_login}
        lead={`The repositories of ${org.account_login} that you can open, with the debt on their default branch and the exceptions that run out.`}
      />
      <OrgTabs id={org.id} current="overview" role={role} />
      {rows.length > 0 && (
        <div className="stats">
          <Stat label="Repositories you can open" value={rows.length} />
          <Stat label="With new violations" value={rows.filter((r) => r.row?.complete === 1 && r.row.new_count > 0).length} tone={rows.some((r) => r.row?.complete === 1 && r.row.new_count > 0) ? "bad" : "ok"} />
          <Stat label="With expired exceptions" value={rows.filter((r) => r.expired > 0).length} tone={rows.some((r) => r.expired > 0) ? "bad" : undefined} />
          <Stat label="Not analysed yet" value={rows.filter((r) => !r.row).length} />
        </div>
      )}
      {rows.length === 0 && <Empty>There are no repositories here that you can open.</Empty>}
      {rows.length > 0 && (
        <TableWrap>
          <table>
            <thead>
              <tr><th>Repository</th><th>Debt</th><th>New</th><th>Exceptions</th><th>Last pull request check</th></tr>
            </thead>
            <tbody>
              {rows.map(({ repo, row, expired, expiring, checked }) => (
                <tr key={repo.id}>
                  <td><a href={`/repos/${repo.id}/drift`}>{repo.full_name}</a></td>
                  {row ? (
                    row.complete === 1 ? (
                      <>
                        <td>{row.baseline_count}</td>
                        <td>{row.new_count}</td>
                      </>
                    ) : (
                      <td colSpan={2}><span className="badge warn">incomplete</span></td>
                    )
                  ) : (
                    <td colSpan={2} className="muted">not analysed yet</td>
                  )}
                  <td>
                    {expired > 0 && <span className="badge bad">{expired} expired</span>} {expiring > 0 && <span className="badge warn">{expiring} expiring</span>}
                    {!expired && !expiring && <span className="muted">none running out</span>}
                  </td>
                  <td className="muted">{checked ?? "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}
