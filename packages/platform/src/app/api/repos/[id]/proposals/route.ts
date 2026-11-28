import { applyEdits, ARCH_FILE_PATH, createProposal, isSourcePath } from "@voxium/core";
import { NextResponse, type NextRequest } from "next/server";
import { parseArch } from "@/lib/analysis";
import { getEnv } from "@/lib/env";
import { getBranchSha, getFileAtRef, listTree } from "@/lib/github";
import { openRepo } from "@/lib/open-repo";
import { rulesHash } from "@/lib/proposals";
import { fromThisSite } from "@/lib/same-origin";
import { parseEditForm, readForm } from "@/lib/setup";
import { audit, insertProposal } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Propose a change to the rules: an exception, accepting the current violations as debt, or an edited architecture. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const env = getEnv();
  const back = (path: string, error?: string) => {
    const url = new URL(path, env.APP_URL);
    if (error) url.searchParams.set("error", error);
    return NextResponse.redirect(url, 303);
  };
  if (!fromThisSite(req, env.APP_URL)) return back("/dashboard", "That request did not come from Voxium.");
  // Anyone GitHub lets open the repo may propose. Deciding is for Owners and Team Leaders.
  const open = await openRepo((await params).id);
  if (!open) return back("/dashboard", "Repository not found.");
  const { user, org, repo, token } = open;
  const page = `/repos/${repo.id}/proposals`;
  // Read up to a size, as a plain form only, before anything is done with it.
  const fields = await readForm(req);
  if (!fields) return back(page, "The form was too large or not sent from Voxium.");
  const text = (k: string) => fields.find(([name]) => name === k)?.[1] ?? "";
  const kind = text("kind");

  try {
    const sha = await getBranchSha(token, repo.full_name, repo.default_branch);
    const archText = await getFileAtRef(token, repo.full_name, ARCH_FILE_PATH, sha);
    const current = parseArch(archText);
    if (!current) return back(page, "Voxium is not set up on the default branch, or its rules are invalid.");
    const against = await rulesHash(archText);
    let architecture: unknown;
    let exception: unknown;
    let acceptDebt = false;
    if (kind === "exception") {
      if (!current.rules.some((r) => r.id === text("rule"))) return back(page, "Choose one of the rules.");
      if (!(text("expires") > new Date().toISOString().slice(0, 10))) return back(page, "An exception has to run out after today.");
      exception = { rule: text("rule"), file: text("file"), owner: user.login, reason: text("rationale"), expires: text("expires") };
    } else if (kind === "debt") {
      acceptDebt = true;
    } else if (kind === "architecture") {
      if (text("against") !== against) return back(page, "The rules changed while you were editing them. Start again from the current ones.");
      try {
        architecture = JSON.parse(text("architecture"));
      } catch {
        return back(page, "The architecture is not valid JSON.");
      }
      acceptDebt = text("acceptDebt") === "on";
    } else if (kind === "edits") {
      // The editor of the setup review, on the rules as they are.
      if (text("against") !== against) return back(page, "The rules changed while you were editing them. Start again from the current ones.");
      const parsed = parseEditForm(fields, current, ["kind", "against", "title", "summary", "rationale", "acceptDebt"]);
      if (!parsed.ok) return back(page, parsed.error);
      if (!Object.keys(parsed.edits).length) return back(page, "Change something in the architecture first.");
      // What the edits make, without matching a glob against a file, is held to the limits of a proposal first, so that
      // nobody can have the globs of a proposal too large to save matched against every file of the repo.
      const unmatched = applyEdits(current, parsed.edits);
      if (!unmatched.ok) return back(page, unmatched.errors[0].slice(0, 600));
      try {
        createProposal({ title: text("title"), summary: text("summary"), rationale: text("rationale"), architecture: unmatched.architecture, acceptDebt: text("acceptDebt") === "on" });
      } catch (err) {
        return back(page, (err as Error).message.slice(0, 600));
      }
      const tree = await listTree(token, repo.full_name, sha);
      const result = applyEdits(current, parsed.edits, tree ? [...tree.keys()].filter(isSourcePath) : undefined);
      if (!result.ok) return back(page, result.errors[0].slice(0, 600));
      architecture = result.architecture;
      acceptDebt = text("acceptDebt") === "on";
    } else {
      return back(page, "Choose what to propose.");
    }

    let p;
    try {
      p = createProposal({ title: text("title"), summary: text("summary"), rationale: text("rationale"), architecture, exception, acceptDebt });
    } catch (err) {
      return back(page, (err as Error).message.slice(0, 600));
    }
    const id = await insertProposal(env.DB, {
      repo_id: repo.id,
      source: "web",
      source_key: crypto.randomUUID(),
      requester_github_id: user.github_id,
      requester_login: user.login,
      title: p.title,
      summary: p.summary,
      rationale: p.rationale,
      change_json: JSON.stringify({ ...p.change, ...(architecture ? { against } : {}) }),
    });
    await audit(env.DB, org.id, user.id, "proposal_created", `${repo.full_name} #${id}`);
    return back(`/repos/${repo.id}/proposals/${id}`);
  } catch (err) {
    console.error("proposal failed", repo.full_name, err);
    return back(page, "The proposal could not be saved. Try again.");
  }
}
