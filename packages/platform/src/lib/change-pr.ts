import {
  AGENT_FILES,
  ARCH_FILE_PATH,
  BASELINE_FILE_PATH,
  buildSetupFiles,
  checkArchitecture,
  cliPackageInWorkflow,
  describeRuleChanges,
  failing,
  findProtectedChanges,
  moduleConnections,
  needsConnections,
  parseBaseline,
  PROTECTED_FILES,
  uncheckedPaths,
  validateArchitecture,
  WORKFLOW_FILE_PATH,
  GITLAB_FILE_PATH,
  type Architecture,
  type CheckResult,
  type FileMap,
  type ProtectedContents,
  type Violation,
} from "@voxium/core";
import { EXTRA_FILES, graphWithUnread, parseArch, unreadPaths, wantFile } from "./analysis";
import { fetchTarball, getBranchSha, getFileAtRef, listTree } from "./github";
import { readProtected } from "./repo-job";
import { readTarGz } from "./tar";

/** Agent files a change to the rules regenerates. The workflow and .mcp.json are not about the rules, so they stay. */
const REGENERATED: readonly string[] = AGENT_FILES;

export interface ChangePlan {
  /** Files for the pull request: only those that change. */
  files: Record<string, string>;
  /** What the change does to the rules, in plain sentences. */
  changes: string[];
  /**
   * Violations on the branch that the new rules make new: failing under them and not under the current rules. For a
   * proposal that keeps the rules and only accepts debt, every violation that fails now.
   */
  newViolations: Array<Pick<Violation, "id" | "ruleId" | "file" | "message">>;
  /** Violations of a change to the rules that fail under the current rules as well. They are never accepted with it. */
  preexisting: Array<Pick<Violation, "id" | "ruleId" | "file" | "message">>;
  /** Ids added to the baseline: exactly newViolations, when debt is accepted. */
  accepted: string[];
  /** The rules stay as they are and only the debt is accepted. */
  debtOnly: boolean;
  /** Exceptions of the new rules that have run out, which would fail every check. */
  expired: number;
  /** Code that could not be read, so nothing is planned. */
  unchecked: string[];
}

/**
 * The files a change to the rules needs, checked against the code of a branch: the new architecture, the baseline with
 * exactly the violations it makes new when that debt is accepted, and regenerated agent rules. newArch null keeps the
 * architecture as it is, and then accepting debt accepts what fails now.
 * Violations that already fail under the current rules were not made by the change. Accepting them with it would hide
 * whatever was merged around the check, so they are only listed. They are matched by the code they are about, not by
 * their ids, since a change to a rule id or a module name changes the id of the same failure.
 */
export function prepareChange(
  files: FileMap,
  treePaths: string[],
  protectedFiles: ProtectedContents,
  newArch: Architecture | null,
  acceptDebt: boolean,
): ChangePlan {
  const current = parseArch(protectedFiles[ARCH_FILE_PATH]);
  if (!current) throw new Error("voxium/architecture.json on the default branch is missing or invalid.");
  const baseline = parseBaseline(protectedFiles[BASELINE_FILE_PATH]);
  if (baseline === null) throw new Error("voxium/baseline.json on the default branch cannot be read.");
  const arch = newArch ?? current;
  if (!validateArchitecture(arch).ok) throw new Error("The proposed architecture is invalid.");
  for (const p of REGENERATED) if (treePaths.includes(p) && !Object.hasOwn(files, p)) throw new Error(`${p} could not be read.`);

  const unread = unreadPaths(treePaths, files);
  const graph = graphWithUnread(files, unread, treePaths, arch.aliases);
  const unchecked = uncheckedPaths(graph, [...unread, ...graph.unparsed.map((u) => u.file)], arch.ignore);
  const debtOnly = newArch === null;
  const sameAliases = JSON.stringify(current.aliases ?? null) === JSON.stringify(arch.aliases ?? null);
  if (unchecked.length) return { files: {}, changes: [], newViolations: [], preexisting: [], accepted: [], debtOnly, expired: 0, unchecked };

  // Debt accepted under a rule means a violation of that rule. When the change gives the rule's id another type, the same
  // id would mean something else, so its debt is not carried over: what fails under the new type is listed as such.
  const retyped = arch.rules.filter((r) => current.rules.some((c) => c.id === r.id && c.type !== r.type)).map((r) => `${r.id}:`);
  const kept = baseline.filter((id) => !retyped.some((prefix) => id.startsWith(prefix)));
  const evaluate = (rules: Architecture, g: typeof graph, debt: string[]) => {
    const res = checkArchitecture(rules, g, { baseline: debt });
    // What is left of an accepted cycle is judged against the branch itself, which is all the code there is.
    return needsConnections(res) ? checkArchitecture(rules, g, { baseline: debt, connections: moduleConnections(rules, g) }) : res;
  };
  const result = evaluate(arch, graph, kept);
  const fresh = failing(result);
  const was = debtOnly ? null : evaluate(current, sameAliases ? graph : graphWithUnread(files, unread, treePaths, current.aliases), baseline);
  const before = new Set(was ? failing(was).flatMap((v) => tracesOf(v, current, was)) : []);
  const isOld = (v: Violation) => tracesOf(v, arch, result).some((t) => before.has(t));
  const made = fresh.filter((v) => !isOld(v));
  const preexisting = fresh.filter(isOld);
  const accepted = acceptDebt ? made.map((v) => v.id) : [];
  const setup = buildSetupFiles({
    arch,
    baseline: [...kept, ...accepted],
    existing: Object.fromEntries(REGENERATED.map((p) => [p, files[p]])),
    // The version the agent rules name, as the check renders the block it expects.
    cliPackage: cliPackageInWorkflow(protectedFiles[WORKFLOW_FILE_PATH]) ?? cliPackageInWorkflow(protectedFiles[GITLAB_FILE_PATH]),
  });
  const out: Record<string, string> = {};
  if (JSON.stringify(arch) !== JSON.stringify(current)) out[ARCH_FILE_PATH] = setup[ARCH_FILE_PATH];
  if (accepted.length || kept.length < baseline.length) out[BASELINE_FILE_PATH] = setup[BASELINE_FILE_PATH];
  for (const p of REGENERATED) if (treePaths.includes(p) && setup[p] !== files[p]) out[p] = setup[p];

  const after: ProtectedContents = { ...protectedFiles };
  for (const p of PROTECTED_FILES) if (Object.hasOwn(out, p)) after[p] = out[p];
  return {
    files: out,
    changes: describeRuleChanges(protectedFiles, after, findProtectedChanges(protectedFiles, protectedFiles, after)),
    newViolations: made.map(brief),
    preexisting: preexisting.map(brief),
    accepted,
    debtOnly,
    expired: result.expiredExceptions.length + result.expiredOverrides.length,
    unchecked: [],
  };
}

