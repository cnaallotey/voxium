import { githubStanding, resolveRole } from "./access";
import type { Env } from "./env";
import { getInstallationToken, listUserInstallations, listUserRepos } from "./github";
import {
  audit,
  getStoredRole,
  listMemberships,
  replaceRepoAccess,
  setMembership,
  suspendMembership,
  upsertOrg,
  upsertRepos,
  type UserRow,
} from "./store";

/**
 * Bring a user's roles and repo access in line with GitHub, using their fresh sign in token.
 * Throws when GitHub cannot say which installations they have, so nobody signs in on stale access.
 *
 * Losing sight of an installation (suspended, no SSO session, GitHub trouble) takes away access but keeps the
 * role on record. Only GitHub saying that the person is not in the organization takes an assigned role away.
 */
export async function syncAccess(env: Env, user: UserRow, userToken: string): Promise<void> {
  const installations = (await listUserInstallations(userToken)).filter((i) => String(i.app_id) === String(env.GITHUB_APP_ID));

  const current = new Set<number>();
  for (const inst of installations) {
    const org = await upsertOrg(env.DB, {
      installation_id: inst.id,
      account_id: inst.account.id,
      account_login: inst.account.login,
      account_type: inst.account.type,
    });
    current.add(org.id);
    const stored = await getStoredRole(env.DB, user.id, org.id);
    try {
      if (inst.suspended_at) throw new Error("installation is suspended");
      const token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, inst.id);
      const role = resolveRole(await githubStanding(token, org, user), stored);
      const repos = await listUserRepos(userToken, inst.id);
      await upsertRepos(env.DB, org.id, repos);
      await setMembership(env.DB, user.id, org.id, role);
      await replaceRepoAccess(env.DB, user.id, org.id, repos);
      if (stored !== role) await audit(env.DB, org.id, user.id, "role_changed", `${stored ?? "none"} to ${role}`);
      await audit(env.DB, org.id, user.id, "sign_in", role);
    } catch (err) {
      // One unreachable installation must not block the rest, but nothing from it may stay visible or usable.
      console.error("access sync failed", inst.id, err);
      await suspendMembership(env.DB, user.id, org.id, "error");
    }
  }

  for (const m of await listMemberships(env.DB, user.id)) {
    if (current.has(m.org_id) || m.state === "gone") continue;
    await suspendMembership(env.DB, user.id, m.org_id, "gone");
    await audit(env.DB, m.org_id, user.id, "access_removed", m.role);
  }
}
