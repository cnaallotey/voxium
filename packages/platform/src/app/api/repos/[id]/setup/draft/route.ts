import { NextResponse, type NextRequest } from "next/server";
import { describeUnchecked, draftSetup, type SetupDraft } from "@/lib/analysis";
import { getEnv } from "@/lib/env";
import { fromThisSite } from "@/lib/same-origin";
import { openSetup, readDefaultBranch } from "@/lib/setup";
import { audit, saveSetupDraft, setRepoSetup } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Infer the architecture of the default branch and store it as a draft, for review before the setup pull request. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const env = getEnv();
  const back = (path: string, error?: string) => {
    const url = new URL(path, env.APP_URL);
    if (error) url.searchParams.set("error", error);
    return NextResponse.redirect(url, 303);
  };
  if (!fromThisSite(req, env.APP_URL)) return back("/dashboard", "That request did not come from Voxium.");
  const access = await openSetup((await params).id);
  if (!access.ok) return back("/dashboard", access.error);
  const { user, org, repo } = access.open;

  try {
    const branch = await readDefaultBranch(access.open);
    if (branch.kind === "too_large") return back("/dashboard", `${repo.full_name} is too large to analyze completely.`);
    if (branch.kind === "rules") {
      // Rules someone already approved must not be replaced by inferred ones.
      await setRepoSetup(env.DB, repo.id, "active", repo.setup_pr_url);
      return back(`/repos/${repo.id}`);
    }
    const { unchecked, reasons, ...draft } = draftSetup(branch.files, [...branch.tree.keys()]);
    if (unchecked.length) {
      const first = unchecked[0];
      const why = reasons[first] ? `, which ${reasons[first]}` : " (too large, symlinked, or changed by .gitattributes)";
      return back("/dashboard", `${repo.full_name} has ${describeUnchecked(unchecked)} that cannot be read but that the code to check depends on, for example ${first}${why}.`);
    }
    if (Object.keys(draft.architecture.modules).length === 0) {
      return back("/dashboard", `Could not find any folders to treat as modules in ${repo.full_name}.`);
    }
    const stored: SetupDraft = { architecture: draft.architecture, proposals: draft.proposals, violations: draft.violations, summary: draft.summary };
    await saveSetupDraft(env.DB, { repo_id: repo.id, user_id: user.id, commit_sha: branch.sha, draft_json: JSON.stringify(stored) });
    await audit(env.DB, org.id, user.id, "setup_drafted", `${repo.full_name} at ${branch.sha}`);
    return back(`/repos/${repo.id}/setup`);
  } catch (err) {
    console.error("setup draft failed", repo.full_name, err);
    return back("/dashboard", "The architecture could not be inferred. Check that the GitHub App can access the repository, then try again.");
  }
}
