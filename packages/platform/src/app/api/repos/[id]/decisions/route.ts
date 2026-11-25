import { NextResponse, type NextRequest } from "next/server";
import { canManage, githubStanding, resolveRole } from "@/lib/access";
import { decisionPath, renderDecision } from "@/lib/decisions";
import { getEnv } from "@/lib/env";
import { createSetupPr, getBranchSha, listTree } from "@/lib/github";
import { openRepo } from "@/lib/open-repo";
import { fromThisSite } from "@/lib/same-origin";
import { audit, listDecisions } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Open a pull request that adds the logged decisions the repo does not have yet. */
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
  const page = `/repos/${repo.id}`;
  try {
    if (!canManage(resolveRole(await githubStanding(token, org, user), role)) || level === "read") {
      return back(page, "Only an Owner or Team Leader with write access can add decisions to the repository.");
    }
    const tree = await listTree(token, repo.full_name, await getBranchSha(token, repo.full_name, repo.default_branch));
    if (!tree) return back(page, `${repo.full_name} is too large to read completely.`);
    const missing = (await listDecisions(env.DB, repo.github_repo_id)).filter((d) => !tree.has(decisionPath(d)));
    if (!missing.length) return back(page, "The repository already has every decision.");
    const pr = await createSetupPr(token, repo.full_name, repo.default_branch, Object.fromEntries(missing.map((d) => [decisionPath(d), renderDecision(d)])), {
      title: "Record architecture decisions",
      body: `Adds ${missing.length} decision(s) from the Voxium log to \`voxium/decisions\`: ${missing.map((d) => `#${d.pr_number}`).join(", ")}.`,
      branch: "voxium/decisions",
    });
    await audit(env.DB, org.id, user.id, "decisions_pr", pr.url);
    return NextResponse.redirect(pr.url, 303);
  } catch (err) {
    console.error("decision log pull request failed", repo.full_name, err);
    return back(page, "The pull request could not be opened. Try again.");
  }
}
