import { githubStanding, resolveRole } from "./access";
import { currentUser } from "./auth";
import { getEnv, type Env } from "./env";
import { getInstallationToken } from "./github";
import { getOrg, getRole, type OrgRow, type UserRow } from "./store";

export interface OwnedOrg {
  env: Env;
  user: UserRow;
  org: OrgRow;
  token: string;
}

/** The org, for someone GitHub confirms is its Owner right now. Null for everyone else, and when GitHub cannot say. */
export async function openOwnedOrg(id: string): Promise<OwnedOrg | null> {
  const env = getEnv();
  const user = await currentUser();
  const org = user && (await getOrg(env.DB, Number(id)));
  if (!user || !org || !(await getRole(env.DB, user.id, org.id))) return null;
  try {
    const token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, org.installation_id);
    return (await githubStanding(token, org, user)) === "owner" ? { env, user, org, token } : null;
  } catch (err) {
    console.error("owner check failed", org.account_login, err);
    return null;
  }
}

export interface ManagedOrg extends OwnedOrg {
  role: "owner" | "team_leader";
}

/**
 * The org, for an Owner or Team Leader whose standing GitHub confirms right now: an Owner is an admin there, a Team
 * Leader a member with that role here. A Team Leader who left the organization is refused. Null for everyone else.
 */
export async function openManagedOrg(id: string): Promise<ManagedOrg | null> {
  const env = getEnv();
  const user = await currentUser();
  const org = user && (await getOrg(env.DB, Number(id)));
  const stored = user && org ? await getRole(env.DB, user.id, org.id) : null;
  if (!user || !org || !stored) return null;
  try {
    const token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, org.installation_id);
    const role = resolveRole(await githubStanding(token, org, user), stored);
    return role === "owner" || role === "team_leader" ? { env, user, org, token, role } : null;
  } catch (err) {
    console.error("role check failed", org.account_login, err);
    return null;
  }
}
