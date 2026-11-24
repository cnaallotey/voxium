import {
  buildGraphFromFiles,
  buildSetupFiles,
  checkArchitecture,
  failing,
  inferArchitecture,
  isSourcePath,
  validateArchitecture,
  type Architecture,
  type FileMap,
  type Violation,
} from "@voxium/core";

const EXTRA_FILES = new Set(["CLAUDE.md", "AGENTS.md", ".mcp.json"]);

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
}

/** Infer an architecture for a repo and prepare every file the setup PR will contain. */
export function prepareSetup(files: FileMap): SetupPlan {
  const graph = buildGraphFromFiles(files);
  const inf = inferArchitecture(graph);
  const result = checkArchitecture(inf.architecture, graph);
  const baseline = result.violations.filter((v) => v.severity === "block").map((v) => v.id);
  const setupFiles = buildSetupFiles({
    arch: inf.architecture,
    baseline,
    existing: { "CLAUDE.md": files["CLAUDE.md"], "AGENTS.md": files["AGENTS.md"], ".mcp.json": files[".mcp.json"] },
  });
  return {
    setupFiles,
    baselineCount: baseline.length,
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
  architectureChanged: boolean;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Check a pull request. Rules come from the BASE branch, so a PR cannot weaken the rules it is judged by.
 * If the PR edits the architecture files, that is reported and the base rules still apply.
 */
export function checkPullRequest(
  headFiles: FileMap,
  baseArchitectureJson: string | null,
  baseBaselineJson: string | null,
  headArchitectureJson: string | null,
  today?: Date,
): PrCheckOutcome {
  const empty = { newViolations: [], baselineCount: 0, architectureChanged: false };
  if (!baseArchitectureJson) {
    return { ...empty, state: "success", skipped: true, description: "Voxium is not set up on the base branch." };
  }
  const arch = parseJson<Architecture>(baseArchitectureJson);
  const valid = arch ? validateArchitecture(arch) : { ok: false, errors: ["not valid JSON"] };
  if (!arch || !valid.ok) {
    return { ...empty, state: "error", skipped: false, description: "voxium/architecture.json on the base branch is invalid." };
  }
  const baseline = parseJson<{ violations?: string[] }>(baseBaselineJson)?.violations ?? [];
  const architectureChanged = headArchitectureJson !== null && headArchitectureJson !== baseArchitectureJson;

  const result = checkArchitecture(arch, buildGraphFromFiles(headFiles), { baseline, today });
  const bad = failing(result);
  const expired = result.expiredExceptions.length;
  const baselineCount = result.violations.filter((v) => v.baseline).length;

  const counts = new Map<string, number>();
  for (const v of bad) counts.set(v.ruleId, (counts.get(v.ruleId) ?? 0) + 1);
  const list = [...counts].map(([r, n]) => `${r} x${n}`).join(", ");
  const note = architectureChanged ? " Architecture files changed: base rules applied, Team Leader review required." : "";

  const failed = bad.length > 0 || expired > 0;
  const description = failed
    ? `${bad.length} new blocking violation(s)${list ? `: ${list}` : ""}${expired ? `, ${expired} expired exception(s)` : ""}.${note}`
    : `No new violations.${note}`;

  return {
    state: failed ? "failure" : "success",
    skipped: false,
    description,
    newViolations: bad.map((v) => ({ ruleId: v.ruleId, severity: v.severity, file: v.file, message: v.message, fix: v.fix })),
    baselineCount,
    architectureChanged,
  };
}
