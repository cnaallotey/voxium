/**
 * Who may do what. GitHub decides: the platform never grants more than GitHub would.
 */
import { gh, ok } from "./github";
import type { AccessLevel, Role } from "./store";

export interface GithubUser {
  github_id: number;
  login: string;
}

export interface Account {
  account_id: number | null;
  account_login: string;
  account_type: string;
}

/** A person's place in the account the app is installed on. Outside covers collaborators and strangers. */
export type Standing = "owner" | "member" | "outside";

/**
 * Ask GitHub about a person's standing, with an installation token. Ids are compared as well as logins,
 * because a login can be renamed and taken over by someone else.
 */
export async function githubStanding(token: string, account: Account, user: GithubUser): Promise<Standing> {
  if (account.account_type !== "Organization") {
    return account.account_id !== null && account.account_id === user.github_id ? "owner" : "outside";
  }
  const res = await gh(token, `/orgs/${encodeURIComponent(account.account_login)}/memberships/${encodeURIComponent(user.login)}`);
  if (res.status === 404) return "outside";
  const m = await ok<{ state: string; role: string; user: { id: number } | null }>(res, "read organization membership");
  if (m.state !== "active" || m.user?.id !== user.github_id) return "outside";
  return m.role === "admin" ? "owner" : "member";
}

/** Owner always mirrors GitHub. Team Leader is kept only while the person belongs to the organization. */
export function resolveRole(standing: Standing, stored: Role | null): Role {
  if (standing === "owner") return "owner";
  return standing === "member" && stored === "team_leader" ? "team_leader" : "member";
}

export function canManage(role: Role | null): boolean {
  return role === "owner" || role === "team_leader";
}

/** What the person can do in a repo right now, according to GitHub. Null means no access. */
export async function githubRepoLevel(token: string, fullName: string, user: GithubUser): Promise<AccessLevel | null> {
  const res = await gh(token, `/repos/${fullName}/collaborators/${encodeURIComponent(user.login)}/permission`);
  if (res.status === 404) return null;
  const p = await ok<{ permission: string; user: { id: number } | null }>(res, "read permission");
  if (p.user?.id !== user.github_id) return null;
  return p.permission === "admin" || p.permission === "write" || p.permission === "read" ? p.permission : null;
}
