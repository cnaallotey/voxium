import { EVERY_MODULE } from "./schema.js";
import type { Architecture, Rule, Severity } from "./types.js";

export const DEPCRUISE_FILE_PATH = "voxium/dependency-cruiser.json";

/** Characters a regular expression reads as syntax. */
const literal = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/**
 * A glob as the source of a regular expression that matches the paths compileGlob matches: "*" and "?" stay within one
 * folder, "**" crosses folders but no line break, and "**\/" may match nothing. Everything else is literal, so a glob
 * cannot bring syntax of its own into the expression.
 */
export function globSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "?") out += "[^/]";
    else if (c !== "*") out += literal(c);
    else if (glob[i + 1] !== "*") out += "[^/]*";
    else if (glob[i + 2] !== "/") {
      out += ".*";
      i++;
    } else {
      out += "(?:.*/)?";
      i += 2;
    }
  }
  return out;
}

const anyOf = (globs: string[]) => (globs.length ? `^(?:${globs.map(globSource).join("|")})$` : undefined);

interface Side {
  path?: string;
  pathNot?: string;
  circular?: boolean;
}

export interface CruiserRule {
  name: string;
  severity: "error" | "warn";
  comment: string;
  from: Side;
  to: Side;
}

/**
 * The files of a module as dependency-cruiser sees them: a file belongs to the first module whose globs match it, and
 * ignored files to none. Null for a module without globs, which has no files.
 */
function filesOf(arch: Architecture, module: string): Side | null {
  const names = Object.keys(arch.modules);
  const path = anyOf(arch.modules[module].paths);
  if (!path) return null;
  const not = anyOf([...(arch.ignore ?? []), ...names.slice(0, names.indexOf(module)).flatMap((n) => arch.modules[n].paths)]);
  return not ? { path, pathNot: not } : { path };
}

/** A package by its name, resolved into node_modules or not, and a builtin of Node with "node:" or without. */
function packagesSource(packages: string[]): string {
  const names = [...new Set(packages.map((p) => p.replace(/^node:/, "")))].map(literal).join("|");
  return `(?:^|/)node_modules/(?:${names})(?:/|$)|^(?:node:)?(?:${names})(?:/|$)`;
}

const severity = (s: Severity) => (s === "block" ? "error" : "warn");
const NOTE = "voxium check stays authoritative: it also follows imports through files outside every module, and knows the baseline and exceptions.";

/**
 * dependency-cruiser rules for the layers, dependency and package rules, and file-level cycles for no_cycles, which is
 * stricter than Voxium's cycles between modules. Naming, placement, entry points and the other rules are not expressed.
 */
export function dependencyCruiserRules(arch: Architecture): CruiserRule[] {
  const out: CruiserRule[] = [];
  const add = (r: Rule, comment: string, from: Side | null, to: Side | null) => {
    if (from && to) out.push({ name: `voxium-${out.length + 1}`, severity: severity(r.severity), comment: `Voxium rule ${r.id}: ${comment} ${NOTE}`, from, to });
  };
  for (const r of arch.rules) {
    if (r.type === "layers") {
      arch.layers.forEach((from, i) => {
        for (const to of arch.layers.slice(0, i)) add(r, `${from} must not import ${to}, which is above it.`, filesOf(arch, from), filesOf(arch, to));
      });
    } else if (r.type === "deny_dependency") {
      add(r, `${r.from} must not import ${r.to}.`, filesOf(arch, r.from), filesOf(arch, r.to));
    } else if (r.type === "deny_external") {
      const modules = r.module === EVERY_MODULE ? Object.keys(arch.modules).filter((m) => !r.except?.includes(m)) : [r.module];
      for (const m of modules) add(r, `${m} must not use ${r.packages.join(", ")}.`, filesOf(arch, m), { path: packagesSource(r.packages) });
    } else if (r.type === "no_cycles") {
      const ignore = anyOf(arch.ignore ?? []);
      add(r, "no circular imports. Voxium only forbids cycles between modules, so this is stricter.", ignore ? { pathNot: ignore } : {}, { circular: true });
    }
  }
  return out;
}

/** voxium/dependency-cruiser.json, for `depcruise --config voxium/dependency-cruiser.json` run from the repository root. */
export function renderDependencyCruiser(arch: Architecture): string {
  return `${JSON.stringify({ forbidden: dependencyCruiserRules(arch), options: { doNotFollow: { path: "node_modules" } } }, null, 2)}\n`;
}
