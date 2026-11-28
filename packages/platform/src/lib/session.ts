import { b64urlEncode, hmacSha256Hex, safeEqual } from "./crypto";

export const SESSION_COOKIE = "voxium_session";
// Access is refreshed from GitHub at sign in, so this is also how long a revoked repo can stay listed.
const MAX_AGE_SECONDS = 60 * 60 * 8;

export interface Session {
  uid: number;
  login: string;
  exp: number; // unix seconds
}

/** Signed cookie value: base64url(json).hexsignature. */
export async function createSessionToken(secret: string, s: Omit<Session, "exp">, now = Date.now()): Promise<string> {
  const payload = b64urlEncode(JSON.stringify({ ...s, exp: Math.floor(now / 1000) + MAX_AGE_SECONDS }));
  return `${payload}.${await hmacSha256Hex(secret, payload)}`;
}

export async function readSessionToken(secret: string, token: string | undefined, now = Date.now()): Promise<Session | null> {
  if (!secret || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(await hmacSha256Hex(secret, payload), sig)) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof json.uid !== "number" || typeof json.exp !== "number") return null;
    if (json.exp < Math.floor(now / 1000)) return null;
    return json as Session;
  } catch {
    return null;
  }
}

export const sessionMaxAge = MAX_AGE_SECONDS;
