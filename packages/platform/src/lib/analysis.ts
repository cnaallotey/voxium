import {
  AGENT_FILES,
  ARCH_FILE_PATH,
  BASELINE_FILE_PATH,
  buildGraphFromFiles,
  buildSetupFiles,
  buildSnapshot,
  checkArchitecture,
  failing,
  findProtectedChanges,
  inferArchitecture,
  isConfigPath,
  isSourcePath,
  locateCycle,
  moduleConnections,
  needsConnections,
  parseBaseline,
  tightenBaseline,
  uncheckedPaths,
  validateArchitecture,
  type Architecture,
  type CheckResult,
  type FileMap,
  type InferProposal,
  type CycleImport,
  type ProjectGraph,
  type ProtectedContents,
  type ScanCache,
  type Snapshot,
  type Exception,
  type Violation,
} from "@voxium/core";

/** Agent files that setup extends or writes, and whose Voxium block a check compares. */
export const EXTRA_FILES = new Set<string>([...AGENT_FILES, ".mcp.json"]);

/** Which files from a repo tarball we keep in memory: code, the config files that say what its imports stand for, and agent files. Everything else streams past. */
export function wantFile(path: string): boolean {
  return isSourcePath(path) || isConfigPath(path) || EXTRA_FILES.has(path);
}

export interface InferenceSummary {
  confidence: number;
  layers: string[];
  modules: Record<string, string[]>;
  notes: string[];
  existingViolations: number;
  files: number;
}

export interface SetupPlan {
  summary: InferenceSummary;
  setupFiles: Record<string, string>;
  baselineCount: number;
  /** Globs the plan proposes to leave out of the checks. */
  ignore: string[];
  /** Source and config files that could not be read, or not to their end, and that the plan cannot leave out. */
  unchecked: string[];
  /** Why each of those could not be read, when that is known. */
  reasons: Record<string, string>;
}

/** Setup proposes ignoring at most this many unreadable files one by one. Beyond that a person should look. */
const MAX_UNREAD_PROPOSALS = 20;

/**
 * Source paths in a commit that are missing from the files we read: too large, over the memory budget,
 * symlinked, or not in the tarball as committed. A check that skipped them proves nothing.
 */
export function unreadPaths(treePaths: string[], files: FileMap): string[] {
  return treePaths.filter((p) => isSourcePath(p) && !Object.hasOwn(files, p));
}

/**
 * The graph with unread files as empty nodes, so imports of them are seen even though their contents are not. With every
 * path of the tree, an import of a file that is not source code but would run as code is seen as well.
 */
export function graphWithUnread(files: FileMap, unread: string[], treePaths?: string[] | null, aliases?: Architecture["aliases"], configBefore?: FileMap, scans?: ScanCache): ProjectGraph {
  const all = unread.length ? { ...files, ...Object.fromEntries(unread.map((p) => [p, ""])) } : files;
  return buildGraphFromFiles(all, { ...(treePaths ? { paths: treePaths } : {}), aliases, configBefore, scans });
}

/** How many source and config files a list of unread paths has, in words. */
export function describeUnchecked(paths: string[]): string {
  const configs = paths.filter((p) => isConfigPath(p) && !isSourcePath(p)).length;
  const sources = paths.length - configs;
  return [sources ? `${sources} source file(s)` : "", configs ? `${configs} config file(s)` : ""].filter(Boolean).join(" and ");
}

/** An inferred architecture for a person to review before the setup pull request. Analysis output only, no source code. */
export interface SetupDraft {
  /** The architecture as inferred, which the person's edits apply to. */
  architecture: Architecture;
  /** How well the code supports each module, layer and rule. */
  proposals: InferProposal[];
  /** How many violations each rule finds in the code the draft was inferred from, by rule id. */
  violations: Record<string, number>;
  summary: InferenceSummary;
}

/** Source and config files that could not be read and that an architecture does not leave out, and why, when known. */
function uncheckedOf(graph: ProjectGraph, unread: string[], ignore: string[]): Pick<SetupPlan, "unchecked" | "reasons"> {
  const unknown = [...unread, ...graph.unparsed.map((u) => u.file)];
  const proposed = unknown.filter((p) => ignore.includes(p));
  const unchecked = proposed.length > MAX_UNREAD_PROPOSALS ? proposed : uncheckedPaths(graph, unknown, ignore);
  return { unchecked, reasons: Object.fromEntries(graph.unparsed.filter((u) => unchecked.includes(u.file)).map((u) => [u.file, u.reason])) };
}

