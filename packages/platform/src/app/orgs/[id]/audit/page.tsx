import { notFound, redirect } from "next/navigation";
import { AUDIT_PAGE, isAction } from "@/lib/audit-export";
import { currentUser } from "@/lib/auth";
import { openOwnedOrg } from "@/lib/open-org";
import { auditActions, listAudit } from "@/lib/store";
import { Empty, ErrorNotice, OrgTabs, PageHeader, TableWrap } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ before?: string; action?: string; error?: string }>;
}

/** Who did what and when in an organization. For its Owners only, as GitHub confirms them now. */
export default async function AuditPage({ params, searchParams }: Props) {
  if (!(await currentUser())) redirect("/api/auth/login");
  const open = await openOwnedOrg((await params).id);
  if (!open) notFound();
  const { env, org } = open;
  const q = await searchParams;
  const action = isAction(q.action) ? q.action : undefined;
  const before = /^\d{1,15}$/.test(q.before ?? "") ? Number(q.before) : undefined;
  const rows = await listAudit(env.DB, org.id, { before, action, limit: AUDIT_PAGE + 1 });
  const page = rows.slice(0, AUDIT_PAGE);
  const actions = await auditActions(env.DB, org.id);
  const more = rows.length > AUDIT_PAGE ? `?${new URLSearchParams({ before: String(page.at(-1)!.id), ...(action ? { action } : {}) })}` : null;

  return (
    <>
      <PageHeader crumbs={[["Dashboard", "/dashboard"], [org.account_login, `/orgs/${org.id}/overview`], ["Audit log"]]} title="Audit log" lead="Who did what, and when, newest first." />
      <OrgTabs id={org.id} current="audit" role="owner" />
      <ErrorNotice error={q.error} />
      <div className="row">
        <form method="get" className="form-actions">
          <select name="action" defaultValue={action ?? ""} aria-label="Action">
            <option value="">Every action</option>
            {actions.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <button type="submit" className="secondary">Filter</button>
        </form>
        <form method="post" action={`/api/orgs/${org.id}/audit`} className="form-actions">
          {action && <input type="hidden" name="action" value={action} />}
          <button type="submit" name="format" value="csv" className="secondary">Export CSV</button>
          <button type="submit" name="format" value="json" className="secondary">Export JSON</button>
        </form>
      </div>
      <TableWrap>
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>
            {page.map((r) => (
              <tr key={r.id}>
                <td className="muted">{r.created_at}</td>
                <td>{r.login ?? <span className="muted">Voxium</span>}</td>
                <td><code>{r.action}</code></td>
                <td>{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {page.length === 0 && <Empty>Nothing logged{action ? " for this action" : ""}.</Empty>}
      {more && <p><a className="btn secondary" href={more}>Older entries</a></p>}
    </>
  );
}
