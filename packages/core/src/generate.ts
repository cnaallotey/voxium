import { WORKFLOW_FILE_PATH } from "./protect.js";
import type { Architecture } from "./types.js";

export const BLOCK_START = "<!-- voxium:start -->";
export const BLOCK_END = "<!-- voxium:end -->";

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

/** The package a workflow written by Voxium already runs, if it is pinned. */
export function cliPackageInWorkflow(workflow: string | null | undefined): string | undefined {
  const spec = /^\s*run: npx --yes (\S+) check --root /m.exec(workflow ?? "")?.[1];
  try {
    return parseCliPackage(spec);
  } catch {
    return undefined;
  }
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
    lines.push(`${i + 1}. \`${m}\` (${def.paths.join(", ")})`);
  });
  lines.push("");
  lines.push("### Rules");
  for (const r of arch.rules) {
    lines.push(`* ${r.id} [${r.severity}]: ${r.description} Why: ${r.rationale}`);
  }
  lines.push("");
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

export function renderCodeowners(owner = "@your-team-leaders"): string {
  return `# Architecture changes need a Team Leader. Add this to .github/CODEOWNERS
# and require code owner review in branch protection.
/voxium/ ${owner}
/CLAUDE.md ${owner}
/AGENTS.md ${owner}
# A pull request can edit the workflows that check it, and these owners, so both need review too.
/.github/ ${owner}
`;
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
    "voxium/architecture.json": `${JSON.stringify(arch, null, 2)}\n`,
    "voxium/baseline.json": `${JSON.stringify({ violations: [...new Set(baseline)].sort() }, null, 2)}\n`,
    "CLAUDE.md": upsertBlock(existing["CLAUDE.md"], block),
    "AGENTS.md": upsertBlock(existing["AGENTS.md"], block),
    "voxium/CODEOWNERS.suggested": renderCodeowners(),
  };
  if (cli) out[WORKFLOW_FILE_PATH] = renderWorkflow(cli);
  const mcp = mergeMcpConfig(existing[".mcp.json"], cli);
  if (mcp) out[".mcp.json"] = mcp;
  return out;
}