/**
 * Infer an architecture for a repo, with what a person needs to review it, and the files that could not be read that it
 * does not leave out (with those, no draft should be offered).
 */
export function draftSetup(files: FileMap, treePaths?: string[]): SetupDraft & Pick<SetupPlan, "unchecked" | "reasons"> {
  const unread = treePaths ? unreadPaths(treePaths, files) : [];
  const graph = graphWithUnread(files, unread, treePaths);
  const inf = inferArchitecture(graph, { unread, packageJson: files["package.json"] ?? null });
  const violations: Record<string, number> = Object.fromEntries(inf.architecture.rules.map((r) => [r.id, 0]));
  for (const v of checkArchitecture(inf.architecture, graph).violations) violations[v.ruleId]++;
  return {
    ...uncheckedOf(graph, unread, inf.architecture.ignore ?? []),
    architecture: inf.architecture,
    proposals: inf.proposals,
    violations,
    summary: {
      confidence: inf.confidence,
      layers: inf.architecture.layers,
      modules: modulePaths(inf.architecture),
      notes: inf.notes,
      existingViolations: inf.existingViolations,
      files: graph.files.length,
    },
  };
}

const modulePaths = (arch: Architecture) => Object.fromEntries(Object.entries(arch.modules).map(([k, v]) => [k, v.paths]));

/**
 * Every file the setup pull request will contain for an architecture, with the baseline of the code as it is in these
 * files. `summary` is the inference the architecture came from.
 */
export function planSetup(arch: Architecture, summary: InferenceSummary, files: FileMap, treePaths?: string[], cliPackage?: string, owners?: string[]): SetupPlan {
  const unread = treePaths ? unreadPaths(treePaths, files) : [];
  const graph = graphWithUnread(files, unread, treePaths, arch.aliases);
  const ignore = arch.ignore ?? [];
  const result = checkArchitecture(arch, graph);
  const baseline = result.violations.filter((v) => v.severity === "block").map((v) => v.id);
  const setupFiles = buildSetupFiles({
    arch,
    baseline,
    existing: { "CLAUDE.md": files["CLAUDE.md"], "AGENTS.md": files["AGENTS.md"], ".mcp.json": files[".mcp.json"] },
    cliPackage,
    owners,
  });
  return {
    setupFiles,
    baselineCount: baseline.length,
    ignore,
    ...uncheckedOf(graph, unread, ignore),
    summary: { ...summary, layers: arch.layers, modules: modulePaths(arch), existingViolations: baseline.length, files: graph.files.length },
  };
}

/** Infer an architecture for a repo and prepare every file the setup PR will contain, accepting the inference as it is. */
export function prepareSetup(files: FileMap, treePaths?: string[], cliPackage?: string): SetupPlan {
  const draft = draftSetup(files, treePaths);
  return planSetup(draft.architecture, draft.summary, files, treePaths, cliPackage);
}

type Listed = Pick<Violation, "id" | "ruleId" | "severity" | "file" | "line" | "message" | "fix" | "rationale">;
const listed = ({ id, ruleId, severity, file, line, message, fix, rationale }: Violation): Listed => ({ id, ruleId, severity, file, line, message, fix, rationale });

export interface PrCheckOutcome {
  state: "success" | "failure" | "error";
  skipped: boolean;
  description: string;
  newViolations: Listed[];
  /**
   * New violations of rules with severity warn (first few), and how many there are. They never change the state or the
   * description. Checks stored before they were kept have neither.
   */
  warnings?: Listed[];
  warningCount?: number;
  /**
   * The code where the pull request branched off could not be read, so which warnings are new is not known and none is
   * listed. The state and the description are as they would be anyway.
   */
  warningsUnknown?: boolean;
  baselineCount: number;
  /** Protected files this PR alters. */
  protectedChanges: string[];
  /** Team Leader who approved those changes at this exact commit. */
  approvedBy: string | null;
  /** Source files that could not be read, or not to their end (first few), and how many there are. */
  unchecked: string[];
  uncheckedCount: number;
  /** What the new violations that are cycles consist of, by violation id. Not stored. */
  cycles: CheckResult["cycles"];
  /**
   * A cycle is what is left of an accepted one, so mergeBaseFiles is needed to tell whether it is new. Until then it
   * fails. Not stored.
   */
  needsBase: boolean;
  /**
   * There are warnings, and mergeBaseFiles is needed to tell which of them are new, which settleWarnings does. Until
   * then none is listed. It never changes the state or the description. Not stored.
   */
  pendingWarnings?: PendingWarnings;
  /** Exceptions that run out within two weeks. */
  expiring: Exception[];
  /** False when the code was not checked completely, so a violation that is not listed may still be there. */
  complete: boolean;
}

