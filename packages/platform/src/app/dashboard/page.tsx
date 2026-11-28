import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { canManage } from "@/lib/access";
import { listMemberships, listOrgsForUser, listReposForUser } from "@/lib/store";
import { Empty, ErrorNotice, Notice, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; cls: string }> = {
  connected: { label: "Not set up", cls: "" },
  setup_pr_open: { label: "Setup PR open", cls: "warn" },
  active: { label: "Active", cls: "ok" },
};

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/api/auth/login");
  const env = getEnv();
  const { error } = await searchParams;
  const orgs = await listOrgsForUser(env.DB, user.id);
  const withRepos = await Promise.all(orgs.map(async (o) => ({ org: o, repos: await listReposForUser(env.DB, user.id, o.id) })));
  const unreadable = (await listMemberships(env.DB, user.id)).filter((m) => m.state === "error");
  const installUrl = `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`;

  return (
    <>
      <PageHeader
        title="Dashboard"
        meta={<span>Signed in as {user.login}</span>}
        actions={
          <>
            <a className="btn secondary" href="/api/auth/login" title="Read your organizations, roles and repositories from GitHub again">Refresh access</a>
            <a className="btn secondary" href={installUrl}>Add an organization</a>
          </>
        }
      />
      <ErrorNotice error={error} />

      {unreadable.map((m) => (
        <Notice tone="error" key={m.org_id}>
          Voxium could not read your access to {m.account_login}, so nothing from it is shown. The app may be suspended there, or
          an organization owner may still have to approve its permissions (Members, read). Then use Refresh access.
        </Notice>
      ))}

      {withRepos.length === 0 && unreadable.length === 0 && (
        <Empty>
          <p>No organizations connected yet. Install the Voxium GitHub App on the account or organization you want to protect.</p>
          <p className="small">Already installed? Sign in to your organization's single sign on at GitHub first, then use Refresh access.</p>
          <a className="btn" href={installUrl}>Install the GitHub App</a>
        </Empty>
      )}

      {withRepos.map(({ org, repos }) => {
        const canSetup = canManage(org.role);
        const manager = org.role === "owner" || org.role === "team_leader";
        return (
          <section key={org.id}>
            <div className="row">
              <h2>
                {org.account_login} <span className="badge">{org.role.replace("_", " ")}</span>
              </h2>
              <nav className="meta" aria-label={`${org.account_login} pages`}>
                <a href={`/orgs/${org.id}/overview`}>Overview</a>
                {manager && <a href={`/orgs/${org.id}/rules`}>Organization rules</a>}
                {org.role === "owner" && <a href={`/orgs/${org.id}`}>People</a>}
                {org.role === "owner" && <a href={`/orgs/${org.id}/audit`}>Audit log</a>}
              </nav>
            </div>
            {repos.length === 0 ? (
              <Empty>No repositories you can open are shared with the app.</Empty>
            ) : (
              <div className="list">
                {repos.map((r) => {
                  const s = STATUS[r.status] ?? STATUS.connected;
                  return (
                    <div className="item" key={r.id}>
                      <div>
                        <a className="item-title" href={`/repos/${r.id}`}>{r.full_name}</a> <span className={`badge ${s.cls}`}>{s.label}</span>
                        {r.setup_pr_url && (
                          <div className="muted small">
                            <a href={r.setup_pr_url}>Setup pull request</a>
                          </div>
                        )}
                      </div>
                      {canSetup && r.level !== "read" && r.status !== "active" && (
                        r.status === "setup_pr_open" ? (
                          <a className="btn secondary" href={`/repos/${r.id}/setup`} title="Edit the draft and replace the files in the setup pull request">
                            Review setup
                          </a>
                        ) : (
                          <form method="post" action={`/api/repos/${r.id}/setup/draft`}>
                            <button type="submit" title="Infers the architecture for you to review. Nothing is written to the repository yet.">Set up Voxium</button>
                          </form>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
