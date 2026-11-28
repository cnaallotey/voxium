import { NextResponse, type NextRequest } from "next/server";
import { applyEdits, isSourcePath, parseCliPackage } from "@voxium/core";
import { describeUnchecked, planSetup, type SetupDraft } from "@/lib/analysis";
import { getEnv } from "@/lib/env";
import { createSetupPr } from "@/lib/github";
import { fromThisSite } from "@/lib/same-origin";
import { draftHash, openSetup, parseEditForm, readDefaultBranch, readForm, ruleOwners, setupPrBody, type StoredDraft } from "@/lib/setup";
import { audit, getSetupDraft, saveAnalysis, setRepoSetup, updateSetupDraft } from "@/lib/store";

export const dynamic = "force-dynamic";

function back(env: { APP_URL: string }, path: string, error?: string) {
  const url = new URL(path, env.APP_URL);
  if (error) url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

/**
 * Open the setup pull request from the reviewed draft: the person's edits applied to the inferred architecture, and the
 * baseline worked out at the tip of the default branch as it is now, which may be newer than the draft.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const env = getEnv();
  if (!fromThisSite(req, env.APP_URL)) return back(env, "/dashboard", "That request did not come from Voxium.");
  const access = await openSetup((await params).id);
  if (!access.ok) return back(env, "/dashboard", access.error);
  const { user, org, repo } = access.open;
  const review = `/repos/${repo.id}/setup`;

  try {
    let cliPackage: string | undefined;
    try {
      cliPackage = parseCliPackage(env.VOXIUM_CLI_PACKAGE);
    } catch {
      return back(env, "/dashboard", "VOXIUM_CLI_PACKAGE must be an exact published version, such as voxium@1.2.3.");
    }
    const row = await getSetupDraft(env.DB, repo.id);
    if (!row) return back(env, review);
    const fields = await readForm(req);
    if (!fields) return back(env, review, "The form was too large or not sent from the editor.");
    const sent = fields.find(([k]) => k === "draft")?.[1];
    if (sent !== (await draftHash(row))) return back(env, review, "The draft changed since you opened it, perhaps by someone else. Look at it again before you send it.");
    const draft = JSON.parse(row.draft_json) as StoredDraft;
    const parsed = parseEditForm(fields, draft.architecture, ["draft", "confirm"]);
    if (!parsed.ok) return back(env, review, parsed.error);
    const confirmed = fields.some(([k, v]) => k === "confirm" && v === "on");
    const inferred: SetupDraft = { architecture: draft.architecture, proposals: draft.proposals, violations: draft.violations, summary: draft.summary };
    // Kept with the draft when the pull request is not opened, so that the page shows them again with what went wrong.
    const keep = async (more: Pick<StoredDraft, "errors" | "warnings">) => {
      await updateSetupDraft(env.DB, repo.id, row.draft_json, JSON.stringify({ ...inferred, submitted: draft.submitted, edits: parsed.edits, ...more }));
    };

    const branch = await readDefaultBranch(access.open);
    if (branch.kind === "too_large") return back(env, "/dashboard", `${repo.full_name} is too large to analyze completely.`);
    if (branch.kind === "rules") {
      await setRepoSetup(env.DB, repo.id, "active", repo.setup_pr_url);
      return back(env, `/repos/${repo.id}`, "Rules were added to the default branch since the draft was made, so nothing was changed. Propose changes to them instead.");
    }
    const treePaths = [...branch.tree.keys()];
    const result = applyEdits(draft.architecture, parsed.edits, treePaths.filter(isSourcePath));
    if (!result.ok) {
      await keep({ errors: result.errors });
      return back(env, review, result.errors[0]);
    }
    // A confirmation counts only for warnings the page showed.
    if (result.warnings.some((w) => !confirmed || !draft.warnings?.includes(w))) {
      await keep({ warnings: result.warnings });
      return back(env, review, "Look at the warnings below, then confirm to open the pull request anyway.");
    }

    const plan = planSetup(result.architecture, draft.summary, branch.files, treePaths, cliPackage, await ruleOwners(env.DB, org.id));
    if (plan.unchecked.length) {
      const first = plan.unchecked[0];
      const why = plan.reasons[first] ? `, which ${plan.reasons[first]}` : " (too large, symlinked, or changed by .gitattributes)";
      const error = `${repo.full_name} has ${describeUnchecked(plan.unchecked)} that cannot be read but that the code to check depends on, for example ${first}${why}.`;
      await keep({ errors: [error] });
      return back(env, review, error);
    }

    const at = new Date().toISOString();
    // The draft is claimed before GitHub is asked, so that of two sends of the same draft at once only one opens a pull
    // request. The claim is new text every time, so that it always changes the draft, and says nothing was opened yet.
    const claimed = JSON.stringify({ ...inferred, submitted: draft.submitted, edits: parsed.edits, opening: { by: user.login, at, id: crypto.randomUUID() } });
    if (!(await updateSetupDraft(env.DB, repo.id, row.draft_json, claimed))) {
      return back(env, review, "The draft changed since you opened it, perhaps by someone else. Look at it again before you send it.");
    }
    let pr: Awaited<ReturnType<typeof createSetupPr>>;
    try {
      // On the commit the baseline and the agent files were worked out on, not on whatever the branch points at by now.
      pr = await createSetupPr(access.open.token, repo.full_name, repo.default_branch, plan.setupFiles, {
        title: "Add Voxium architecture guardrails",
        body: setupPrBody(plan, cliPackage, result),
        baseSha: branch.sha,
      });
    } catch (err) {
      // Nothing was opened, so the draft is put back as it was: the page does not say otherwise, and the form can be sent again.
      await updateSetupDraft(env.DB, repo.id, claimed, row.draft_json).catch((e) => console.error("draft not restored", repo.full_name, e));
      throw err;
    }
    const submitted = { by: user.login, at, sha: branch.sha, counts: result.counts };
    await updateSetupDraft(env.DB, repo.id, claimed, JSON.stringify({ ...inferred, edits: parsed.edits, submitted }));

    await setRepoSetup(env.DB, repo.id, "setup_pr_open", pr.url);
    await saveAnalysis(env.DB, {
      repo_id: repo.id,
      kind: "inference",
      commit_sha: branch.sha,
      confidence: plan.summary.confidence,
      baseline_violations: plan.baselineCount,
      summary: plan.summary,
    });
    await audit(env.DB, org.id, user.id, "setup_pr", pr.url);
    const { accepted, edited, rejected } = result.counts;
    await audit(env.DB, org.id, user.id, "setup_reviewed", JSON.stringify({ repo: repo.full_name, accepted, edited, rejected }));
    return back(env, `/repos/${repo.id}`);
  } catch (err) {
    console.error("setup failed", repo.full_name, err);
    // Details stay in the logs.
    return back(env, "/dashboard", `Setup failed. Check that the GitHub App can access the repository, then try again.`);
  }
}
