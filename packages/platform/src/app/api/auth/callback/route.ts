import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { createSessionToken, SESSION_COOKIE, sessionMaxAge } from "@/lib/session";
import { gh, ok } from "@/lib/github";
import { syncAccess } from "@/lib/sign-in";
import { upsertUser, type UserRow } from "@/lib/store";

export const dynamic = "force-dynamic";

interface GhUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
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

  let user: UserRow;
  try {
    const ghUser = await ok<GhUser>(await gh(userToken, "/user"), "read user");
    user = await upsertUser(env.DB, { github_id: ghUser.id, login: ghUser.login, name: ghUser.name, avatar_url: ghUser.avatar_url });
    await syncAccess(env, user, userToken);
  } catch (err) {
    console.error("sign in failed", err);
    return NextResponse.redirect(`${env.APP_URL}/?error=github_unavailable`);
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
