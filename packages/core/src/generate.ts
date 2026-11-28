import { styleName } from "./conventions.js";
import { DEPCRUISE_FILE_PATH, renderDependencyCruiser } from "./depcruise.js";
import {
  ARCH_FILE_PATH,
  BLOCK_END,
  BLOCK_START,
  CURSOR_FRONTMATTER,
  CURSOR_RULES_PATH,
  GITLAB_FILE_PATH,
  looksLikeMarker,
  WORKFLOW_FILE_PATH,
  type ProtectedContents,
} from "./protect.js";
import { EVERY_MODULE, validateArchitecture } from "./schema.js";
import type { Architecture } from "./types.js";

export { BLOCK_END, BLOCK_START };
export const PRE_COMMIT_PATH = "voxium/hooks/pre-commit";
export const CODEOWNERS_PATH = "voxium/CODEOWNERS.suggested";

/**
 * Check the npm package that generated files may download and run, such as "voxium@1.2.3".
 * Only an exact version is accepted. Those files run on developer machines and in CI, so a bare name
 * would hand both to whoever owns that name on npm. No package means generated files run nothing.
 */
export function parseCliPackage(spec: string | null | undefined): string | undefined {
  const s = spec?.trim();
  if (!s) return undefined;
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(s)) {
    throw new Error("The Voxium CLI package must be an exact published version, such as voxium@1.2.3.");
  }
  return s;
}

/** The package a workflow or GitLab job written by Voxium already runs, if it is pinned. */
export function cliPackageInWorkflow(workflow: string | null | undefined): string | undefined {
  const spec = /^\s*(?:run: |- )npx --yes (\S+) check --root /m.exec(workflow ?? "")?.[1];
  try {
    return parseCliPackage(spec);
  } catch {
    return undefined;
  }
}

/**
 * Text from the rules on one line, so that it cannot start a heading or an instruction of its own, and with no comment
 * marker, so that it cannot end the managed block early or start a second one.
 */
function text(value: string): string {
  let s = value.replace(/[\s\p{C}\p{Z}]+/gu, " ").trim().replace(/<!--/g, "<! --").replace(/--!?>/g, "- ->");
  // Nor anything that reads as a marker however it is spelled, which would make the block look tampered with.
  while (looksLikeMarker(s)) s = s.normalize("NFKD").replace(/[\p{M}\p{Cf}]/gu, "").replace(/voxium\s*:\s*(start|end)/gi, "voxium $1");
  return s;
}

/** Naming, placement and entry rules, in words. */
function conventionLines(arch: Architecture): string[] {
  const lines: string[] = [];
  for (const r of arch.rules) {
    const id = text(r.id);
    if (r.type === "naming") {
      const where = r.module === EVERY_MODULE ? "" : ` in \`${text(r.module)}\``;
      const endings = r.ignoreSuffixes?.length ? `, leaving out the endings ${text(r.ignoreSuffixes.join(", "))}` : "";
      lines.push(`* ${id}: name files matching ${text(r.files)}${where} in ${styleName(r.style)} (the part before the first dot${endings}).`);
    }
    if (r.type === "placement") lines.push(`* ${id}: files matching ${text(r.files)} belong in ${r.modules.map((m) => `\`${text(m)}\``).join(", ")}.`);
    if (r.type === "public_api") lines.push(`* ${id}: other modules import \`${text(r.module)}\` only through ${r.entries.map(text).join(", ")}.`);
  }
  return lines;
}

export function renderAgentRules(arch: Architecture, cliPackage?: string): string {
  const cli = parseCliPackage(cliPackage);
  const lines: string[] = [];
  lines.push(BLOCK_START);
  lines.push("## Architecture rules (managed by Voxium)");
  lines.push("");
  lines.push("This project has an enforced architecture. Pull requests that break it fail the Voxium check. Read this before adding imports or new files.");
  lines.push("");
  lines.push("### Layers, top to bottom");
  lines.push("A module may import from itself or from any module listed below it. Never import upward.");
  lines.push("");
  arch.layers.forEach((m, i) => {
    const def = arch.modules[m];
    lines.push(`${i + 1}. \`${text(m)}\` (${text(def.paths.join(", "))})`);
  });
  lines.push("");
  lines.push("### Rules");
  for (const r of arch.rules) {
    // An override of an organization rule, until it expires: then the rule is enforced again.
    const o = r.org ? arch.overrides?.find((x) => x.rule === r.id) : undefined;
    const how = o ? `, ${o.action === "disable" ? "off" : "only a warning"} in this repository until ${text(o.expires)}` : "";
    const from = r.org ? " (organization rule)" : "";
    lines.push(`* ${text(r.id)} [${r.severity}${how}]${from}: ${text(r.description)} Why: ${text(r.rationale)}`);
  }
  lines.push("");
  const conventions = conventionLines(arch);
  if (conventions.length) lines.push("### Names, places and entry points", ...conventions, "");
  lines.push("### How to work within this");
  lines.push("* Before importing across modules, check the layer order above. If the import points upward, move the shared code down or pass it in as a parameter.");
  lines.push("* If the Voxium MCP server is available, use it: `get_rules_for_path` before editing a file, `check_import` before adding a cross module import, and `check_change` with your planned file contents before you finish.");
  lines.push("* To suggest an architecture change, call `propose_architecture_change` on that server. You can suggest, you cannot approve.");
  lines.push("* Do not edit anything in the `voxium/` folder or this block. Architecture changes need approval from a Team Leader. If you think the architecture should change, say so in your PR description and explain why.");
  if (cli) lines.push(`* Run \`npx --yes ${cli} check\` before finishing. Fix every blocking violation.`);
  lines.push(BLOCK_END);
  return lines.join("\n");
}

