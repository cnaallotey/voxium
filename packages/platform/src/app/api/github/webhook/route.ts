import { NextResponse, type NextRequest } from "next/server";
import { verifyWebhookSignature } from "@/lib/crypto";
import { getEnv, waitUntil } from "@/lib/env";
import { getInstallationToken, listInstallationRepos } from "@/lib/github";
import { runPullRequestCheck } from "@/lib/repo-job";
import { deleteOrgByInstallation, getOrgByInstallation, removeRepos, upsertOrg, upsertRepos } from "@/lib/store";

export const dynamic = "force-dynamic";

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

interface Payload {
  action?: string;
  installation?: { id: number; account?: { login: string; type: string } };
  repositories_removed?: Array<{ id: number }>;
  repository?: { full_name: string };
  pull_request?: { number: number; head: { sha: string }; base: { sha: string } };
}

export async function POST(req: NextRequest) {
  const env = getEnv();
  const raw = await req.text();
  if (!(await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, raw, req.headers.get("x-hub-signature-256")))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  const body = JSON.parse(raw) as Payload;
  const installationId = body.installation?.id;

  if (event === "ping") return NextResponse.json({ ok: true });

  if (event === "installation" && installationId) {
    if (body.action === "deleted") {
      await deleteOrgByInstallation(env.DB, installationId);
    } else if (body.action === "created" && body.installation?.account) {
      const org = await upsertOrg(env.DB, {
        installation_id: installationId,
        account_login: body.installation.account.login,
        account_type: body.installation.account.type,
      });
      waitUntil(syncRepos(installationId, org.id));
    }
    return NextResponse.json({ ok: true });
  }

  if (event === "installation_repositories" && installationId) {
    const org = await getOrgByInstallation(env.DB, installationId);
    if (org) {
      if (body.repositories_removed?.length) await removeRepos(env.DB, body.repositories_removed.map((r) => r.id));
      waitUntil(syncRepos(installationId, org.id));
    }
    return NextResponse.json({ ok: true });
  }

  if (event === "pull_request" && body.action && PR_ACTIONS.has(body.action) && installationId && body.repository && body.pull_request) {
    waitUntil(
      runPullRequestCheck({
        installationId,
        fullName: body.repository.full_name,
        number: body.pull_request.number,
        headSha: body.pull_request.head.sha,
        baseSha: body.pull_request.base.sha,
      }),
    );
    return NextResponse.json({ ok: true, queued: true }, { status: 202 });
  }

  return NextResponse.json({ ok: true, ignored: event });
}

async function syncRepos(installationId: number, orgId: number): Promise<void> {
  const env = getEnv();
  try {
    const token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, installationId);
    await upsertRepos(env.DB, orgId, await listInstallationRepos(token));
  } catch (err) {
    console.error("repo sync failed", installationId, err);
  }
}