/** What is kept of a check. */
export type StoredOutcome = Omit<PrCheckOutcome, "cycles" | "needsBase" | "pendingWarnings">;

/** The warnings of a check that may be new, and the rules they were found with. */
export interface PendingWarnings {
  arch: Architecture;
  candidates: Violation[];
  today?: Date;
  /** What reading the files of the pull request found, so that the files the code it branched off shares are not read again. */
  scans: ScanCache;
}

const MAX_WARNINGS = 50;

/** How long before it runs out an exception is announced. */
const EXPIRING_DAYS = 14;

export interface PrCheckInput {
  headFiles: FileMap;
  /** Every path in the head commit, or null when GitHub could not list them all. */
  treePaths: string[] | null;
  /** Protected files at the tip of the base branch, where the PR branched off, and in the PR. */
  base: ProtectedContents;
  mergeBase: ProtectedContents;
  head: ProtectedContents;
  /**
   * The code where the PR branched off. Only needed when the outcome says so (needsBase), and then without it nothing is
   * accepted and no warning is listed.
   */
  mergeBaseFiles?: FileMap;
  /**
   * Every path in the commit the PR branched off, or null when GitHub could not list them all. The graph there is built
   * the way the head's is, with the files that could not be read as empty nodes, so that what depends on paths that are
   * not source code (an opaque import of a data file, a committed node_modules) is the same at both commits and an old
   * warning is not listed as new. Left out, only the paths of mergeBaseFiles count.
   */
  mergeBasePaths?: string[] | null;
  /**
   * The config files (package.json, tsconfig and the like) where the PR branched off. Imports resolve with them as well,
   * so that a PR that edits or removes a mapping still has its imports seen. Null when they could not be read, which
   * leaves the check incomplete. Left out, only the head's config files count.
   */
  mergeBaseConfig?: FileMap | null;
  /** Team Leader who approved the protected changes at this exact commit, if any. */
  approvedBy?: string | null;
  /** Agent files whose Voxium block the PR altered, from findRuleChanges. They need approval like the protected files. */
  blockChanges?: string[];
  today?: Date;
}

export function parseArch(text: string | null | undefined): Architecture | null {
  if (!text) return null;
  try {
    const arch = JSON.parse(text) as Architecture;
    return validateArchitecture(arch).ok ? arch : null;
  } catch {
    return null;
  }
}

/**
 * Check a pull request. Rules come from the base branch, so a PR cannot weaken the rules it is judged by.
 * A PR that alters the protected files fails until a Team Leader approves that exact commit, and is then
 * judged by the rules they approved. Anything we could not read is an error, never a pass.
 */
