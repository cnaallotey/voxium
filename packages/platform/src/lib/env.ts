import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { D1Database } from "./d1";

export interface Env {
  DB: D1Database;
  APP_URL: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_PRIVATE_KEY: string;
  SESSION_SECRET: string;
  /** Published CLI that setup pull requests may run, such as "voxium@1.2.3". Empty means none. */
  VOXIUM_CLI_PACKAGE?: string;
}

/** Only call inside a request handler. Bindings do not exist at build time. */
export function getEnv(): Env {
  return getCloudflareContext().env as unknown as Env;
}

export function waitUntil(p: Promise<unknown>): void {
  getCloudflareContext().ctx.waitUntil(p);
}
