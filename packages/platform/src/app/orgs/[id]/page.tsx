import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { openOwnedOrg } from "@/lib/open-org";
import { listPeople } from "@/lib/store";
import { ErrorNotice, OrgTabs, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

export default async function PeoplePage({ params, searchParams }: Props) {
  if (!(await currentUser())) redirect("/api/auth/login");
  const open = await openOwnedOrg((await params).id);
  if (!open) notFound();
  const { env, org } = open;
  const { error } = await searchParams;
  const people = await listPeople(env.DB, org.id);
  const isOrg = org.account_type === "Organization";

  return (
    <>
      <PageHeader
        crumbs={[["Dashboard", "/dashboard"], [org.account_login, `/orgs/${org.id}/overview`], ["People"]]}
        title="People"
        meta={<span>{people.length} {people.length === 1 ? "person" : "people"}</span>}
        lead={
          isOrg
            ? "Team Leaders approve changes to the rules, as Owners do. Owners are the organization's admins on GitHub. People appear here after they sign in to Voxium once."
            : "This is a personal account, so you are its only Owner and nobody else can be a Team Leader. You can approve your own changes to the rules, with a reason, on the pull request's page in Voxium."
        }
      />
      <OrgTabs id={org.id} current="people" role="owner" />
      <ErrorNotice error={error} />
      <div className="list">
        {people.map((p) => (
          <div className="item" key={p.user_id}>
            <div>
              <span className="item-title">{p.login}</span> <span className={`badge ${p.role === "member" ? "" : "info"}`}>{p.role.replace("_", " ")}</span>
              {p.state !== "active" && <span className="badge warn">no access right now</span>}
            </div>
            {isOrg && p.role !== "owner" && (
              <form method="post" action={`/api/orgs/${org.id}/roles`}>
                <input type="hidden" name="user" value={p.user_id} />
                <input type="hidden" name="role" value={p.role === "team_leader" ? "member" : "team_leader"} />
                <button type="submit" className={p.role === "team_leader" ? "secondary" : undefined}>
                  {p.role === "team_leader" ? "Remove as Team Leader" : "Make Team Leader"}
                </button>
              </form>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