export function checkPullRequest(input: PrCheckInput): PrCheckOutcome {
  const { base, head } = input;
  const protectedChanges = [...findProtectedChanges(base, input.mergeBase, head), ...(input.blockChanges ?? [])];
  const approvedBy = protectedChanges.length ? (input.approvedBy ?? null) : null;
  const out: PrCheckOutcome = {
    state: "success",
    skipped: false,
    description: "",
    newViolations: [],
    warnings: [],
    warningCount: 0,
    baselineCount: 0,
    protectedChanges,
    approvedBy,
    unchecked: [],
    uncheckedCount: 0,
    cycles: new Map(),
    needsBase: false,
    expiring: [],
    complete: false,
  };
  if (!base[ARCH_FILE_PATH]) {
    return { ...out, skipped: true, description: "Voxium is not set up on the base branch." };
  }

  const names = protectedChanges.map((p) => p.split("/").pop()).join(", ");
  const unapproved = protectedChanges.length > 0 && !approvedBy;
  const note = unapproved ? `${names} changed: needs Team Leader approval. ` : approvedBy ? `${names} approved by ${approvedBy}. ` : "";

  const archChanged = protectedChanges.includes(ARCH_FILE_PATH);
  // Git would merge these edits with newer ones on the base branch that nobody checked or approved together.
  const stale = [ARCH_FILE_PATH, BASELINE_FILE_PATH].some(
    (p) => protectedChanges.includes(p) && (base[p] ?? null) !== (input.mergeBase[p] ?? null),
  );
  if (stale && approvedBy) {
    return { ...out, state: "failure", description: `The rules changed on the base branch since this PR branched. Update the branch, then approve again.` };
  }
  if (archChanged && approvedBy && !head[ARCH_FILE_PATH]) {
    return { ...out, description: `${note}Voxium is removed by this PR.` };
  }
  // Even an approval cannot merge rules that would break every later check.
  if (archChanged && head[ARCH_FILE_PATH] && !parseArch(head[ARCH_FILE_PATH])) {
    return { ...out, state: "failure", description: `${note}The new voxium/architecture.json is invalid.` };
  }
  const arch = parseArch(archChanged && approvedBy ? head[ARCH_FILE_PATH] : base[ARCH_FILE_PATH]);
  if (!arch) {
    const why = `${note}voxium/architecture.json on the base branch is invalid.`;
    return { ...out, state: "error", description: why };
  }
  const baseline =
    protectedChanges.includes(BASELINE_FILE_PATH) && approvedBy
      ? (parseBaseline(head[BASELINE_FILE_PATH]) ?? [])
      : head[BASELINE_FILE_PATH] === input.mergeBase[BASELINE_FILE_PATH]
        ? (parseBaseline(base[BASELINE_FILE_PATH]) ?? [])
        : tightenBaseline(base[BASELINE_FILE_PATH], head[BASELINE_FILE_PATH]);

  const unread = input.treePaths ? unreadPaths(input.treePaths, input.headFiles) : [];
  // Aliases come from the rules, which come from the base branch unless the change to them is approved.
  const scans: ScanCache = new Map();
  const graph = graphWithUnread(input.headFiles, unread, input.treePaths, arch.aliases, input.mergeBaseConfig ?? undefined, scans);
  const baseGraph = input.mergeBaseFiles && earlierGraph(input.mergeBaseFiles, input.mergeBasePaths, arch.aliases, scans);
  const connections = baseGraph && moduleConnections(arch, baseGraph);
  const result = checkArchitecture(arch, graph, { baseline, connections, today: input.today });
  const bad = failing(result);
  // An override that ran out fails a check as an exception that ran out does: it has to be renewed or removed.
  const expired = result.expiredExceptions.length + result.expiredOverrides.length;
  const now = input.today ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const soon = new Date(now.getTime() + EXPIRING_DAYS * 86_400_000).toISOString().slice(0, 10);
  const reasons = new Map(graph.unparsed.map((u) => [u.file, u.reason]));
  const unchecked = uncheckedPaths(graph, [...unread, ...reasons.keys()], arch.ignore);

  const counts = new Map<string, number>();
  for (const v of bad) counts.set(v.ruleId, (counts.get(v.ruleId) ?? 0) + 1);
  const list = [...counts].map(([r, n]) => `${r} x${n}`).join(", ");
  const gap = !input.treePaths
    ? "The repository is too large to check completely."
    : unchecked.length
      ? `${describeUnchecked(unchecked)} could not be read, for example ${unchecked[0]}${reasons.has(unchecked[0]) ? `, which ${reasons.get(unchecked[0])}` : ""}.`
      : input.mergeBaseConfig === null
        ? "The config files where this PR branched off could not be read, so a mapping it removes would not be seen."
        : "";
  const problems =
    bad.length || expired
      ? `${bad.length} new blocking violation(s)${list ? `: ${list}` : ""}${expired ? `, ${expired} expired exception(s) or override(s)` : ""}.`
      : "";

  // A warning is new when the code where the PR branched off does not have it under the same rules. Baselines hold only
  // blocking violations, so without that every warning in the repository would be listed on every pull request.
  const warned = result.violations.filter((v) => v.severity === "warn" && !v.baseline && !v.excepted);
  const pending: PendingWarnings | undefined = warned.length > 0 ? { arch, candidates: warned, today: input.today, scans } : undefined;
  const warnings = pending && baseGraph ? newWarnings(pending, baseGraph) : [];

  return {
    ...out,
    state: problems || unapproved ? "failure" : gap ? "error" : "success",
    description: `${note}${[problems, gap].filter(Boolean).join(" ") || "No new violations."}`,
    newViolations: bad.map(listed),
    warnings: warnings.slice(0, MAX_WARNINGS).map(listed),
    warningCount: warnings.length,
    baselineCount: result.violations.filter((v) => v.baseline).length,
    cycles: new Map([...result.cycles].filter(([id]) => bad.some((v) => v.id === id))),
    needsBase: needsConnections(result),
    ...(pending && !baseGraph ? { pendingWarnings: pending } : {}),
    unchecked: unchecked.slice(0, 20),
    uncheckedCount: unchecked.length,
    expiring: arch.exceptions.filter((e) => e.expires >= today && e.expires <= soon),
    complete: !gap,
  };
}

