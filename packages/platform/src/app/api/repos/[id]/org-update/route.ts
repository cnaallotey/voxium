import { applyOrgRules, ARCH_FILE_PATH, createProposal, describeRuleChanges } from "@voxium/core";
import { NextResponse, type NextRequest } from "next/server";
import { canManage, githubStanding, resolveRole } from "@/lib/access";
import { parseArch } from "@/lib/analysis";
import { getEnv } from "@/lib/env";
import { getBranchSha, getFileAtRef } from "@/lib/github";
import { openRepo } from "@/lib/open-repo";
import { setRules } from "@/lib/org-rules";
import { rulesHash } from "@/lib/proposals";
import { fromThisSite } from "@/lib/same-origin";
import { readForm } from "@/lib/setup";
import { audit, insertProposal, latestOrgRuleSet } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Bring a repository's organization rules to the newest version of the set, as a proposal: its pull request is opened
 * on the proposal's page, which lists what would newly fail, and is approved in Voxium by someone other than the person
 * who asked, as every proposal is. For an Owner or Team Leader with write access to this repository.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const env = getEnv();
  const back = (path: string, error?: string) => {
    const url = new URL(path, env.APP_URL);
    if (error) url.searchParams.set("error", error);
    return NextResponse.redirect(url, 303);
  };
  if (!fromThisSite(req, env.APP_URL)) return back("/dashboard", "That request did not come from Voxium.");
  // GitHub is asked whether this person can open this repository, so a Team Leader without access learns nothing.
  const open = await openRepo((await params).id);
  if (!open) return back("/dashboard", "Repository not found.");
  const { user, org, repo, role, level, token } = open;
  const page = `/orgs/${org.id}/rules`;
  const fields = await readForm(req);
  if (!fields) return back(page, "The form was too large or not sent from Voxium.");
  try {
    if (!canManage(resolveRole(await githubStanding(token, org, user), role)) || level === "read") {
      return back(page, "Only an Owner or Team Leader with write access to the repository can propose an update of its rules.");
    }
    const set = await latestOrgRuleSet(env.DB, org.id);
    if (!set) return back(page, "The organization has no rule set yet.");
    const sha = await getBranchSha(token, repo.full_name, repo.default_branch);
    const archText = await getFileAtRef(token, repo.full_name, ARCH_FILE_PATH, sha);
    const current = parseArch(archText);
    if (!current) return back(page, `${repo.full_name} is not set up, or its rules are invalid.`);
    const applied = applyOrgRules(current, { version: set.version, rules: setRules(set) }, org.account_login);
    if (applied.conflicts.length) return back(page, `${repo.full_name}: ${applied.conflicts.slice(0, 3).join(" ")}`.slice(0, 900));
    if (JSON.stringify(applied.arch) === JSON.stringify(current)) return back(page, `${repo.full_name} has version ${set.version} already.`);

    const before = { [ARCH_FILE_PATH]: archText };
    const after = { [ARCH_FILE_PATH]: `${JSON.stringify(applied.arch, null, 2)}\n` };
    const changes = describeRuleChanges(before, after, [ARCH_FILE_PATH]);
    const acceptDebt = fields.some(([k, v]) => k === "acceptDebt" && v === "on");
    let p;
    try {
      p = createProposal({
        title: `Organization rules version ${set.version}`,
        summary: changes.slice(0, 20).join("\n").slice(0, 2000),
        rationale: `${set.note}`.slice(0, 4000),
        architecture: applied.arch,
        acceptDebt,
      });
    } catch (err) {
      return back(page, (err as Error).message.slice(0, 600));
    }
    const id = await insertProposal(env.DB, {
      repo_id: repo.id,
      source: "web",
      source_key: `org:${set.version}:${crypto.randomUUID()}`,
      requester_github_id: user.github_id,
      requester_login: user.login,
      title: p.title,
      summary: p.summary,
      rationale: p.rationale,
      change_json: JSON.stringify({ ...p.change, against: await rulesHash(archText) }),
    });
    await audit(env.DB, org.id, user.id, "org_update_proposed", `${repo.full_name} #${id} to version ${set.version}`);
    return back(`/repos/${repo.id}/proposals/${id}`);
  } catch (err) {
    console.error("organization rules update failed", repo.full_name, err);
    return back(page, "The update could not be prepared. Try again.");
  }
}
