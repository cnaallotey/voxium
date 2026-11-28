#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runMcp } from "./mcp.js";
import {
  checkArchitecture,
  createProposal,
  failing,
  inferArchitecture,
  applyTemplate,
  isTemplateName,
  TEMPLATE_NAMES,
  buildSetupFiles,
  changedBlocks,
  blocksToCompare,
  cliPackageInWorkflow,
  expectedBlock,
  findProtectedChanges,
  moduleConnections,
  needsConnections,
  parseBaseline,
  parseCliPackage,
  AGENT_FILES,
  CODEOWNERS_PATH,
  DEPCRUISE_FILE_PATH,
  GITLAB_FILE_PATH,
  PROTECTED_FILES,
  WORKFLOW_FILE_PATH,
  tightenBaseline,
  unparsedFiles,
} from "@voxium/core";
import {
  ARCH_FILE,
  BASELINE_FILE,
  buildGraph,
  buildGraphBefore,
  changedSince,
  commitOf,
  loadArchitecture,
  loadBaseline,
  mergeBaseOf,
  parseArchitecture,
  readConfigBefore,
  readIfExists,
  readProtected,
  readProtectedAtRef,
  readStaged,
  graphOfTree,
  saveBaseline,
  saveProposal,
  writeText,
} from "@voxium/core/node";
import type { Architecture, BuildGraphOptions, CheckResult, FileMap, InferResult, ProjectGraph, ProtectedContents, TemplateName, UnparsedFile, Violation } from "@voxium/core";

const HELP = `Voxium: keep developers and coding agents inside your architecture.

Usage: voxium <command> [options]

Commands:
  init       Infer an architecture, write voxium/architecture.json, a baseline,
             and agent rules (CLAUDE.md, AGENTS.md, Cursor rules).
  infer      Print the inferred architecture without writing anything.
  check      Check the code against voxium/architecture.json. Exits 1 on blocking violations,
             2 when some of the code cannot be read.
  generate   Regenerate agent rules and the other generated files from voxium/architecture.json.
  mcp        Run the MCP server over stdio so coding agents can check rules and changes.
  propose    Save a proposal to change the rules in voxium/proposals, for a Team Leader to decide.
             Commit it in a pull request and the platform picks it up.

Options:
  --root <dir>        Project root (default: current directory)
  --format <fmt>      check output: text (default), json, github
  --rules-from <ref>  check: take the rules and baseline from a git ref, such as origin/main,
                      so a change is not judged by its own edits to them
  --staged            check: check what is staged, as the pre-commit hook does, by the rules and
                      baseline of HEAD (or the staged ones before Voxium is in a commit)
  --changed <ref>     check: show only violations in files changed since a ref and in the files
                      that import them. Quick feedback while working, not for CI
  --update-baseline   check: accept all current violations as baseline debt
  --cli-package <p>   init, generate: also write the CI workflow, a GitLab job, a pre-commit hook and
                      .mcp.json, running this exact published version, such as voxium@1.2.3
                      (or set VOXIUM_CLI_PACKAGE). generate keeps the version the workflow pins.
  --with-tests        init, generate: also write voxium/dependency-cruiser.json (generate keeps
                      writing it once it is there)
  --force             init: overwrite an existing architecture file
  --template <name>   init: start from a template instead of the inferred modules, keeping only
                      the modules that match a file: ${TEMPLATE_NAMES.join(", ")}
  --title, --summary, --rationale <text>
                      propose: what should change and why (all three are required)
  --architecture <f>  propose: a file with the whole architecture as it should be
  --accept-debt       propose: accept as debt the violations the change would make new
  -h, --help          Show this help
`;

