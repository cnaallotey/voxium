import { ARCH_FILE_PATH } from "@voxium/core";
import { NextResponse, type NextRequest } from "next/server";
import { canManage, githubStanding, resolveRole } from "@/lib/access";
import { getEnv } from "@/lib/env";
import { createSetupPr, getBranchSha, getFileAtRef, listTree } from "@/lib/github";
import { openRepo } from "@/lib/open-repo";
import { filesToRegenerate, GENERATED_FILES, regeneratePrBody, SYNC_BRANCH } from "@/lib/regenerate";
import { readProtected } from "@/lib/repo-job";
import { fromThisSite } from "@/lib/same-origin";
import { ruleOwners } from "@/lib/setup";
import { audit } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Open a pull request with the generated files that differ from what the rules on the default branch give. */
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
      return back(page, "Only an Owner or Team Leader with write access can regenerate the files.");
    }
    // Everything from one commit, so that the files are worked out from the rules they sit next to.
    const sha = await getBranchSha(token, repo.full_name, repo.default_branch);
    const rules = await readProtected(token, repo.full_name, sha);
    if (!rules[ARCH_FILE_PATH]) return back(page, "Voxium is not set up on the default branch yet.");
    const tree = await listTree(token, repo.full_name, sha);
    if (!tree) return back(page, `${repo.full_name} is too large to read completely.`);
    const current = Object.fromEntries(
      await Promise.all(GENERATED_FILES.map(async (p) => [p, tree.has(p) ? await getFileAtRef(token, repo.full_name, p, sha) : null] as const)),
    );
    const files = filesToRegenerate(rules, current, await ruleOwners(env.DB, org.id));
    if (!Object.keys(files).length) return back(page, "Every generated file is up to date.");
    const pr = await createSetupPr(token, repo.full_name, repo.default_branch, files, {
      title: "Regenerate Voxium files",
      body: regeneratePrBody(files),
      branch: SYNC_BRANCH,
      baseSha: sha,
    });
    await audit(env.DB, org.id, user.id, "regenerate_pr", pr.url);
    return NextResponse.redirect(pr.url, 303);
  } catch (err) {
    console.error("regenerate pull request failed", repo.full_name, err);
    return back(page, "The pull request could not be opened. Try again.");
  }
}
