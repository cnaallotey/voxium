import { githubStanding } from "./access";
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