interface Args {
  cmd?: string;
  root: string;
  format: "text" | "json" | "github";
  updateBaseline: boolean;
  rulesFrom?: string;
  cliPackage?: string;
  force: boolean;
  template?: TemplateName;
  help: boolean;
  title?: string;
  summary?: string;
  rationale?: string;
  architecture?: string;
  acceptDebt: boolean;
  staged: boolean;
  changed?: string;
  withTests: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { root: process.cwd(), format: "text", updateBaseline: false, force: false, help: false, acceptDebt: false, staged: false, withTests: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--root") args.root = path.resolve(argv[++i] ?? ".");
    else if (a === "--format") {
      const f = argv[++i];
      if (f !== "text" && f !== "json" && f !== "github") throw new Error(`Unknown format "${f}".`);
      args.format = f;
    } else if (a === "--rules-from") {
      const ref = argv[++i];
      if (!ref) throw new Error("--rules-from needs a git ref.");
      args.rulesFrom = ref;
    } else if (a === "--changed") {
      const ref = argv[++i];
      if (!ref) throw new Error("--changed needs a git ref.");
      args.changed = ref;
    } else if (a === "--cli-package") {
      const spec = parseCliPackage(argv[++i]);
      if (!spec) throw new Error("--cli-package needs an exact version, such as voxium@1.2.3.");
      args.cliPackage = spec;
    } else if (a === "--title" || a === "--summary" || a === "--rationale" || a === "--architecture") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${a} needs a value.`);
      args[a.slice(2) as "title" | "summary" | "rationale" | "architecture"] = value;
    } else if (a === "--template") {
      const name = argv[++i];
      if (!isTemplateName(name)) throw new Error(`--template needs one of: ${TEMPLATE_NAMES.join(", ")}.`);
      args.template = name;
    } else if (a === "--accept-debt") args.acceptDebt = true;
    else if (a === "--staged") args.staged = true;
    else if (a === "--with-tests") args.withTests = true;
    else if (a === "--update-baseline") args.updateBaseline = true;
    else if (a === "--force") args.force = true;
    else if (!args.cmd && !a.startsWith("-")) args.cmd = a;
    else throw new Error(`Unknown option "${a}".`);
  }
  return args;
}

function writeSetupFiles(
  root: string,
  arch: Architecture,
  baseline: string[],
  opts: { cliPackage?: string; only?: (p: string) => boolean; withTests?: boolean } = {},
): string[] {
  const { only } = opts;
  const workflow = readIfExists(root, WORKFLOW_FILE_PATH);
  const cliPackage =
    opts.cliPackage ?? parseCliPackage(process.env.VOXIUM_CLI_PACKAGE) ?? cliPackageInWorkflow(workflow) ?? cliPackageInWorkflow(readIfExists(root, GITLAB_FILE_PATH));
  const files = buildSetupFiles({
    arch,
    baseline,
    cliPackage,
    withTests: opts.withTests || readIfExists(root, DEPCRUISE_FILE_PATH) !== undefined,
    existing: {
      "CLAUDE.md": readIfExists(root, "CLAUDE.md"),
      "AGENTS.md": readIfExists(root, "AGENTS.md"),
      ".mcp.json": readIfExists(root, ".mcp.json"),
    },
  });
  const written: string[] = [];
  for (const [p, content] of Object.entries(files)) {
    if (only && !only(p)) continue;
    writeText(root, p, content);
    written.push(p);
  }
  if (!cliPackage) {
    console.log("Note: no CI workflow, GitLab job, pre-commit hook or .mcp.json entry was written. Pass --cli-package with a published version to add them.");
    if (workflow && /npx .*\bvoxium\b/.test(workflow)) {
      console.log(`Note: ${WORKFLOW_FILE_PATH} runs "voxium" from npm without an exact version. Pin it or delete the file.`);
    }
  }
  return written;
}

/** Names from the project must not be able to end a line, or to steer the terminal. */
const oneLine = (s: string) =>
  s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (c) => (c === "\n" ? "\\n" : c === "\r" ? "\\r" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));

/** GitHub takes a line that starts with "::", after any spaces, and "##[" anywhere, for a command. */
const notACommand = (s: string) => s.replace(/::/g, "%3A%3A").replace(/##\[/g, "##%5B");

type Print = (line: string) => void;
const print: Print = (line) => console.log(oneLine(line));
const printInLog: Print = (line) => print(notACommand(line));

function printViolation(v: Violation, print: Print): void {
  const tag = v.baseline ? " (baseline)" : v.excepted ? " (excepted)" : "";
  print(`  ${v.severity === "block" ? "ERROR" : "WARN "} ${v.ruleId}${tag}  ${v.file}${v.line ? `:${v.line}` : ""}`);
  print(`         ${v.message}`);
  if (!v.baseline && !v.excepted) {
    print(`         Fix: ${v.fix}`);
    print(`         Why: ${v.rationale}`);
  }
}

/** The result of a check, and the files that keep it from being complete. */
interface TreeCheck {
  result: CheckResult;
  unparsed: UnparsedFile[];
}

function reportText({ result, unparsed }: TreeCheck, print: Print): void {
  const fresh = result.violations.filter((v) => !v.baseline && !v.excepted);
  const old = result.violations.filter((v) => v.baseline || v.excepted);
  const { stats } = result;
  const unresolved = stats.unresolved ? `, ${stats.unresolved} that lead to no file` : "";
  console.log(`Checked ${stats.files} files (${stats.assigned} in ${stats.modules} modules, ${stats.edges} imports${unresolved}).`);
  if (fresh.length) {
    console.log(`\nNew violations: ${fresh.length}`);
    for (const v of fresh) printViolation(v, print);
  }
  if (result.expiredExceptions.length) {
    console.log(`\nExpired exceptions: ${result.expiredExceptions.length}`);
    for (const ex of result.expiredExceptions) {
      print(`  ${ex.rule} ${ex.file} (owner ${ex.owner}, expired ${ex.expires}): ${ex.reason}`);
    }
  }
  if (result.expiredOverrides.length) {
    console.log(`\nExpired overrides, whose rules are enforced again: ${result.expiredOverrides.length}`);
    for (const o of result.expiredOverrides) print(`  ${o.rule} (owner ${o.owner}, expired ${o.expires}): ${o.reason}`);
  }
  if (old.length) console.log(`\nAccepted debt (baseline or exceptions): ${old.length}`);
  if (unparsed.length) {
    console.log(`\nCould not be read, so their imports are not checked: ${unparsed.length}`);
    for (const u of unparsed) print(`  ${u.file} ${u.reason}`);
    console.log(`  Fix the code or config file, or add files that are not source code to "ignore" in ${ARCH_FILE}.`);
  }
  const bad = failing(result);
  if (unparsed.length && !bad.length) console.log("\nINCOMPLETE: not all code could be checked.");
  else console.log(bad.length ? `\nFAILED: ${bad.length} blocking violation(s).` : "\nPASSED: no new blocking violations.");
}

/** GitHub reads these lines as commands, so names from the project must not be able to end one or start another. */
const ghText = (s: string) => oneLine(s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A"));
const ghProperty = (s: string) => ghText(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

function reportGithub({ result, unparsed }: TreeCheck): void {
  for (const v of result.violations) {
    if (v.baseline || v.excepted) continue;
    const level = v.severity === "block" ? "error" : "warning";
    const msg = `${v.ruleId}: ${v.message} Fix: ${v.fix}`.replace(/\r?\n/g, " ");
    console.log(`::${level} file=${ghProperty(v.file)}${v.line ? `,line=${v.line}` : ""}::${ghText(msg)}`);
  }
  for (const ex of result.expiredExceptions) {
    console.log(`::error::${ghText(`Expired exception for ${ex.rule} on ${ex.file} (owner ${ex.owner}).`)}`);
  }
  for (const o of result.expiredOverrides) {
    console.log(`::error::${ghText(`Expired override of ${o.rule} (owner ${o.owner}). The rule is enforced again; renew or remove the override.`)}`);
  }
  for (const u of unparsed) console.log(`::error file=${ghProperty(u.file)}::${ghText(`${u.file} ${u.reason}, so its imports are not checked.`)}`);
  reportText({ result, unparsed }, printInLog);
}

function report(check: TreeCheck, format: Args["format"]): number {
  const { result, unparsed } = check;
  if (format === "json") console.log(JSON.stringify({ ...result, cycles: undefined, unparsed }, null, 2));
  else if (format === "github") reportGithub(check);
  else reportText(check, print);
  if (unparsed.length) return 2;
  return failing(result).length > 0 || result.expiredExceptions.length > 0 || result.expiredOverrides.length > 0 ? 1 : 0;
}

/** Where the code to check comes from, and the code from before the change. */
interface Source {
  graph: (opts: BuildGraphOptions) => ProjectGraph;
  /** The project before the change, for what is left of an accepted cycle. */
  before: (opts: BuildGraphOptions) => ProjectGraph | null;
  /** The config files where the change started, so that editing or removing a mapping cannot hide an import. */
  configBefore: FileMap | null;
}

/** The work tree, changed since where HEAD branched off from a ref, or since HEAD without one. */
const workTree = (root: string, ref?: string): Source => ({
  graph: (opts) => buildGraph(root, opts),
  before: (opts) => buildGraphBefore(root, ref, opts),
  configBefore: readConfigBefore(root, ref),
});

/** What is staged, changed since HEAD. */
function stagedTree(root: string, staged: ReturnType<typeof readStaged>): Source {
  const head = commitOf(root, "HEAD");
  return {
    graph: (opts) => graphOfTree(staged, opts, root),
    before: (opts) => (head ? buildGraphBefore(root, undefined, opts) : null),
    configBefore: head ? readConfigBefore(root) : null,
  };
}

/** Check a tree, with a look at the code from before the change when a smaller cycle depends on it. */
function checkTree(source: Source, arch: Architecture, baseline: string[]): TreeCheck & { graph: ProjectGraph } {
  // Aliases come from the rules, so from the trusted ref when there is one.
  const graph = source.graph({ aliases: arch.aliases, configBefore: source.configBefore ?? undefined });
  const result = checkArchitecture(arch, graph, { baseline });
  const before = needsConnections(result) ? source.before({ aliases: arch.aliases }) : null;
  return {
    result: before ? checkArchitecture(arch, graph, { baseline, connections: moduleConnections(arch, before) }) : result,
    unparsed: unparsedFiles(graph, arch.ignore),
    graph,
  };
}

/**
 * Agent files whose Voxium block a change altered, against the block the trusted rules give. `head` has the agent files
 * after the change, and `earlier` reads them where it started, which only happens for blocks that are not as expected.
 */
function blockChanges(trusted: ProtectedContents, own: ProtectedContents, changed: string[], head: ProtectedContents, earlier: (paths: string[]) => ProtectedContents): string[] {
  const block = expectedBlock(trusted, own, changed);
  const paths = block === null ? [] : blocksToCompare(head, block);
  return paths.length ? changedBlocks(paths, earlier(paths), head, block!) : [];
}

const agentFiles = (root: string): ProtectedContents => Object.fromEntries(AGENT_FILES.map((p) => [p, readIfExists(root, p) ?? null]));

/**
 * Check a tree by trusted rules instead of its own. A change to the rules is reported, and only a baseline that drops
 * debt counts. Without trusted rules, the tree's own are the first ones, so they apply.
 */
function checkTrusted(
  root: string,
  label: string,
  trusted: ProtectedContents,
  own: ProtectedContents,
  ownAgents: ProtectedContents,
  earlierAgents: (paths: string[]) => ProtectedContents,
  source: Source,
  format: Args["format"],
): number {
  const archText = trusted[ARCH_FILE];
  if (archText === null || archText === undefined) {
    if (own[ARCH_FILE] === null || own[ARCH_FILE] === undefined) {
      console.error(`${ARCH_FILE} exists neither here nor on ${label}. Restore it or remove the Voxium workflow.`);
      return 1;
    }
    parseArchitecture(own[ARCH_FILE]!); // the setup change itself: the new rules must at least be valid
    console.error(`Voxium is not set up on ${label} yet, so there are no approved rules to enforce.`);
    return 0;
  }

  const files = findProtectedChanges(trusted, trusted, own);
  const changed = [...files, ...blockChanges(trusted, own, files, ownAgents, earlierAgents)];
  if (changed.length) {
    const msg = `${changed.join(", ")} changed. The rules from ${label} still apply here. Merging needs Team Leader approval.`;
    if (format === "github") console.log(`::warning::${ghText(msg)}`);
    else console.error(oneLine(`WARNING: ${msg}`));
  }
  // Rules that do not parse would break every later check, so never let them through.
  const ownArch = own[ARCH_FILE] ? parseArchitecture(own[ARCH_FILE]!) : null;

  const arch = parseArchitecture(archText, `${ARCH_FILE} on ${label}`);
  const baseline = tightenBaseline(trusted[BASELINE_FILE], own[BASELINE_FILE]);
  const check = checkTree(source, arch, baseline);
  // Removing an expired exception is the fix for it, so it must not keep failing the change that removes it.
  if (ownArch) {
    check.result.expiredExceptions = check.result.expiredExceptions.filter((ex) =>
      ownArch.exceptions.some((o) => o.rule === ex.rule && o.file === ex.file),
    );
    check.result.expiredOverrides = check.result.expiredOverrides.filter((ov) => (ownArch.overrides ?? []).some((o) => o.rule === ov.rule && o.expires === ov.expires));
  }
  return report(check, format);
}

/** Check the working tree by the rules at a trusted git ref instead of its own. */
function checkAgainstRef(root: string, ref: string, format: Args["format"]): number {
  const trusted = readProtectedAtRef(root, ref);
  // The blocks are compared with where the change started.
  const earlier = (paths: string[]) => readProtectedAtRef(root, mergeBaseOf(root, ref), paths);
  return checkTrusted(root, ref, trusted, readProtected(root), agentFiles(root), earlier, workTree(root, ref), format);
}

/**
 * Check what is staged, as the next commit would hold it, by the rules and baseline of HEAD, so that staging weaker
 * rules does not help. Before the first commit, the staged rules are the first ones.
 */
function checkStaged(root: string, format: Args["format"]): number {
  const staged = readStaged(root, [...PROTECTED_FILES, ...AGENT_FILES]);
  const head = commitOf(root, "HEAD");
  const trusted = head ? readProtectedAtRef(root, head) : {};
  const earlier = (paths: string[]) => (head ? readProtectedAtRef(root, head, paths) : {});
  const source = stagedTree(root, staged);
  if (!trusted[ARCH_FILE] && staged.extra[ARCH_FILE]) {
    // Nothing committed has rules yet: judge the staged code by the staged rules, which are all there are.
    const arch = parseArchitecture(staged.extra[ARCH_FILE]!, `${ARCH_FILE} as staged`);
    return report(checkTree(source, arch, parseBaseline(staged.extra[BASELINE_FILE]) ?? []), format);
  }
  return checkTrusted(root, "HEAD", trusted, staged.extra, staged.extra, earlier, source, format);
}

/** Only the violations in the files changed since a ref and in the files that import them. */
function nearChanges(root: string, ref: string, check: TreeCheck & { graph: ProjectGraph }): TreeCheck {
  const changed = new Set(changedSince(root, ref));
  const near = new Set(changed);
  for (const e of check.graph.edges) if (e.to && changed.has(e.to)) near.add(e.from);
  // On stderr, so that the json and github formats stay what they are.
  console.error(`Showing only violations in the ${changed.size} file(s) changed since ${oneLine(ref)} and in the files that import them.`);
  return { ...check, result: { ...check.result, violations: check.result.violations.filter((v) => near.has(v.file)) } };
}

/** The inferred architecture, with the frameworks the root package.json names in a note. */
function infer(root: string, graph: ProjectGraph): InferResult {
  return inferArchitecture(graph, { packageJson: readIfExists(root, "package.json") });
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.cmd) {
    console.log(HELP);
    return args.cmd || args.help ? 0 : 1;
  }
  const root = args.root;

  switch (args.cmd) {
    case "infer": {
      const graph = buildGraph(root);
      const res = infer(root, graph);
      console.log(JSON.stringify(res.architecture, null, 2));
      console.error(`\nConfidence: ${(res.confidence * 100).toFixed(0)}%`);
      for (const p of res.proposals) console.error(oneLine(`  ${p.kind} ${p.name}: ${(p.confidence * 100).toFixed(0)}%. ${p.evidence}`));
      res.notes.forEach((n) => console.error(oneLine(`Note: ${n}`)));
      return 0;
    }

    case "init": {
      if (readIfExists(root, ARCH_FILE) && !args.force) {
        console.error(`${ARCH_FILE} already exists. Use --force to overwrite.`);
        return 1;
      }
      const graph = buildGraph(root);
      const res = infer(root, graph);
      // Ignored paths and aliases are worked out from the code either way: a template only says which modules to look for.
      const arch = args.template
        ? applyTemplate(args.template, graph.files, { ignore: res.architecture.ignore, aliases: res.architecture.aliases })
        : res.architecture;
      if (Object.keys(arch.modules).length === 0) {
        console.error(args.template ? `No folder matches the ${args.template} template. Nothing written.` : "Could not find any folders to treat as modules. Nothing written.");
        res.notes.forEach((n) => console.error(oneLine(`Note: ${n}`)));
        return 1;
      }
      const unparsed = unparsedFiles(graph, arch.ignore);
      if (unparsed.length) {
        console.error("Some code could not be read, and code to check imports it. Nothing written.");
        for (const u of unparsed) console.error(oneLine(`  ${u.file} ${u.reason}`));
        return 2;
      }
      const result = checkArchitecture(arch, graph);
      const baselineIds = result.violations.filter((v) => v.severity === "block").map((v) => v.id);
      const written = writeSetupFiles(root, arch, baselineIds, { cliPackage: args.cliPackage, withTests: args.withTests });
      console.log(args.template ? `Voxium set up from the ${args.template} template.` : `Voxium set up. Confidence in the inferred layers: ${(res.confidence * 100).toFixed(0)}%.`);
      console.log(`\nLayers, top to bottom:\n  ${arch.layers.map(oneLine).join("\n  ")}`);
      console.log(`\nWritten: ${written.join(", ")}`);
      // The notes of inference are about the inferred modules and layers, which a template replaces.
      if (args.template) console.log(`${baselineIds.length} existing blocking violation(s) recorded as baseline.`);
      else res.notes.forEach((n) => print(`Note: ${n}`));
      console.log(`\nNext: review ${ARCH_FILE}, then commit. Add voxium/CODEOWNERS.suggested to .github/CODEOWNERS.`);
      return 0;
    }

    case "generate": {
      const arch = loadArchitecture(root);
      // The suggested CODEOWNERS may have the real owners in it by now, which the CLI does not know.
      const keep = [ARCH_FILE, BASELINE_FILE, ...(readIfExists(root, CODEOWNERS_PATH) === undefined ? [] : [CODEOWNERS_PATH])];
      const written = writeSetupFiles(root, arch, loadBaseline(root), {
        cliPackage: args.cliPackage,
        withTests: args.withTests,
        only: (p) => !keep.includes(p),
      });
      console.log(`Regenerated: ${written.join(", ")}`);
      return 0;
    }

    case "check": {
      const modes = [args.rulesFrom && "--rules-from", args.staged && "--staged", args.changed && "--changed", args.updateBaseline && "--update-baseline"].filter(Boolean);
      if (modes.length > 1) throw new Error(`${modes.join(" and ")} cannot be combined.`);
      if (args.rulesFrom) return checkAgainstRef(root, args.rulesFrom, args.format);
      if (args.staged) return checkStaged(root, args.format);
      const arch = loadArchitecture(root);
      let baseline = loadBaseline(root);
      if (args.changed) return report(nearChanges(root, args.changed, checkTree(workTree(root), arch, baseline)), args.format);
      let check = checkTree(workTree(root), arch, baseline);
      if (args.updateBaseline && check.unparsed.length) {
        console.error("The baseline was not updated, because some code could not be read.");
      } else if (args.updateBaseline) {
        baseline = check.result.violations.filter((v) => v.severity === "block" && !v.excepted).map((v) => v.id);
        saveBaseline(root, baseline);
        check = checkTree(workTree(root), arch, baseline);
        console.error(`Baseline updated with ${baseline.length} violation(s). Only a Team Leader should approve this change.`);
      }
      return report(check, args.format);
    }

    case "propose": {
      let architecture: unknown;
      if (args.architecture) {
        try {
          architecture = JSON.parse(fs.readFileSync(path.resolve(args.architecture), "utf8"));
        } catch (err) {
          throw new Error(`${args.architecture} could not be read as JSON: ${(err as Error).message}`);
        }
      }
      const proposal = createProposal({
        title: args.title ?? "",
        summary: args.summary ?? "",
        rationale: args.rationale ?? "",
        architecture,
        acceptDebt: args.acceptDebt || undefined,
        requestedBy: "cli",
      });
      const saved = saveProposal(root, proposal);
      console.log(`Saved ${saved.path}. Commit it in a pull request: Voxium imports it for a Team Leader to decide. Nobody can approve it by editing the file.`);
      return 0;
    }

    case "mcp":
      return -1; // handled in the async entry below

    default:
      console.error(`Unknown command "${args.cmd}".\n`);
      console.error(HELP);
      return 1;
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === "mcp" && !args.help) {
    await runMcp(args.root); // stays alive, serving over stdio
    return;
  }
  process.exitCode = main();
}

run().catch((err) => {
  console.error(`voxium: ${(err as Error).message}`);
  process.exitCode = 2;
});
