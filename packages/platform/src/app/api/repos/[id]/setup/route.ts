import { NextResponse, type NextRequest } from "next/server";
import { prepareSetup, wantFile } from "@/lib/analysis";
import { currentUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { createSetupPr, fetchTarball, getBranchSha, getInstallationToken, listTreePaths } from "@/lib/github";
import { readTarGz } from "@/lib/tar";
import { audit, getOrg, getRepo, getRole, saveAnalysis, setRepoSetup } from "@/lib/store";

export const dynamic = "force-dynamic";

function back(env: { APP_URL: string }, path: string, error?: string) {
  const url = new URL(path, env.APP_URL);
  if (error) url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const env = getEnv();
  const user = await currentUser();
  if (!user) return back(env, "/api/auth/login");

  const repo = await getRepo(env.DB, Number((await params).id));
  if (!repo) return back(env, "/dashboard", "Repository not found.");
  const role = await getRole(env.DB, user.id, repo.org_id);
  if (role !== "owner" && role !== "team_leader") {
    return back(env, "/dashboard", "Only an Owner or Team Leader can set up Voxium.");
  }
  const org = await getOrg(env.DB, repo.org_id);
  if (!org) return back(env, "/dashboard", "Organization not found.");

  try {
    const token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, org.installation_id);
    const sha = await getBranchSha(token, repo.full_name, repo.default_branch);
    const treePaths = await listTreePaths(token, repo.full_name, sha);
    if (!treePaths) return back(env, "/dashboard", `${repo.full_name} is too large to analyze completely.`);
    const files = await readTarGz(await fetchTarball(token, repo.full_name, sha), { want: wantFile });
    const plan = prepareSetup(files, treePaths);
    if (plan.unchecked.length) {
      return back(env, "/dashboard", `${repo.full_name} has ${plan.unchecked.length} source file(s) that cannot be analyzed (too large, symlinked or excluded from archives), for example ${plan.unchecked[0]}.`);
    }
    if (Object.keys(plan.summary.modules).length === 0) {
      return back(env, "/dashboard", `Could not find any folders to treat as modules in ${repo.full_name}.`);
    }

    const pr = await createSetupPr(token, repo.full_name, repo.default_branch, plan.setupFiles, {
      title: "Add Voxium architecture guardrails",
      body: [
        "This PR sets up Voxium for this repository.",
        "",
        `Inferred ${plan.summary.layers.length} layers (confidence ${(plan.summary.confidence * 100).toFixed(0)}%): ${plan.summary.layers.join(" > ")}.`,
        `${plan.baselineCount} existing violation(s) are recorded as baseline so CI starts green.`,
        "",
        "Review voxium/architecture.json before merging. Add voxium/CODEOWNERS.suggested to .github/CODEOWNERS so only Team Leaders can change the rules.",
      ].join("\n"),
    });

    await setRepoSetup(env.DB, repo.id, "setup_pr_open", pr.url);
    await saveAnalysis(env.DB, {
      repo_id: repo.id,
      kind: "inference",
      confidence: plan.summary.confidence,
      baseline_violations: plan.baselineCount,
      summary: plan.summary,
    });
    await audit(env.DB, org.id, user.id, "setup_pr", pr.url);
    return back(env, `/repos/${repo.id}`);
  } catch (err) {
    console.error("setup failed", repo.full_name, err);
    // Details stay in the logs. The page only gets a safe, generic message.
    return back(env, "/dashboard", `Setup failed for ${repo.full_name}. Check that the GitHub App can access it, then try again.`);
  }
}