/** The graph of the code where a pull request branched off, built like the head's: unread source files are empty nodes. */
function earlierGraph(files: FileMap, paths: string[] | null | undefined, aliases: Architecture["aliases"], scans: ScanCache): ProjectGraph {
  return graphWithUnread(files, paths ? unreadPaths(paths, files) : [], paths, aliases, undefined, scans);
}

/**
 * The warnings that the code where the pull request branched off does not have under the same rules. Only the rules
 * with severity warn are checked there, since an id never depends on another rule.
 */
function newWarnings({ arch, candidates, today }: PendingWarnings, baseGraph: ProjectGraph): Violation[] {
  const warnOnly = { ...arch, rules: arch.rules.filter((r) => r.severity === "warn") };
  const earlier = new Set(checkArchitecture(warnOnly, baseGraph, { today }).violations.map((v) => v.id));
  return candidates.filter((v) => !earlier.has(v.id) && !(v.acceptedAs !== undefined && earlier.has(v.acceptedAs)));
}

/**
 * List the warnings of a check that are new, from the code where the pull request branched off, or say that they could
 * not be worked out when that code is null. Nothing else of the outcome changes, and the check is not run again.
 */
export function settleWarnings(outcome: PrCheckOutcome, mergeBaseFiles: FileMap | null, mergeBasePaths?: string[] | null): PrCheckOutcome {
  const { pendingWarnings: pending, ...rest } = outcome;
  if (!pending) return outcome;
  if (!mergeBaseFiles) return { ...rest, warnings: [], warningCount: 0, warningsUnknown: true };
  const warnings = newWarnings(pending, earlierGraph(mergeBaseFiles, mergeBasePaths, pending.arch.aliases, pending.scans));
  return { ...rest, warnings: warnings.slice(0, MAX_WARNINGS).map(listed), warningCount: warnings.length };
}

/** A file a pull request changes, and which of its lines are new. Null when GitHub does not say. */
export interface ChangedLines {
  path: string;
  added: Set<number> | null;
}

/**
 * Point new cycles at the imports this pull request adds. Without the diff, or when it does not show them, they stay
 * where the check put them. What counts as a violation does not change.
 */
export function locateNewCycles(outcome: PrCheckOutcome, changed: ChangedLines[]): PrCheckOutcome {
  const files = new Map(changed.map((c) => [c.path, c.added]));
  const isNew = (i: CycleImport): boolean => {
    if (i.via && files.has(i.via)) return true;
    const added = files.get(i.file);
    return added === null || (added !== undefined && i.line !== undefined && added.has(i.line));
  };
  return {
    ...outcome,
    newViolations: outcome.newViolations.map((v) => {
      const cycle = outcome.cycles.get(v.id);
      return cycle ? locateCycle(v, cycle.modules, cycle.imports, isNew) : v;
    }),
  };
}

/** What a snapshot of a branch holds, with whether every file of it could be read. */
export interface BranchSnapshot {
  complete: boolean;
  snapshot: Snapshot | null;
  counts: { new: number; baseline: number; excepted: number; warn: number };
}

/**
 * A snapshot of a branch by its own rules and baseline, read as a check reads a pull request: files that could not be
 * read, and code that could not be parsed, make it incomplete, so that it is never taken for one with nothing in it.
 * Null treePaths means GitHub could not list every file, which is incomplete too. Null when the branch has no valid rules.
 */
export function snapshotOf(files: FileMap, treePaths: string[] | null, protectedFiles: ProtectedContents, today: Date = new Date()): BranchSnapshot | null {
  const arch = parseArch(protectedFiles[ARCH_FILE_PATH]);
  if (!arch) return null;
  const baseline = parseBaseline(protectedFiles[BASELINE_FILE_PATH]);
  const unread = treePaths ? unreadPaths(treePaths, files) : [];
  const graph = graphWithUnread(files, unread, treePaths, arch.aliases);
  const result = checkArchitecture(arch, graph, { baseline: baseline ?? [], today });
  const unchecked = uncheckedPaths(graph, [...unread, ...graph.unparsed.map((u) => u.file)], arch.ignore);
  const snapshot = buildSnapshot(arch, graph, result, today);
  const { new: n, baseline: b, excepted, warn } = snapshot.totals;
  return { complete: treePaths !== null && baseline !== null && unchecked.length === 0, snapshot, counts: { new: n, baseline: b, excepted, warn } };
}
