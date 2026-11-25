import { NextResponse, type NextRequest } from "next/server";
import { EXTRA_FILES, prepareSetup, wantFile } from "@/lib/analysis";
import { canManage, githubRepoLevel, githubStanding, resolveRole } from "@/lib/access";
import { currentUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { ARCH_FILE_PATH, parseCliPackage } from "@voxium/core";
import { createSetupPr, fetchTarball, getBranchSha, getFileAtRef, getInstallationToken, listTree } from "@/lib/github";
import { fromThisSite } from "@/lib/same-origin";
import { readTarGz } from "@/lib/tar";
import { audit, getOrg, getRepo, getRole, saveAnalysis, setRepoSetup } from "@/lib/store";

export const dynamic = "force-dynamic";

function back(env: { APP_URL: string }, path: string, error?: string) {
  const url = new URL(path, env.APP_URL);
  if (error) url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const env = getEnv();
  if (!fromThisSite(req, env.APP_URL)) return back(env, "/dashboard", "That request did not come from Voxium.");
  const user = await currentUser();
  if (!user) return back(env, "/api/auth/login");

  const repo = await getRepo(env.DB, Number((await params).id));
  if (!repo) return back(env, "/dashboard", "Repository not found.");
  const role = await getRole(env.DB, user.id, repo.org_id);
  if (!role) return back(env, "/dashboard", "Repository not found.");
  if (!canManage(role)) {
    return back(env, "/dashboard", "Only an Owner or Team Leader can set up Voxium.");
  }
  const org = await getOrg(env.DB, repo.org_id);
  if (!org) return back(env, "/dashboard", "Organization not found.");

  try {
    let cliPackage: string | undefined;
    try {
      cliPackage = parseCliPackage(env.VOXIUM_CLI_PACKAGE);
    } catch {
      return back(env, "/dashboard", "VOXIUM_CLI_PACKAGE must be an exact published version, such as voxium@1.2.3.");
    }
    const token = await getInstallationToken({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }, org.installation_id);
    const level = await githubRepoLevel(token, repo.full_name, user);
    if (!level) return back(env, "/dashboard", "Repository not found.");
    if (!canManage(resolveRole(await githubStanding(token, org, user), role))) {
      return back(env, "/dashboard", "Only an Owner or Team Leader can set up Voxium.");
    }
    if (level === "read") return back(env, "/dashboard", `You need write access to ${repo.full_name} to set up Voxium.`);
    const sha = await getBranchSha(token, repo.full_name, repo.default_branch);
    const tree = await listTree(token, repo.full_name, sha);
    if (!tree) return back(env, "/dashboard", `${repo.full_name} is too large to analyze completely.`);
    if (tree.has(ARCH_FILE_PATH)) {
      // Rules someone already approved must not be replaced by inferred ones.
      await setRepoSetup(env.DB, repo.id, "active", repo.setup_pr_url);
      return back(env, `/repos/${repo.id}`);
    }
    const files = await readTarGz(await fetchTarball(token, repo.full_name, sha), { want: wantFile, expect: tree });
    // Setup adds to these files, so a copy missing from the archive must not look like no file at all.
    for (const p of EXTRA_FILES) {
      if (!tree.has(p) || Object.hasOwn(files, p)) continue;
      const text = await getFileAtRef(token, repo.full_name, p, sha);
      if (text !== null) files[p] = text;
    }
    const plan = prepareSetup(files, [...tree.keys()], cliPackage);
    if (plan.unchecked.length) {
      return back(env, "/dashboard", `${repo.full_name} has ${plan.unchecked.length} source file(s) that cannot be read (too large, symlinked or changed by .gitattributes) but are part of the code to check, for example ${plan.unchecked[0]}.`);
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
        `${plan.baselineCount} existing violation(s) are recorded as baseline, so only new ones fail.`,
        ...(plan.ignore.length ? [`Not checked, please confirm none of it is source code: ${plan.ignore.map((g) => `\`${g}\``).join(", ")}.`] : []),
        "",
        cliPackage
          ? `The GitHub Actions job and .mcp.json run \`${cliPackage}\` from npm.`
          : "No GitHub Actions job or MCP server is added, because this Voxium has no published CLI configured. The `voxium/rules` status checks pull requests once this is merged, so require it on the default branch.",
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
    // Details stay in the logs. No repo name either: access may not have been confirmed yet.
    return back(env, "/dashboard", `Setup failed. Check that the GitHub App can access the repository, then try again.`);
  }
}
