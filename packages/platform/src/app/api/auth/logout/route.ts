import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const res = NextResponse.redirect(`${getEnv().APP_URL}/`);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
