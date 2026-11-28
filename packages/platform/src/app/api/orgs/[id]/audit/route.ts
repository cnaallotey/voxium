import { NextResponse, type NextRequest } from "next/server";
import { auditCsv, isAction, MAX_EXPORT } from "@/lib/audit-export";
import { getEnv } from "@/lib/env";
import { openOwnedOrg } from "@/lib/open-org";
import { fromThisSite } from "@/lib/same-origin";
import { readForm } from "@/lib/setup";
import { audit, listAudit, type AuditRow } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Export an organization's audit log as CSV or JSON, newest first. For its Owners only, and logged itself. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const env = getEnv();
  const back = (path: string, error?: string) => {
    const url = new URL(path, env.APP_URL);
    if (error) url.searchParams.set("error", error);
    return NextResponse.redirect(url, 303);
  };
  if (!fromThisSite(req, env.APP_URL)) return back("/dashboard", "That request did not come from Voxium.");
  const open = await openOwnedOrg((await params).id);
  if (!open) return back("/dashboard", "Organization not found.");
  const { user, org } = open;
  const fields = await readForm(req);
  if (!fields) return back(`/orgs/${org.id}/audit`, "The form was too large or not sent from Voxium.");
  const value = (k: string) => fields.find(([name]) => name === k)?.[1];
  const format = value("format");
  if (format !== "csv" && format !== "json") return back(`/orgs/${org.id}/audit`, "Choose CSV or JSON.");
  const raw = value("action");
  const action = isAction(raw) ? raw : undefined;

  // The export is logged first, so that it is in the log it exports.
  await audit(env.DB, org.id, user.id, "audit_exported", `${format}${action ? ` of ${action}` : ""}`);
  const rows: AuditRow[] = [];
  for (let before: number | undefined; rows.length < MAX_EXPORT; ) {
    const page = await listAudit(env.DB, org.id, { before, action, limit: Math.min(1000, MAX_EXPORT - rows.length) });
    rows.push(...page);
    if (page.length < 1000) break;
    before = page.at(-1)!.id;
  }
  const name = `voxium-audit-${org.account_login.replace(/[^A-Za-z0-9-]/g, "_")}.${format}`;
  const body = format === "csv" ? auditCsv(rows) : `${JSON.stringify(rows, null, 2)}\n`;
  return new NextResponse(body, {
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
