#!/usr/bin/env node
import path from "node:path";
import { runMcp } from "./mcp.js";
import {
  checkArchitecture,
  failing,
  inferArchitecture,
  buildSetupFiles,
  findProtectedChanges,
  tightenBaseline,
} from "@voxium/core";
import {
  ARCH_FILE,
  BASELINE_FILE,
  buildGraph,
  loadArchitecture,
  loadBaseline,
  parseArchitecture,
  readIfExists,
  readProtected,
  readProtectedAtRef,
  saveBaseline,
  writeJson,
  writeText,
} from "@voxium/core/node";
import type { Architecture, CheckResult, Violation } from "@voxium/core";

const HELP = `Voxium: keep developers and coding agents inside your architecture.

Usage: voxium <command> [options]

Commands:
  init       Infer an architecture, write voxium/architecture.json, a baseline,
             agent rules (CLAUDE.md, AGENTS.md) and the CI workflow.
  infer      Print the inferred architecture without writing anything.
  check      Check the code against voxium/architecture.json. Exits 1 on blocking violations.
  generate   Regenerate agent rules and the CI workflow from voxium/architecture.json.
  mcp        Run the MCP server over stdio so coding agents can check rules and changes.

Options:
  --root <dir>        Project root (default: current directory)
  --format <fmt>      check output: text (default), json, github
  --rules-from <ref>  check: take the rules and baseline from a git ref, such as origin/main,
                      so a change is not judged by its own edits to them
  --update-baseline   check: accept all current violations as baseline debt
  --force             init: overwrite an existing architecture file
  -h, --help          Show this help
`;

interface Args {
  cmd?: string;
  root: string;
  format: "text" | "json" | "github";
  updateBaseline: boolean;
  rulesFrom?: string;
  force: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { root: process.cwd(), format: "text", updateBaseline: false, force: false, help: false };
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
    } else if (a === "--update-baseline") args.updateBaseline = true;
    else if (a === "--force") args.force = true;
    else if (!args.cmd && !a.startsWith("-")) args.cmd = a;
    else throw new Error(`Unknown option "${a}".`);
  }
  return args;
}

