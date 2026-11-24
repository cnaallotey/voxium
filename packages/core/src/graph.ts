import { extractImports, extractVueScript } from "./imports.js";
import type { ImportEdge, ProjectGraph } from "./types.js";

/** Repo relative posix path to file contents. This is the only input the core needs. */
export type FileMap = Record<string, string>;

export const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue"];
const RESOLVE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".json"];
/**
 * Folder names that usually hold build output or caches. They are only a hint: used when there is no git
 * to say what is committed, and to propose "ignore" globs at setup. A committed file is never skipped just
 * because of its folder name, otherwise code could hide from the rules in a folder called "build".
 */
export const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".cache",
  "coverage",
  ".svelte-kit",
  ".open-next",
  ".wrangler",
]);

const NEVER_SOURCE_DIRS = new Set(["node_modules", ".git"]);

/** True when a repo relative path is a source file Voxium should analyze. */
export function isSourcePath(p: string): boolean {
  const parts = p.split("/");
  for (let i = 0; i < parts.length - 1; i++) if (NEVER_SOURCE_DIRS.has(parts[i])) return false;
  const name = parts[parts.length - 1];
  if (name.endsWith(".d.ts")) return false;
  const dot = name.lastIndexOf(".");
  return dot !== -1 && SOURCE_EXT.includes(name.slice(dot));
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function packageName(spec: string): string | undefined {
  if (spec.startsWith("node:")) return undefined;
  if (spec.startsWith("@")) {
    const [scope, name] = spec.split("/");
    return name ? `${scope}/${name}` : spec;
  }
  return spec.split("/")[0];
}

function isAlias(spec: string): boolean {
  return spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("#/");
}

function resolveInternal(
  fileSet: Set<string>,
  fromFile: string,
  spec: string,
  aliasRoots: string[],
): string | undefined {
  let bases: string[];
  if (spec.startsWith(".")) {
    const d = dirname(fromFile);
    bases = [normalize(d ? `${d}/${spec}` : spec)];
  } else if (isAlias(spec)) {
    const rest = spec.slice(2);
    bases = aliasRoots.map((r) => normalize(r ? `${r}/${rest}` : rest));
  } else {
    return undefined;
  }
  for (const base of bases) {
    const stripped = base.replace(/\.(m|c)?js$/, "");
    for (const b of [base, stripped]) {
      if (fileSet.has(b)) return b;
      for (const ext of RESOLVE_EXT) if (fileSet.has(b + ext)) return b + ext;
      for (const ext of RESOLVE_EXT) if (fileSet.has(`${b}/index${ext}`)) return `${b}/index${ext}`;
    }
  }
  return undefined;
}

export interface BuildGraphOptions {
  /** Alias roots for "@/" and "~/" style imports, repo relative. Defaults to src then root. */
  aliasRoots?: string[];
}

/** Build the import graph from in memory files. Pure: no filesystem, no network. */
export function buildGraphFromFiles(input: FileMap, opts: BuildGraphOptions = {}, rootLabel = "."): ProjectGraph {
  const files = Object.keys(input).filter(isSourcePath).sort();
  const fileSet = new Set(files);
  const hasSrc = files.some((f) => f.startsWith("src/"));
  const aliasRoots = opts.aliasRoots ?? (hasSrc ? ["src", ""] : [""]);

  const edges: ImportEdge[] = [];
  const lines: Record<string, number> = {};

  for (const file of files) {
    const raw = input[file];
    lines[file] = raw.split("\n").length;
    const code = file.endsWith(".vue") ? extractVueScript(raw) : raw;
    for (const spec of extractImports(code)) {
      const internal = resolveInternal(fileSet, file, spec, aliasRoots);
      if (internal) {
        if (internal !== file) edges.push({ from: file, to: internal, specifier: spec });
        continue;
      }
      if (spec.startsWith(".") || isAlias(spec)) continue; // internal style but unresolved
      const pkg = packageName(spec);
      if (pkg) edges.push({ from: file, pkg, specifier: spec });
    }
  }

  return { root: rootLabel, files, lines, edges };
}
