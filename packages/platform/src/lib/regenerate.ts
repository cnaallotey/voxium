import {
  AGENT_FILES,
  ARCH_FILE_PATH,
  BASELINE_FILE_PATH,
  buildSetupFiles,
  cliPackageInWorkflow,
  CODEOWNERS_PATH,
  DEPCRUISE_FILE_PATH,
  GITLAB_FILE_PATH,
  parseBaseline,
  PRE_COMMIT_PATH,
  PROTECTED_FILES,
  WORKFLOW_FILE_PATH,
  type ProtectedContents,
} from "@voxium/core";
import { parseArch } from "./analysis";
import { code } from "./markdown";

export const SYNC_BRANCH = "voxium/sync";

/** Every file Voxium generates besides the rules themselves. */
export const GENERATED_FILES = [...AGENT_FILES, CODEOWNERS_PATH, ".mcp.json", WORKFLOW_FILE_PATH, GITLAB_FILE_PATH, PRE_COMMIT_PATH, DEPCRUISE_FILE_PATH];

/**
 * The generated files that differ from what the rules give, with what they should hold. `rules` are the protected files
 * of the default branch and `current` the generated files there (null when missing). The CLI the workflow pins stays,
 * and dependency-cruiser rules are only written where they are already. The rules themselves are never rewritten.
 */
export function filesToRegenerate(rules: ProtectedContents, current: ProtectedContents, owners: string[]): Record<string, string> {
  const arch = parseArch(rules[ARCH_FILE_PATH]);
  const baseline = parseBaseline(rules[BASELINE_FILE_PATH]);
  if (!arch || baseline === null) throw new Error("The rules on the default branch are missing or invalid.");
  const files = buildSetupFiles({
    arch,
    baseline,
    cliPackage: cliPackageInWorkflow(rules[WORKFLOW_FILE_PATH]) ?? cliPackageInWorkflow(rules[GITLAB_FILE_PATH]),
    owners,
    withTests: (current[DEPCRUISE_FILE_PATH] ?? null) !== null,
    existing: Object.fromEntries(["CLAUDE.md", "AGENTS.md", ".mcp.json"].map((p) => [p, current[p] ?? undefined])),
  });
  return Object.fromEntries(Object.entries(files).filter(([p, text]) => p !== ARCH_FILE_PATH && p !== BASELINE_FILE_PATH && text !== (current[p] ?? null)));
}

/** The description of the pull request that brings the generated files up to date. */
export function regeneratePrBody(files: Record<string, string>): string {
  const paths = Object.keys(files).sort();
  const guarded = paths.filter((p) => (PROTECTED_FILES as readonly string[]).includes(p));
  return [
    "Brings the files Voxium generates up to date with the rules on the default branch.",
    "",
    ...paths.map((p) => `* ${code(p)}`),
    "",
    "In CLAUDE.md and AGENTS.md only the Voxium block changes. The rules themselves do not change.",
    ...(guarded.length ? ["", `${guarded.map(code).join(", ")} run the check, so a Team Leader approves this pull request like a change to the rules.`] : []),
  ].join("\n");
}
