import { ARCH_FILE_PATH, renderCodeowners, type Architecture, type ArchitectureEdits, type EditCounts, type FileMap, type ModuleEdit, type RuleEdit } from "@voxium/core";
import { canManage, githubStanding, resolveRole } from "./access";
import { EXTRA_FILES, wantFile, type SetupDraft, type SetupPlan } from "./analysis";
import { fetchTarball, getBranchSha, getFileAtRef, listTree } from "./github";
import { code, plain } from "./markdown";
import { openRepo, type OpenRepo } from "./open-repo";
import { rulesHash } from "./proposals";
import type { D1Database } from "./d1";
import { listPeople, type SetupDraftRow } from "./store";
import { readTarGz } from "./tar";

/** What is stored for a repo between inferring its architecture and opening the setup pull request. */
export interface StoredDraft extends SetupDraft {
  /** The edits last sent, shown again so that nothing typed is lost when they are refused or need a second look. */
  edits?: ArchitectureEdits;
  /** Why those edits were refused, or what to look at before opening the pull request with them. */
  errors?: string[];
  warnings?: string[];
  /** The last time a pull request was opened from this draft. */
  submitted?: { by: string; at: string; sha: string; counts: EditCounts };
  /** Someone sent the draft and Voxium is opening the pull request, which has not been opened yet. */
  opening?: { by: string; at: string; id: string };
}

export type SetupAccess = { ok: true; open: OpenRepo } | { ok: false; error: string };

/**
 * The repo, for an Owner or Team Leader whom GitHub confirms right now and who can write to it. Everyone else gets a
 * reason that names no repository unless GitHub lets them open it. The draft, its page and the pull request all go
 * through here.
 */
export async function openSetup(id: string): Promise<SetupAccess> {
  const open = await openRepo(id);
  if (!open) return { ok: false, error: "Repository not found." };
  try {
    if (!canManage(resolveRole(await githubStanding(open.token, open.org, open.user), open.role))) {
      return { ok: false, error: "Only an Owner or Team Leader can set up Voxium." };
    }
  } catch (err) {
    console.error("standing check failed", open.repo.full_name, err);
    return { ok: false, error: "Repository not found." };
  }
  if (open.level === "read") return { ok: false, error: `You need write access to ${open.repo.full_name} to set up Voxium.` };
  return { ok: true, open };
}

/** The logins of the org's current Owners and Team Leaders, who own the rules in the suggested CODEOWNERS. */
export async function ruleOwners(db: D1Database, orgId: number): Promise<string[]> {
  const logins = (await listPeople(db, orgId)).filter((p) => p.state === "active" && canManage(p.role)).map((p) => p.login);
  // renderCodeowners refuses anything that is not a GitHub login, which one odd row must not turn into a failed setup.
  return logins.filter((login) => {
    try {
      renderCodeowners([login]);
      return true;
    } catch {
      return false;
    }
  });
}

/** A form body is at most this large: a draft has at most a few hundred modules and rules, and 1000 ignored globs. */
export const MAX_FORM_BYTES = 256 * 1024;