/** Insert or replace the managed block, leaving everything else in the file untouched. */
export function upsertBlock(existing: string | undefined, block: string): string {
  if (!existing || !existing.trim()) return `${block}\n`;
  const s = existing.indexOf(BLOCK_START);
  const e = existing.indexOf(BLOCK_END);
  if (s !== -1 && e !== -1 && e > s) {
    return existing.slice(0, s) + block + existing.slice(e + BLOCK_END.length);
  }
  return `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
}

export function renderWorkflow(cliPackage: string): string {
  const cli = parseCliPackage(cliPackage);
  if (!cli) throw new Error("The workflow needs a Voxium CLI package.");
  return `name: Voxium architecture check

on:
  pull_request:

permissions:
  contents: read

jobs:
  architecture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          path: repo
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # The rules come from the default branch, so a pull request cannot pass by editing its own rules.
      # Running from an empty folder keeps npx from picking up a "voxium" the pull request ships itself.
      - name: Check architecture
        working-directory: \${{ runner.temp }}
        env:
          # The full ref name, because a tag called "origin/main" would win over the branch.
          RULES_FROM: refs/remotes/origin/\${{ github.event.repository.default_branch }}
        run: npx --yes ${cli} check --root "$GITHUB_WORKSPACE/repo" --rules-from "$RULES_FROM" --format github
`;
}

/** A GitHub login, or an organization's team as "org/team". Anything else could add owners or lines of its own. */
const OWNER = /^(?:[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}|[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100})$/;

/** The CODEOWNERS lines for Voxium's files, owned by these logins, or a placeholder to replace without any. */
export function renderCodeowners(owners: string[] = []): string {
  const logins = [...new Set(owners.map((o) => o.replace(/^@/, "")))];
  const bad = logins.find((l) => !OWNER.test(l));
  if (bad !== undefined) throw new Error(`"${bad.slice(0, 60)}" is not a GitHub login or team.`);
  logins.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
  const owner = logins.length ? logins.map((l) => `@${l}`).join(" ") : "@your-team-leaders";
  return `# Architecture changes need a Team Leader. Add this to .github/CODEOWNERS
# and require code owner review in branch protection.
/voxium/ ${owner}
/CLAUDE.md ${owner}
/AGENTS.md ${owner}
/${CURSOR_RULES_PATH} ${owner}
# A pull request can edit the workflows that check it, and these owners, so both need review too.
/.github/ ${owner}
`;
}

/** The Cursor rules file: the managed block, read in every chat. */
export function renderCursorRules(block: string): string {
  return `${CURSOR_FRONTMATTER}${block}\n`;
}

/** A GitLab job for merge requests, to include from .gitlab-ci.yml. */
export function renderGitlabCi(cliPackage: string): string {
  const cli = parseCliPackage(cliPackage);
  if (!cli) throw new Error("The GitLab job needs a Voxium CLI package.");
  return `# Generated by Voxium. Include it from .gitlab-ci.yml:
#
#   include:
#     - local: ${GITLAB_FILE_PATH}
#
# Then require pipelines to succeed before merging, and have a Team Leader own this file.
voxium-architecture:
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: "0"
  script:
    # The rules come from the default branch, by its full ref, so a merge request cannot pass by editing its own rules.
    - git -c core.hooksPath=/dev/null -c core.fsmonitor=false fetch --no-tags origin "+refs/heads/$CI_DEFAULT_BRANCH:refs/remotes/origin/$CI_DEFAULT_BRANCH"
    # Running from an empty folder keeps npx from picking up a "voxium" or an .npmrc the merge request ships itself.
    - cd "$(mktemp -d)"
    - npx --yes ${cli} check --root "$CI_PROJECT_DIR" --rules-from "refs/remotes/origin/$CI_DEFAULT_BRANCH"
`;
}

/** A pre-commit hook that checks what is staged, by the rules of the last commit. Nothing installs it. */
export function renderPreCommit(cliPackage: string): string {
  const cli = parseCliPackage(cliPackage);
  if (!cli) throw new Error("The pre-commit hook needs a Voxium CLI package.");
  return `#!/bin/sh
# Generated by Voxium. Checks what is staged, by the rules and baseline of the last commit.
# To use it: cp ${PRE_COMMIT_PATH} .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
# Copy it rather than pointing core.hooksPath here, so that a pull request that edits it runs nothing on your machine.
set -eu
repo=$(git rev-parse --show-toplevel)
# From an empty folder, so that npx cannot pick up a "voxium" or an .npmrc the repository ships itself.
dir=$(mktemp -d)
trap 'rmdir "$dir"' EXIT
cd "$dir"
npx --yes ${cli} check --staged --root "$repo"
`;
}

/**
 * The block the rules a change is judged by give: the architecture and CLI of the head where the change alters them, as
 * an approval puts those in force, and of the base otherwise. Null when there are no valid rules to render.
 */
export function expectedBlock(base: ProtectedContents, head: ProtectedContents, changed: string[]): string | null {
  const pick = (p: string) => (changed.includes(p) ? head : base)[p];
  let arch: unknown;
  try {
    arch = JSON.parse(pick(ARCH_FILE_PATH) ?? "null");
  } catch {
    return null;
  }
  if (!validateArchitecture(arch).ok) return null;
  return renderAgentRules(arch as Architecture, cliPackageInWorkflow(pick(WORKFLOW_FILE_PATH)) ?? cliPackageInWorkflow(pick(GITLAB_FILE_PATH)));
}

/** What older versions wrote. It runs whatever is published under that name, so it must not stay. */
function isUnpinnedServer(server: unknown): boolean {
  return JSON.stringify(server) === JSON.stringify({ command: "npx", args: ["voxium", "mcp"] });
}

/**
 * Merge the Voxium MCP server into an existing .mcp.json without touching other servers.
 * Without a CLI package nothing is added, and undefined means the file needs no change.
 */
export function mergeMcpConfig(existing: string | undefined, cliPackage?: string): string | undefined {
  const cli = parseCliPackage(cliPackage);
  let cfg: { mcpServers?: Record<string, unknown> } = {};
  if (existing && existing.trim()) {
    try {
      cfg = JSON.parse(existing);
    } catch {
      return undefined; // leave a file we cannot parse alone
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return undefined;
  }
  const servers = { ...(cfg.mcpServers ?? {}) };
  if (cli) servers.voxium = { command: "npx", args: ["--yes", cli, "mcp"] };
  else if (isUnpinnedServer(servers.voxium)) delete servers.voxium;
  else return undefined;
  cfg.mcpServers = servers;
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

export interface SetupFilesInput {
  arch: Architecture;
  /** Violation ids accepted as baseline debt. */
  baseline: string[];
  /** Current contents of files that may already exist (CLAUDE.md, AGENTS.md, .mcp.json). */
  existing?: Record<string, string | undefined>;
  /** Published CLI, such as "voxium@1.2.3". Without it, no file that downloads and runs code is written. */
  cliPackage?: string;
  /** GitHub logins (or org/team) that own the rules in the suggested CODEOWNERS. Without them, a placeholder. */
  owners?: string[];
  /** Also write voxium/dependency-cruiser.json. */
  withTests?: boolean;
}

/**
 * Every file Voxium writes into a repo, as repo relative path to content.
 * Pure, so the CLI (writing to disk) and the platform (opening a PR) produce identical files.
 */
export function buildSetupFiles(input: SetupFilesInput): Record<string, string> {
  const { arch, baseline } = input;
  const existing = input.existing ?? {};
  const cli = parseCliPackage(input.cliPackage);
  const block = renderAgentRules(arch, cli);
  const out: Record<string, string> = {
    [ARCH_FILE_PATH]: `${JSON.stringify(arch, null, 2)}\n`,
    "voxium/baseline.json": `${JSON.stringify({ violations: [...new Set(baseline)].sort() }, null, 2)}\n`,
    "CLAUDE.md": upsertBlock(existing["CLAUDE.md"], block),
    "AGENTS.md": upsertBlock(existing["AGENTS.md"], block),
    [CURSOR_RULES_PATH]: renderCursorRules(block),
    [CODEOWNERS_PATH]: renderCodeowners(input.owners),
  };
  if (cli) {
    out[WORKFLOW_FILE_PATH] = renderWorkflow(cli);
    out[GITLAB_FILE_PATH] = renderGitlabCi(cli);
    out[PRE_COMMIT_PATH] = renderPreCommit(cli);
  }
  if (input.withTests) out[DEPCRUISE_FILE_PATH] = renderDependencyCruiser(arch);
  const mcp = mergeMcpConfig(existing[".mcp.json"], cli);
  if (mcp) out[".mcp.json"] = mcp;
  return out;
}
