import { NextResponse, type NextRequest } from "next/server";
import { githubStanding } from "@/lib/access";
import { getEnv } from "@/lib/env";
import { openOwnedOrg } from "@/lib/open-org";
import { fromThisSite } from "@/lib/same-origin";
import { audit, listPeople, setTeamLeader } from "@/lib/store";

export const dynamic = "force-dynamic";

/** An Owner makes someone a Team Leader, or takes it away. */
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
  const { user, org, token } = open;
  const page = `/orgs/${org.id}`;
  const form = await req.formData();
  const role = form.get("role");
  if (role !== "team_leader" && role !== "member") return back(page, "Unknown role.");
  if (org.account_type !== "Organization") return back(page, "A personal account cannot have Team Leaders.");
  const person = (await listPeople(env.DB, org.id)).find((p) => String(p.user_id) === form.get("user"));
  if (!person) return back(page, "That person has not signed in to Voxium.");

  try {
    // Taking the role away must also work for someone who has already left.
    if (role === "team_leader" && (await githubStanding(token, org, person)) !== "member") {
      return back(page, `${person.login} has to be a member of ${org.account_login} on GitHub. Admins are Owners already.`);
    }
    if (!(await setTeamLeader(env.DB, person.user_id, org.id, role === "team_leader"))) {
      return back(page, `${person.login}'s role is already up to date.`);
    }
    await audit(env.DB, org.id, user.id, "role_changed", `${person.login} (${person.github_id}) to ${role}`);
    return back(page);
  } catch (err) {
    console.error("role change failed", org.account_login, err);
    return back(page, "Voxium could not confirm this with GitHub. Nothing was changed. Try again.");
  }
}
