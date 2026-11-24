import { cookies } from "next/headers";
import { getEnv } from "./env";
import { readSessionToken, SESSION_COOKIE } from "./session";
import { getUser, type UserRow } from "./store";

export async function currentUser(): Promise<UserRow | null> {
  const env = getEnv();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await readSessionToken(env.SESSION_SECRET, token);
  if (!session) return null;
  return getUser(env.DB, session.uid);
}
