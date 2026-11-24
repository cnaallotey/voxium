import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { createSessionToken, SESSION_COOKIE, sessionMaxAge } from "@/lib/session";
import { gh, getInstallationToken, listInstallationRepos } from "@/lib/github";
import { audit, ensureMembership, upsertOrg, upsertRepos, upsertUser } from "@/lib/store";

export const dynamic = "force-dynamic";

interface GhUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}
interface GhInstallation {
  id: number;
  app_id: number;
  account: { login: string; type: string };
}

export async function GET(req: NextRequest) {
  const env = getEnv();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expected = req.cookies.get("voxium_oauth_state")?.value;
  if (!code || !state || !expected || state !== expected) {
    return NextResponse.redirect(`${env.APP_URL}/?error=bad_state`);
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "voxium-platform" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${env.APP_URL}/api/auth/callback`,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) return NextResponse.redirect(`${env.APP_URL}/?error=oauth_failed`);
  const userToken = tokenJson.access_token;

  const ghUser = (await (await gh(userToken, "/user")).json()) as GhUser;
  const user = await upsertUser(env.DB, {
    github_id: ghUser.id,
    login: ghUser.login,
    name: ghUser.name,
    avatar_url: ghUser.avatar_url,
  });

  // Link the user to every installation of this app they can access.
  const instRes = await gh(userToken, "/user/installations?per_page=100");
  if (instRes.ok) {
    const { installations } = (await instRes.json()) as { installations: GhInstallation[] };
    for (const inst of installations.filter((i) => String(i.app_id) === String(env.GITHUB_APP_ID))) {
      const org = await upsertOrg(env.DB, {
        installation_id: inst.id,
        account_login: inst.account.login,
        account_type: inst.account.type,
      });
      const role = await ensureMembership(env.DB, user.id, org.id);
      await audit(env.DB, org.id, user.id, "sign_in", role);
      try {
        const token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, inst.id);
        await upsertRepos(env.DB, org.id, await listInstallationRepos(token));
      } catch (err) {
        console.error("repo sync failed", inst.id, err);
      }
    }
  }

  const res = NextResponse.redirect(`${env.APP_URL}/dashboard`);
  res.cookies.set(SESSION_COOKIE, await createSessionToken(env.SESSION_SECRET, { uid: user.id, login: user.login }), {
    httpOnly: true,
    secure: env.APP_URL.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: sessionMaxAge,
  });
  res.cookies.delete("voxium_oauth_state");
  return res;
}