/** The fields of a form sent from Voxium, read up to MAX_FORM_BYTES. Null when the body is larger or not a plain form. */
export async function readForm(req: Request, max = MAX_FORM_BYTES): Promise<Array<[string, string]> | null> {
  if (!req.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return null;
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return [...new URLSearchParams(new TextDecoder().decode(bytes))];
}

/** A hash of a stored draft, sent with its form, so that a form for a draft that changed since is refused. */
export function draftHash(row: Pick<SetupDraftRow, "draft_json">): Promise<string> {
  return rulesHash(row.draft_json);
}

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The edits a form of the architecture editor says, for the architecture it was drawn for. Fields are named by the
 * position of a module, layer or rule, never by a name from the repository. A field the editor does not send, one sent
 * twice, or a value that is not one the editor offers is refused, so a form cannot add rules, exceptions or anything else.
 * `extra` are the other fields the form may have.
 */
export function parseEditForm(fields: Array<[string, unknown]>, arch: Architecture, extra: string[] = []): { ok: true; edits: ArchitectureEdits } | { ok: false; error: string } {
  const modules = Object.keys(arch.modules);
  const allowed = new Set(["ignore", ...extra]);
  modules.forEach((_, i) => ["keep", "name", "paths"].forEach((f) => allowed.add(`m${i}.${f}`)));
  arch.layers.forEach((_, i) => allowed.add(`l${i}.pos`));
  arch.rules.forEach((_, i) => ["on", "severity"].forEach((f) => allowed.add(`r${i}.${f}`)));
  const values = new Map<string, string>();
  for (const [k, v] of fields) {
    if (!allowed.has(k) || values.has(k) || typeof v !== "string") return { ok: false, error: "The form has fields the editor does not send. Reload the page and try again." };
    values.set(k, v);
  }
  const get = (k: string) => values.get(k);

  // Own entries even for a name such as "__proto__", which an assignment would not create.
  const moduleEdits: Array<[string, ModuleEdit]> = [];
  modules.forEach((name, i) => {
    const edit: ModuleEdit = {};
    if (get(`m${i}.keep`) !== "on") edit.reject = true;
    const to = get(`m${i}.name`)?.trim();
    if (to !== undefined && to !== name) edit.rename = to;
    const paths = get(`m${i}.paths`);
    if (paths !== undefined && !same(lines(paths), arch.modules[name].paths)) edit.paths = lines(paths);
    if (Object.keys(edit).length) moduleEdits.push([name, edit]);
  });

  const positions: number[] = [];
  for (let i = 0; i < arch.layers.length; i++) {
    const raw = get(`l${i}.pos`);
    const pos = raw === undefined ? i + 1 : Number(raw);
    if (!Number.isInteger(pos) || pos < 1 || pos > arch.layers.length) return { ok: false, error: `Each place in the layer order must be a number from 1 to ${arch.layers.length}.` };
    positions.push(pos);
  }
  // Two layers given the same place keep the order they had.
  const layers = arch.layers.map((l, i) => ({ l, i, pos: positions[i] })).sort((a, b) => a.pos - b.pos || a.i - b.i).map((x) => x.l);

  const ruleEdits: Array<[string, RuleEdit]> = [];
  for (const [i, r] of arch.rules.entries()) {
    const edit: RuleEdit = {};
    if (get(`r${i}.on`) !== "on") edit.off = true;
    const severity = get(`r${i}.severity`);
    if (severity !== undefined && severity !== "block" && severity !== "warn") return { ok: false, error: "A rule can only be block or warn." };
    if (severity !== undefined && severity !== r.severity) edit.severity = severity;
    if (Object.keys(edit).length) ruleEdits.push([r.id, edit]);
  }

  const edits: ArchitectureEdits = {};
  if (moduleEdits.length) edits.modules = Object.fromEntries(moduleEdits);
  if (!same(layers, arch.layers)) edits.layers = layers;
  if (ruleEdits.length) edits.rules = Object.fromEntries(ruleEdits);
  const ignore = get("ignore");
  if (ignore !== undefined && !same(lines(ignore), arch.ignore ?? [])) edits.ignore = lines(ignore);
  return { ok: true, edits };
}

export type DefaultBranch =
  | { kind: "code"; sha: string; tree: Map<string, string>; files: FileMap }
  | { kind: "rules" }
  | { kind: "too_large" };

/**
 * The code at the tip of the default branch, with the agent files setup adds to. Says so instead when rules are there
 * already, which nothing inferred may replace, or when GitHub cannot list every file.
 */
export async function readDefaultBranch({ token, repo }: Pick<OpenRepo, "token" | "repo">): Promise<DefaultBranch> {
  const sha = await getBranchSha(token, repo.full_name, repo.default_branch);
  const tree = await listTree(token, repo.full_name, sha);
  if (!tree) return { kind: "too_large" };
  if (tree.has(ARCH_FILE_PATH)) return { kind: "rules" };
  const files = await readTarGz(await fetchTarball(token, repo.full_name, sha), { want: wantFile, expect: tree });
  // Setup adds to these files, so a copy missing from the archive must not look like no file at all.
  for (const p of EXTRA_FILES) {
    if (!tree.has(p) || Object.hasOwn(files, p)) continue;
    const text = await getFileAtRef(token, repo.full_name, p, sha);
    if (text !== null) files[p] = text;
  }
  return { kind: "code", sha, tree, files };
}

/** The description of the setup pull request. Names from the repository are shown as code or plain text, never as Markdown. */
export function setupPrBody(plan: SetupPlan, cliPackage: string | undefined, review: { counts: EditCounts; warnings: string[] }): string {
  const { counts, warnings } = review;
  return [
    "This PR sets up Voxium for this repository.",
    "",
    `${plan.summary.layers.length} layers, top to bottom (inferred with confidence ${(plan.summary.confidence * 100).toFixed(0)}%): ${plan.summary.layers.map(code).join(" > ")}.`,
    `Reviewed in Voxium before this PR was opened: ${counts.accepted} part(s) accepted as inferred, ${counts.edited} edited, ${counts.rejected} rejected.`,
    `${plan.baselineCount} existing violation(s) are recorded as baseline, so only new ones fail.`,
    ...(plan.ignore.length ? [`Not checked, please confirm none of it is source code: ${plan.ignore.map(code).join(", ")}.`] : []),
    ...(warnings.length ? ["", "Please check:", ...warnings.map((w) => `* ${plain(w)}`)] : []),
    "",
    cliPackage
      ? `The GitHub Actions job and .mcp.json run ${code(cliPackage)} from npm.`
      : "No GitHub Actions job or MCP server is added, because this Voxium has no published CLI configured. The `voxium/rules` status checks pull requests once this is merged, so require it on the default branch.",
    "",
    "Review voxium/architecture.json before merging. Add voxium/CODEOWNERS.suggested to .github/CODEOWNERS so only Team Leaders can change the rules.",
  ].join("\n");
}