function writeSetupFiles(root: string, arch: Architecture, baseline: string[], only?: (p: string) => boolean): string[] {
  const files = buildSetupFiles({
    arch,
    baseline,
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
  return written;
}

function printViolation(v: Violation): void {
  const tag = v.baseline ? " (baseline)" : v.excepted ? " (excepted)" : "";
  console.log(`  ${v.severity === "block" ? "ERROR" : "WARN "} ${v.ruleId}${tag}  ${v.file}`);
  console.log(`         ${v.message}`);
  if (!v.baseline && !v.excepted) {
    console.log(`         Fix: ${v.fix}`);
    console.log(`         Why: ${v.rationale}`);
  }
}

function reportText(result: CheckResult): void {
  const fresh = result.violations.filter((v) => !v.baseline && !v.excepted);
  const old = result.violations.filter((v) => v.baseline || v.excepted);
  const { stats } = result;
  console.log(`Checked ${stats.files} files (${stats.assigned} in ${stats.modules} modules, ${stats.edges} imports).`);
  if (fresh.length) {
    console.log(`\nNew violations: ${fresh.length}`);
    fresh.forEach(printViolation);
  }
  if (result.expiredExceptions.length) {
    console.log(`\nExpired exceptions: ${result.expiredExceptions.length}`);
    for (const ex of result.expiredExceptions) {
      console.log(`  ${ex.rule} ${ex.file} (owner ${ex.owner}, expired ${ex.expires}): ${ex.reason}`);
    }
  }
  if (old.length) console.log(`\nAccepted debt (baseline or exceptions): ${old.length}`);
  const bad = failing(result);
  console.log(bad.length ? `\nFAILED: ${bad.length} blocking violation(s).` : "\nPASSED: no new blocking violations.");
}

function reportGithub(result: CheckResult): void {
  for (const v of result.violations) {
    if (v.baseline || v.excepted) continue;
    const level = v.severity === "block" ? "error" : "warning";
    const msg = `${v.ruleId}: ${v.message} Fix: ${v.fix}`.replace(/\r?\n/g, " ");
    console.log(`::${level} file=${v.file}::${msg}`);
  }
  for (const ex of result.expiredExceptions) {
    console.log(`::error::Expired exception for ${ex.rule} on ${ex.file} (owner ${ex.owner}).`);
  }
  reportText(result);
}

function report(result: CheckResult, format: Args["format"]): number {
  if (format === "json") console.log(JSON.stringify(result, null, 2));
  else if (format === "github") reportGithub(result);
  else reportText(result);
  return failing(result).length > 0 || result.expiredExceptions.length > 0 ? 1 : 0;
}

/** Check the working tree by the rules at a trusted git ref instead of its own. */
function checkAgainstRef(root: string, ref: string, format: Args["format"]): number {
  const trusted = readProtectedAtRef(root, ref);
  const own = readProtected(root);
  const archText = trusted[ARCH_FILE];
  if (archText === null || archText === undefined) {
    if (own[ARCH_FILE] === null) {
      console.error(`${ARCH_FILE} exists neither here nor on ${ref}. Restore it or remove the Voxium workflow.`);
      return 1;
    }
    loadArchitecture(root); // the setup change itself: the new rules must at least be valid
    console.error(`Voxium is not set up on ${ref} yet, so there are no approved rules to enforce.`);
    return 0;
  }

  const changed = findProtectedChanges(trusted, trusted, own);
  if (changed.length) {
    const msg = `${changed.join(", ")} changed. The rules from ${ref} still apply here. Merging needs Team Leader approval.`;
    if (format === "github") console.log(`::warning::${msg}`);
    else console.error(`WARNING: ${msg}`);
  }
  // Rules that do not parse would break every later check, so never let them through.
  const ownArch = own[ARCH_FILE] ? loadArchitecture(root) : null;

  const arch = parseArchitecture(archText, `${ARCH_FILE} on ${ref}`);
  const baseline = tightenBaseline(trusted[BASELINE_FILE], own[BASELINE_FILE]);
  const result = checkArchitecture(arch, buildGraph(root), { baseline });
  // Removing an expired exception is the fix for it, so it must not keep failing the change that removes it.
  if (ownArch) {
    result.expiredExceptions = result.expiredExceptions.filter((ex) =>
      ownArch.exceptions.some((o) => o.rule === ex.rule && o.file === ex.file),
    );
  }
  return report(result, format);
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
      const res = inferArchitecture(graph);
      console.log(JSON.stringify(res.architecture, null, 2));
      console.error(`\nConfidence: ${(res.confidence * 100).toFixed(0)}%`);
      res.notes.forEach((n) => console.error(`Note: ${n}`));
      return 0;
    }

    case "init": {
      if (readIfExists(root, ARCH_FILE) && !args.force) {
        console.error(`${ARCH_FILE} already exists. Use --force to overwrite.`);
        return 1;
      }
      const graph = buildGraph(root);
      const res = inferArchitecture(graph);
      if (Object.keys(res.architecture.modules).length === 0) {
        console.error("Could not find any folders to treat as modules. Nothing written.");
        res.notes.forEach((n) => console.error(`Note: ${n}`));
        return 1;
      }
      const arch = res.architecture;
      const result = checkArchitecture(arch, graph);
      const baselineIds = result.violations.filter((v) => v.severity === "block").map((v) => v.id);
      const written = writeSetupFiles(root, arch, baselineIds);
      console.log(`Voxium set up. Confidence in the inferred layers: ${(res.confidence * 100).toFixed(0)}%.`);
      console.log(`\nLayers, top to bottom:\n  ${arch.layers.join("\n  ")}`);
      console.log(`\nWritten: ${written.join(", ")}`);
      res.notes.forEach((n) => console.log(`Note: ${n}`));
      console.log(`\nNext: review ${ARCH_FILE}, then commit. Add voxium/CODEOWNERS.suggested to .github/CODEOWNERS.`);
      return 0;
    }

    case "generate": {
      const arch = loadArchitecture(root);
      const written = writeSetupFiles(root, arch, loadBaseline(root), (p) => p !== ARCH_FILE && p !== BASELINE_FILE);
      console.log(`Regenerated: ${written.join(", ")}`);
      return 0;
    }

    case "check": {
      if (args.rulesFrom) {
        if (args.updateBaseline) throw new Error("--rules-from cannot be combined with --update-baseline.");
        return checkAgainstRef(root, args.rulesFrom, args.format);
      }
      const arch = loadArchitecture(root);
      const graph = buildGraph(root);
      let baseline = loadBaseline(root);
      let result = checkArchitecture(arch, graph, { baseline });
      if (args.updateBaseline) {
        baseline = result.violations.filter((v) => v.severity === "block" && !v.excepted).map((v) => v.id);
        saveBaseline(root, baseline);
        result = checkArchitecture(arch, graph, { baseline });
        console.error(`Baseline updated with ${baseline.length} violation(s). Only a Team Leader should approve this change.`);
      }
      return report(result, args.format);
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
