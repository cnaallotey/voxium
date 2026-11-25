import { githubRepoLevel } from "./access";
import { currentUser } from "./auth";
import { getEnv, type Env } from "./env";
import { getInstallationToken } from "./github";
import { getOrg, getRepo, getRole, type AccessLevel, type OrgRow, type RepoRow, type Role, type UserRow } from "./store";

export interface OpenRepo {
  env: Env;
  user: UserRow;
  org: OrgRow;
  repo: RepoRow;
  /** Role on record. What it allows still has to be confirmed with GitHub. */
  role: Role;
  /** What GitHub says the person can do in the repo right now. */
  level: AccessLevel;
  token: string;
}

/** The repo, for someone GitHub lets open it right now. Null for everyone else, and when GitHub cannot say. */
export async function openRepo(id: string): Promise<OpenRepo | null> {
  const env = getEnv();
  const user = await currentUser();
  const repo = user && (await getRepo(env.DB, Number(id)));
  if (!user || !repo) return null;
  const org = await getOrg(env.DB, repo.org_id);
  const role = org && (await getRole(env.DB, user.id, org.id));
  if (!org || !role) return null;
  try {
    const token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, org.installation_id);
    const level = await githubRepoLevel(token, repo.full_name, user);
    return level ? { env, user, org, repo, role, level, token } : null;
  } catch (err) {
    console.error("access check failed", repo.full_name, err);
    return null;
  }
}
