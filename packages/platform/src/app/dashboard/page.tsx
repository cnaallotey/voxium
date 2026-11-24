import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { listOrgsForUser, listRepos } from "@/lib/store";

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
  const withRepos = await Promise.all(orgs.map(async (o) => ({ org: o, repos: await listRepos(env.DB, o.id) })));
  const installUrl = `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`;

  return (
    <>
      <div className="row">
        <h1>Dashboard</h1>
        <span className="muted">
          {user.login} · <a href="/api/auth/logout">Sign out</a>
        </span>
      </div>
      {error && <div className="card error">{error}</div>}

      {withRepos.length === 0 && (
        <div className="card">
          <p>No organizations connected yet. Install the Voxium GitHub App on the account or organization you want to protect.</p>
          <a className="btn" href={installUrl}>Install the GitHub App</a>
        </div>
      )}

      {withRepos.map(({ org, repos }) => {
        const canSetup = org.role === "owner" || org.role === "team_leader";
        return (
          <section key={org.id}>
            <h2>
              {org.account_login} <span className="badge">{org.role.replace("_", " ")}</span>
            </h2>
            {repos.length === 0 && <p className="muted">No repositories shared with the app yet.</p>}
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
                  {canSetup && r.status === "connected" && (
                    <form method="post" action={`/api/repos/${r.id}/setup`}>
                      <button type="submit">Set up Voxium</button>
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