const brief = ({ id, ruleId, file, message }: Violation) => ({ id, ruleId, file, message });

/**
 * What a violation is about in the code, without the names the rules give: rule ids and module names can change with
 * the rules, and the same code must still count as failing. An import is one trace whatever rule it breaks (layers,
 * dependency or cycle), so moving it from one rule to another does not make it new either. Matching a trace of the
 * current rules makes a violation preexisting, so a trace that is coarser than the violation errs on the safe side.
 */
function tracesOf(v: Violation, rules: Architecture, result: CheckResult): string[] {
  const rule = rules.rules.find((r) => r.id === v.ruleId);
  const key = v.id.startsWith(`${v.ruleId}:`) ? v.id.slice(v.ruleId.length + 1) : v.id;
  const out = [`id:${v.id}`];
  switch (rule?.type) {
    case "layers":
    case "deny_dependency": {
      // An import through a file outside every module is keyed by the module it reaches, which is only a name.
      const mod = Object.keys(rules.modules)
        .filter((m) => key.endsWith(`=>${m}`))
        .sort((a, b) => b.length - a.length)[0];
      out.push(`import:${mod === undefined ? key : key.slice(0, -(mod.length + 2))}`);
      break;
    }
    case "no_cycles":
      for (const i of result.cycles.get(v.id)?.imports ?? []) out.push(`import:${i.file}->${i.via ?? i.to}`);
      break;
    case "deny_external":
      out.push(`package:${key}`);
      break;
    case "public_api": {
      // An import through a file outside every module ends in the module it reaches once that is more than MAX_REACHED
      // files, and in a file of it below that: both are only names of what the rules say, so the trace stops at the
      // outside file. Matching on the first "=>" is coarser when a path holds one, the same way for both rules.
      const rest = key.startsWith(`${v.file}->`) ? key.slice(v.file.length + 2) : key;
      const via = rest.indexOf("=>");
      // The same namespace as layers, dependency and cycle rules: moving an import from public_api to one of them, or
      // back, must not make a violation that fails now look new.
      out.push(`import:${v.file}->${via < 0 ? rest : rest.slice(0, via)}`);
      break;
    }
    default:
      out.push(`${rule?.type ?? "unknown"}:${key}`);
  }
  return out;
}

export interface Branch {
  sha: string;
  treePaths: string[];
  files: FileMap;
  protectedFiles: ProtectedContents;
}

/** The code and rules of a branch, as a check reads them. Null when GitHub cannot list all of its files. */
export async function readBranch(token: string, fullName: string, branch: string): Promise<Branch | null> {
  const sha = await getBranchSha(token, fullName, branch);
  const tree = await listTree(token, fullName, sha);
  if (!tree) return null;
  const files = await readTarGz(await fetchTarball(token, fullName, sha), { want: wantFile, expect: tree });
  // The agent files are extended, so a copy missing from the archive must not look like no file at all.
  for (const p of EXTRA_FILES) {
    if (!tree.has(p) || Object.hasOwn(files, p)) continue;
    const text = await getFileAtRef(token, fullName, p, sha);
    if (text !== null) files[p] = text;
  }
  return { sha, treePaths: [...tree.keys()], files, protectedFiles: await readProtected(token, fullName, sha) };
}
