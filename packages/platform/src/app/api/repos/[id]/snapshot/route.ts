import { NextResponse, type NextRequest } from "next/server";
import { canManage, githubStanding, resolveRole } from "@/lib/access";
import { getEnv } from "@/lib/env";
import { openRepo } from "@/lib/open-repo";
import { fromThisSite } from "@/lib/same-origin";
import { runSnapshot } from "@/lib/snapshot-job";

export const dynamic = "force-dynamic";

const SAID: Record<string, string> = {
  busy: "The default branch was analysed less than a minute ago. Try again in a minute.",
  not_set_up: "Voxium is not set up on the default branch yet.",
  unknown_repo: "Repository not found.",
  failed: "The default branch could not be analysed. Try again.",
};

/** Analyse the tip of the default branch now, for its drift history. For an Owner or Team Leader with write access. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const env = getEnv();
  const back = (path: string, error?: string) => {
    const url = new URL(path, env.APP_URL);
    if (error) url.searchParams.set("error", error);
    return NextResponse.redirect(url, 303);
  };
  if (!fromThisSite(req, env.APP_URL)) return back("/dashboard", "That request did not come from Voxium.");
  const open = await openRepo((await params).id);
  if (!open) return back("/dashboard", "Repository not found.");
  const { user, org, repo, role, level, token } = open;
  const page = `/repos/${repo.id}/drift`;
  try {
    if (!canManage(resolveRole(await githubStanding(token, org, user), role)) || level === "read") {
      return back(page, "Only an Owner or Team Leader with write access can analyse the default branch.");
    }
  } catch {
    return back(page, "GitHub could not confirm your role. Try again.");
  }
  const outcome = await runSnapshot(
    { installationId: org.installation_id, repoId: repo.github_repo_id, fullName: repo.full_name, defaultBranch: repo.default_branch },
    { userId: user.id },
  );
  return outcome === "saved" ? back(page) : back(page, SAID[outcome]);
}
