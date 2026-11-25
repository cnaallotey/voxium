import {
  ARCH_FILE_PATH,
  BASELINE_FILE_PATH,
  buildGraphFromFiles,
  buildSetupFiles,
  checkArchitecture,
  failing,
  findProtectedChanges,
  inferArchitecture,
  isSourcePath,
  matchesAny,
  parseBaseline,
  tightenBaseline,
  validateArchitecture,
  type Architecture,
  type FileMap,
  type ProjectGraph,
  type ProtectedContents,
  type Violation,
} from "@voxium/core";

/** Agent files that setup extends rather than replaces. */
export const EXTRA_FILES = new Set(["CLAUDE.md", "AGENTS.md", ".mcp.json"]);

/** Which files from a repo tarball we keep in memory. Everything else streams past. */
export function wantFile(path: string): boolean {
  return isSourcePath(path) || EXTRA_FILES.has(path);
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
  /** Source files that could not be read and that the plan cannot leave out. */
  unchecked: string[];
}

/** Setup proposes ignoring at most this many unreadable files one by one. Beyond that a person should look. */
const MAX_UNREAD_PROPOSALS = 20;

/**
 * Source paths in a commit that are missing from the files we read: too large, over the memory budget,
 * symlinked, or not in the tarball as committed. A check that skipped them proves nothing.
 */
function unreadPaths(treePaths: string[], files: FileMap): string[] {
  return treePaths.filter((p) => isSourcePath(p) && !Object.hasOwn(files, p));
}

/** The graph with unread files as empty nodes, so imports of them are seen even though their contents are not. */
function graphWithUnread(files: FileMap, unread: string[]): ProjectGraph {
  return buildGraphFromFiles(unread.length ? { ...files, ...Object.fromEntries(unread.map((p) => [p, ""])) } : files);
}

/**
 * Unread files that matter. An ignored one is fine only while nothing that is checked leads to it, because
 * otherwise it could carry any import out of sight.
 */
function uncheckedPaths(graph: ProjectGraph, unread: string[], ignore: string[] = []): string[] {
  if (!unread.length) return [];
  const missing = new Set(unread);
  const next = new Map<string, string[]>();
  for (const e of graph.edges) if (e.to) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const queue = graph.files.filter((f) => !missing.has(f) && !matchesAny(f, ignore));
  const reached = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    for (const to of next.get(queue[i]) ?? []) {
      if (!reached.has(to)) {
        reached.add(to);
        queue.push(to);
      }
    }
  }
  return unread.filter((p) => reached.has(p) || !matchesAny(p, ignore));
}

/** Infer an architecture for a repo and prepare every file the setup PR will contain. */
export function prepareSetup(files: FileMap, treePaths?: string[], cliPackage?: string): SetupPlan {
  const unread = treePaths ? unreadPaths(treePaths, files) : [];
  const graph = graphWithUnread(files, unread);
  const inf = inferArchitecture(graph, { unread });
  const ignore = inf.architecture.ignore ?? [];
  const proposed = unread.filter((p) => ignore.includes(p));
  const unchecked = proposed.length > MAX_UNREAD_PROPOSALS ? proposed : uncheckedPaths(graph, unread, ignore);
  const result = checkArchitecture(inf.architecture, graph);
  const baseline = result.violations.filter((v) => v.severity === "block").map((v) => v.id);
  const setupFiles = buildSetupFiles({
    arch: inf.architecture,
    baseline,
    existing: { "CLAUDE.md": files["CLAUDE.md"], "AGENTS.md": files["AGENTS.md"], ".mcp.json": files[".mcp.json"] },
    cliPackage,
  });
  return {
    setupFiles,
    baselineCount: baseline.length,
    ignore,
    unchecked,
    summary: {
      confidence: inf.confidence,
      layers: inf.architecture.layers,
      modules: Object.fromEntries(Object.entries(inf.architecture.modules).map(([k, v]) => [k, v.paths])),
      notes: inf.notes,
      existingViolations: inf.existingViolations,
      files: graph.files.length,
    },
  };
}

export interface PrCheckOutcome {
  state: "success" | "failure" | "error";
  skipped: boolean;
  description: string;
  newViolations: Array<Pick<Violation, "ruleId" | "severity" | "file" | "message" | "fix">>;
  baselineCount: number;
  /** Protected files this PR alters. */
  protectedChanges: string[];
  /** Team Leader who approved those changes at this exact commit. */
  approvedBy: string | null;
  /** Source files that could not be read (first few), and how many there are. */
  unchecked: string[];
  uncheckedCount: number;
}

export interface PrCheckInput {
  headFiles: FileMap;
  /** Every path in the head commit, or null when GitHub could not list them all. */
  treePaths: string[] | null;
  /** Protected files at the tip of the base branch, where the PR branched off, and in the PR. */
  base: ProtectedContents;
  mergeBase: ProtectedContents;
  head: ProtectedContents;
  /** Team Leader who approved the protected changes at this exact commit, if any. */
  approvedBy?: string | null;
  today?: Date;
}

function parseArch(text: string | null | undefined): Architecture | null {
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
  const protectedChanges = findProtectedChanges(base, input.mergeBase, head);
  const approvedBy = protectedChanges.length ? (input.approvedBy ?? null) : null;
  const out: PrCheckOutcome = {
    state: "success",
    skipped: false,
    description: "",
    newViolations: [],
    baselineCount: 0,
    protectedChanges,
    approvedBy,
    unchecked: [],
    uncheckedCount: 0,
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
  const graph = graphWithUnread(input.headFiles, unread);
  const result = checkArchitecture(arch, graph, { baseline, today: input.today });
  const bad = failing(result);
  const expired = result.expiredExceptions.length;
  const unchecked = uncheckedPaths(graph, unread, arch.ignore);

  const counts = new Map<string, number>();
  for (const v of bad) counts.set(v.ruleId, (counts.get(v.ruleId) ?? 0) + 1);
  const list = [...counts].map(([r, n]) => `${r} x${n}`).join(", ");
  const gap = !input.treePaths
    ? "The repository is too large to check completely."
    : unchecked.length
      ? `${unchecked.length} source file(s) could not be read, for example ${unchecked[0]}.`
      : "";
  const problems =
    bad.length || expired
      ? `${bad.length} new blocking violation(s)${list ? `: ${list}` : ""}${expired ? `, ${expired} expired exception(s)` : ""}.`
      : "";

  return {
    ...out,
    state: problems || unapproved ? "failure" : gap ? "error" : "success",
    description: `${note}${[problems, gap].filter(Boolean).join(" ") || "No new violations."}`,
    newViolations: bad.map((v) => ({ ruleId: v.ruleId, severity: v.severity, file: v.file, message: v.message, fix: v.fix })),
    baselineCount: result.violations.filter((v) => v.baseline).length,
    unchecked: unchecked.slice(0, 20),
    uncheckedCount: unchecked.length,
  };
}
