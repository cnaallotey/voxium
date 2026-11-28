import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { openManagedOrg } from "@/lib/open-org";
import { cleanNote, draftHash, MAX_NOTE, parseSetRules, setRules } from "@/lib/org-rules";
import { fromThisSite } from "@/lib/same-origin";
import { readForm } from "@/lib/setup";
import { audit, deleteOrgRuleDraft, getOrgRuleDraft, latestOrgRuleSet, saveOrgRuleDraft, saveOrgRuleSet } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Check and preview the next version of an organization's rule set, or save it. For Owners and Team Leaders whose
 * standing GitHub confirms now. Saving changes no repository: each takes a version through its own pull request.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const env = getEnv();
  const back = (path: string, error?: string) => {
    const url = new URL(path, env.APP_URL);
    if (error) url.searchParams.set("error", error);
    return NextResponse.redirect(url, 303);
  };
  if (!fromThisSite(req, env.APP_URL)) return back("/dashboard", "That request did not come from Voxium.");
  const open = await openManagedOrg((await params).id);
  if (!open) return back("/dashboard", "Organization not found.");
  const { user, org } = open;
  const page = `/orgs/${org.id}/rules`;
  const fields = await readForm(req);
  if (!fields) return back(page, "The form was too large or not sent from Voxium.");
  const value = (k: string) => fields.find(([name]) => name === k)?.[1];
  const current = await latestOrgRuleSet(env.DB, org.id);
  const version = current?.version ?? 0;

  if (value("action") === "check") {
    const parsed = parseSetRules(value("rules"));
    if (!parsed.ok) return back(page, parsed.errors.join(" ").slice(0, 900));
    // Debt a repository accepted under an id is debt of that rule; another type under the same id would turn it into
    // debt of something else.
    const retyped = parsed.rules.find((r) => setRules(current).some((c) => c.id === r.id && c.type !== r.type));
    if (retyped) return back(page, `Rule ${retyped.id} is a ${setRules(current).find((c) => c.id === retyped.id)!.type} rule in version ${version}. A rule that checks something else needs a new id.`.slice(0, 600));
    const note = cleanNote(value("note"));
    if (!note) return back(page, `Write why, in one line of 3 to ${MAX_NOTE} characters.`);
    await saveOrgRuleDraft(env.DB, { org_id: org.id, based_on: version, rules_json: parsed.text, note, user_id: user.id });
    return back(`${page}#preview`);
  }
  if (value("action") === "save") {
    const draft = await getOrgRuleDraft(env.DB, org.id);
    if (!draft) return back(page, "Check the rules first.");
    // What was previewed is what is saved: the same draft, on the same version.
    if (String(draft.based_on) !== value("based_on") || (await draftHash(draft)) !== value("draft")) return back(page, "The draft changed since you previewed it. Look at it again.");
    if (draft.based_on !== version) return back(page, `Version ${version} was saved since this draft was made. Check the rules again on top of it.`);
    const parsed = parseSetRules(draft.rules_json);
    if (!parsed.ok) return back(page, parsed.errors.join(" ").slice(0, 900));
    const saved = await saveOrgRuleSet(env.DB, { org_id: org.id, based_on: version, rules_json: parsed.text, note: draft.note, updated_by: user.id });
    if (saved === null) return back(page, "Someone saved a version at the same time. Check the rules again on top of it.");
    await deleteOrgRuleDraft(env.DB, org.id);
    await audit(env.DB, org.id, user.id, "org_rules_saved", `version ${saved}: ${draft.note}`);
    return back(page);
  }
  return back(page, "Unknown action.");
}
