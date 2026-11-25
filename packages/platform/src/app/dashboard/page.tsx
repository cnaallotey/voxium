import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { canManage } from "@/lib/access";
import { listMemberships, listOrgsForUser, listReposForUser } from "@/lib/store";

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
      <div className="row">
        <h1>Dashboard</h1>
        <span className="muted">
          {user.login} · <a href="/api/auth/login">Refresh access</a> · <a href="/api/auth/logout">Sign out</a>
        </span>
      </div>
      {error && <div className="card error">{error}</div>}

      {unreadable.map((m) => (
        <div className="card error" key={m.org_id}>
          Voxium could not read your access to {m.account_login}, so nothing from it is shown. The app may be suspended there, or
          an organization owner may still have to approve its permissions (Members, read). Then use Refresh access.
        </div>
      ))}

      {withRepos.length === 0 && unreadable.length === 0 && (
        <div className="card">
          <p>No organizations connected yet. Install the Voxium GitHub App on the account or organization you want to protect.</p>
          <p className="muted">Already installed? Sign in to your organization's single sign on at GitHub first, then use Refresh access.</p>
          <a className="btn" href={installUrl}>Install the GitHub App</a>
        </div>
      )}

      {withRepos.map(({ org, repos }) => {
        const canSetup = canManage(org.role);
        return (
          <section key={org.id}>
            <h2>
              {org.account_login} <span className="badge">{org.role.replace("_", " ")}</span>
            </h2>
            {repos.length === 0 && <p className="muted">No repositories you can open are shared with the app.</p>}
            {repos.map((r) => {
              const s = STATUS[r.status] ?? STATUS.connected;
              return (
                <div className="card row" key={r.id}>
                  <div>
                    <a href={`/repos/${r.id}`}>{r.full_name}</a>{" "}
                    <span className={`badge ${s.cls}`}>{s.label}</span>
                    {r.setup_pr_url && (
                      <div className="muted">
                        <a href={r.setup_pr_url}>Setup pull request</a>
                      </div>
                    )}
                  </div>
                  {canSetup && r.level !== "read" && r.status !== "active" && (
                    <form method="post" action={`/api/repos/${r.id}/setup`}>
                      <button type="submit" title={r.status === "setup_pr_open" ? "Replaces the files in the setup pull request" : undefined}>
                        {r.status === "setup_pr_open" ? "Redo setup PR" : "Set up Voxium"}
                      </button>
                    </form>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
    </>
  );
}
