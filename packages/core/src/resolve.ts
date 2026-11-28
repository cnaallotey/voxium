/**
 * What a module name stands for beyond a relative path: tsconfig and jsconfig paths and baseUrl, workspace packages,
 * package.json imports, self references and npm: aliases, and the aliases of the architecture. Config files come from
 * the same file map as the code. They only ever add candidates, so a change to them cannot hide an import.
 */
import { compileGlobs } from "./glob.js";
import { aliasNameOk, aliasTargetOk, MAX_ALIAS_TARGETS, MAX_ALIASES } from "./schema.js";
import type { UnparsedFile } from "./types.js";

/** Files that say how module names resolve. They are read along with the code, but they are not code. */
export function isConfigPath(p: string): boolean {
  const parts = p.split("/");
  for (let i = 0; i < parts.length - 1; i++) if (parts[i] === "node_modules" || parts[i] === ".git") return false;
  const name = parts[parts.length - 1];
  return name === "package.json" || name === "pnpm-workspace.yaml" || name === "lerna.json" || /^[tj]sconfig[^/]*\.json$/.test(name);
}

export const RESOLVE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".json"];
/** The endings Node's require() tries, in its order, including those of type stripping. */
const NODE_EXT = [".js", ".json", ".node", ".cts", ".ts", ".mts"];

/** Larger config files are not written by people. */
const MAX_CONFIG = 1_000_000;
/** Patterns in one tsconfig, targets of one pattern, and patterns in the whole project. */
const MAX_PATHS = 1000;
const MAX_PATH_TARGETS = 50;
const MAX_ALL_PATHS = 5000;
const MAX_EXTENDS = 32;
/** tsconfig files in one folder. Each applies to every import below it. */
const MAX_TSCONFIGS = 20;
/** tsconfig files with baseUrl or paths that apply to the code of one folder, from it and every folder above. */
const MAX_APPLYING = 50;
/** Patterns of one workspace, and patterns times package.json files over all workspaces. */
const MAX_GLOBS = 1000;
const MAX_GLOB_TESTS = 200_000;
/** How deep conditions in exports and imports may nest. Real ones nest two or three deep. */
const MAX_CONDITIONS = 32;
/**
 * Targets one check may try, and different paths it may look for, while resolving names. Plenty for any repo, but not
 * for config made to keep the check from finishing: past either, what is left is a gap.
 */
const MAX_WORK = 1_000_000;
const MAX_PROBES = 400_000;
/**
 * What looking for a path costs grows with its length, so the paths looked for have a limit in characters as well. An
 * honest repo with 40,000 path aliases uses a tenth of it; config made of long targets reaches it in a few seconds.
 */
const MAX_PROBE_CHARS = 30_000_000;
/** Steps of matching one name against patterns that are not counted as work, which is more than real config takes. */
const FREE_STEPS = 8;
/** Entries of one exports or imports map. Real ones have tens. */
const MAX_MAP_ENTRIES = 1000;
/** The longest line of a YAML file that is read. Longer ones are not written by people. */
const MAX_YAML_LINE = 16_384;
/** Endings that Node, with type stripping, and bundlers add to a name that has none, also to "index" in a folder. */
export const ADDED_EXT = ["", ".js", ".cjs", ".mjs", ".jsx", ".ts", ".cts", ".mts", ".tsx", ".node", ".vue"];

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

export function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** A path relative to a folder of the repo, or null when it leads out of the repo or is absolute. */
export function within(dir: string, rel: string): string | null {
  if (rel.startsWith("/") || /^[a-z]:/i.test(rel)) return null;
  const out = dir ? dir.split("/") : [];
  for (const seg of rel.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg !== "..") out.push(seg);
    else if (!out.pop()) return null;
  }
  return out.join("/");
}

/** Every folder a path is in, the root first. */
function ancestors(file: string): string[] {
  const parts = file.split("/").slice(0, -1);
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}

const under = (dir: string, p: string) => !dir || p.startsWith(`${dir}/`);

/**
 * Whether a module name can only stand for a folder: it ends with "/", or its last part is "." or "..". Node, TypeScript
 * and bundlers then load the folder's package.json "main" or its index, never a file of that name or with an ending.
 */
export function namesFolder(name: string): boolean {
  return /\/$|(?:^|\/)\.\.?$/.test(name);
}

/**
 * The source file a path stands for, as compilers and bundlers look for it: by its name, with an ending, or as a folder.
 * For a name that can only stand for a folder (see namesFolder), only as a folder.
 */
export function fileAt(fileSet: ReadonlySet<string>, bases: string[], folder = false): string | undefined {
  for (const base of bases) {
    const stripped = folder ? base : base.replace(/\.(m|c)?js$/, "");
    for (const b of stripped === base ? [base] : [base, stripped]) {
      if (!folder) {
        if (b && fileSet.has(b)) return b;
        for (const ext of RESOLVE_EXT) if (fileSet.has(b + ext)) return b + ext;
      }
      const index = b ? `${b}/index` : "index";
      for (const ext of RESOLVE_EXT) if (fileSet.has(index + ext)) return index + ext;
    }
  }
  return undefined;
}

/**
 * What Node's require() loads for a path: the file of that very name first, then with an ending, then the folder. For a
 * name that can only stand for a folder, only the folder, as Node's Module._findPath does for a trailing "/", "." or "..".
 */
export function nodeLoads(base: string, has: (p: string) => boolean, main: (dir: string) => string | undefined, folder = false): string | undefined {
  if (!folder) {
    if (base && has(base)) return base;
    for (const ext of NODE_EXT) if (has(base + ext)) return base + ext;
  }
  const entry = main(base);
  const m = entry === undefined ? null : within(base, entry);
  if (m) {
    if (has(m)) return m;
    for (const ext of NODE_EXT) if (has(m + ext)) return m + ext;
    for (const ext of NODE_EXT) if (has(`${m}/index${ext}`)) return `${m}/index${ext}`;
  }
  for (const ext of NODE_EXT) if (has(`${base ? `${base}/` : ""}index${ext}`)) return `${base ? `${base}/` : ""}index${ext}`;
  return undefined;
}

/** Whether Node's require() gets as far as a path's folder: when there is no file of that very name, nor with an ending, or the name can only be a folder. */
export function loadsFolder(base: string, has: (p: string) => boolean, folder = false): boolean {
  return folder || (!(base && has(base)) && !NODE_EXT.some((ext) => has(base + ext)));
}

/** JSON with comments and trailing commas, as tsconfig files have them. Throws with the reason. */
export function readJsonc(text: string): unknown {
  if (text.length > MAX_CONFIG) throw new Error("is too large to be read");
  const plain = withoutTrailingCommas(withoutComments(text));
  try {
    return JSON.parse(plain);
  } catch {
    throw new Error("is not valid JSON");
  }
}

/** The text outside strings, with what is in comments made blank. */
function withoutComments(text: string): string {
  const parts: string[] = [];
  let last = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let i = last; i < text.length; ) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i += text[i] === "\\" ? 2 : 1);
      i++;
    } else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      const line = text[i + 1] === "/";
      const end = line ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
      if (end === -1 && !line) throw new Error("ends inside a comment");
      parts.push(text.slice(last, i), " ");
      i = end === -1 ? text.length : line ? end : end + 2;
      last = i;
    } else i++;
  }
  parts.push(text.slice(last));
  return parts.join("");
}

function withoutTrailingCommas(text: string): string {
  const parts: string[] = [];
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') for (i++; i < text.length && text[i] !== '"'; i += text[i] === "\\" ? 2 : 1);
    else if (c === ",") {
      let j = i + 1;
      while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) j++;
      if (text[j] === "}" || text[j] === "]") {
        parts.push(text.slice(last, i));
        last = i + 1;
      }
    }
  }
  parts.push(text.slice(last));
  return parts.join("");
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Json, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : typeof v === "string" ? [v] : []);

/**
 * Patterns with at most one "*", indexed so that finding the one that fits a name best costs about the length of the name,
 * not the number of patterns. Best is as TypeScript and Node pick it: the very name, or the longest part before "*", the
 * first of those written.
 */
class Patterns<T> {
  private readonly exact = new Map<string, T>();
  private readonly byHead = new Map<string, Array<{ tail: string; value: T }>>();
  private readonly lengths: number[];

  constructor(entries: Array<[string, T]>) {
    const lengths = new Set<number>();
    for (const [pattern, value] of entries) {
      const star = pattern.indexOf("*");
      if (star === -1) {
        if (!this.exact.has(pattern)) this.exact.set(pattern, value);
        continue;
      }
      const head = pattern.slice(0, star);
      const list = this.byHead.get(head) ?? [];
      list.push({ tail: pattern.slice(star + 1), value });
      this.byHead.set(head, list);
      lengths.add(head.length);
    }
    this.lengths = [...lengths].sort((x, y) => y - x);
  }

  /**
   * The best pattern for a name. Config with a few patterns costs nothing more; a step past that, a further length of the
   * part before "*" or a further pattern with the same part, is paid for with `pay`, and when that refuses, nothing fits.
   */
  match(name: string, pay: () => boolean = () => true): { value: T; star: string } | null {
    if (this.exact.has(name)) return { value: this.exact.get(name)!, star: "" };
    let steps = 0;
    for (const n of this.lengths) {
      if (n > name.length) continue;
      if (++steps > FREE_STEPS && !pay()) return null;
      const list = this.byHead.get(name.slice(0, n));
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        if (i > 0 && !pay()) return null;
        const { tail, value } = list[i];
        if (name.length >= n + tail.length && name.endsWith(tail)) return { value, star: name.slice(n, name.length - tail.length) };
      }
    }
    return null;
  }
}

/** Matchers by the entries they were made of, so that each is made once. */
const matchers = new WeakMap<object, Patterns<unknown>>();
function patterns<T>(key: object, entries: () => Array<[string, T]>): Patterns<T> {
  let m = matchers.get(key) as Patterns<T> | undefined;
  if (!m) matchers.set(key, (m = new Patterns(entries())));
  return m;
}

/** Path mappings of one tsconfig file, relative to the folder they were written in. */
interface Mappings {
  root: string;
  entries: Array<[string, string[]]>;
}

interface TsOptions {
  /** Null when it is outside the repo, so that nothing it or the paths stand for is in it. */
  baseUrl?: string | null;
  paths?: Mappings;
}

interface Own extends TsOptions {
  extends: string[];
}

/** The options of a tsconfig file that apply to some code, with the file they come from. */
interface Applying {
  file: string;
  options: TsOptions;
}

interface Package {
  dir: string;
  json: Json;
}

/** What a folder of the repo declares for the code below it. */
interface Scope {
  /** Packages by the name they are imported with. */
  packages: Map<string, Package[]>;
  /** npm: aliases, by the name they are imported with, to the packages that are installed. */
  aliases: Map<string, string[]>;
  /** package.json "imports", and the folder they are relative to. */
  imports?: Package;
}

export interface Candidates {
  files: string[];
  packages: string[];
  /** Some mapping or package was meant for the name, whether or not it led to a file. */
  matched: boolean;
  /** It leads to a file of the tree that is not a source file but would be run as code. */
  runs: boolean;
}

export interface ResolverInput {
  files: Record<string, string>;
  /** Source files. */
  fileSet: ReadonlySet<string>;
  /** Every path of the tree, when known, to tell config files that could not be read. */
  paths: ReadonlySet<string> | null;
  /** Trusted aliases, from the architecture. */
  aliases?: Record<string, string[]>;
  /** Whether a path of the tree that is not a source file would be run as code. Only with paths. */
  hidden?: (path: string) => boolean;
  /**
   * The config files of the trusted commit that a change started from. Names resolve with them as well, so a change to
   * config can add what a name stands for, but never take it away.
   */
  before?: Record<string, string>;
}

/** What all resolvers of one check spend together, and the gaps that this leaves wherever they are. */
interface Shared {
  work: number;
  probes: Map<string, string | undefined>;
  /** Characters of the paths looked for so far, and of those checked for code that is not read: what lookups cost. */
  chars: number;
  /** Whether a path, as found or not, leads to code that is not a source file. */
  hidden: Map<string, boolean>;
  spent: boolean;
  gaps: Map<string, string>;
}

export const packageNameOf = (spec: string): string => {
  if (spec.startsWith("@")) {
    const [scope, name] = spec.split("/");
    return name ? `${scope}/${name}` : spec;
  }
  return spec.split("/")[0];
};

/** The package.json of a package. */
const manifest = (pkg: Package) => (pkg.dir ? `${pkg.dir}/package.json` : "package.json");

class TooDeep extends Error {}

export class Resolver {
  private readonly input: ResolverInput;
  private readonly shared: Shared;
  private readonly parsed = new Map<string, Json | null>();
  private readonly broken = new Map<string, string>();
  private readonly tsconfigs = new Map<string, string[]>();
  private readonly own = new Map<string, Own | null>();
  private pathBudget = MAX_ALL_PATHS;
  private readonly effective = new Map<string, TsOptions | null>();
  private readonly scopes = new Map<string, Scope>();
  private readonly byDir = new Map<string, Applying[]>();
  private readonly aliasEntries: Array<[string, string[]]>;
  private readonly workspaceRoots: Array<{ dir: string; names: string[] }> = [];
  private readonly memo = new Map<string, Candidates>();
  /** What was left out on purpose, for the person who sets up the rules. */
  private readonly notes = new Set<string>();
  /** The same, with the config files of the commit the change started from. */
  private readonly earlier?: Resolver;

  constructor(input: ResolverInput, shared?: Shared) {
    this.input = input;
    this.shared = shared ?? { work: 0, probes: new Map(), chars: 0, hidden: new Map(), spent: false, gaps: new Map() };
    this.aliasEntries = Object.entries(input.aliases ?? {});
    const configs = Object.keys(input.files).filter(isConfigPath).sort();
    for (const p of configs) {
      if (!/^[tj]sconfig/.test(p.slice(p.lastIndexOf("/") + 1))) continue;
      const dir = dirname(p);
      const here = this.tsconfigs.get(dir) ?? [];
      if (here.length >= MAX_TSCONFIGS) {
        this.broken.set(p, "is one of too many tsconfig files in its folder");
        continue;
      }
      this.tsconfigs.set(dir, [...here, p]);
      this.options(p, []);
    }
    this.readPackages(configs);
    if (shared) return; // the earlier commit: its tree is not known, and it was checked when it was made
    if (input.paths) for (const p of input.paths) if (isConfigPath(p) && !Object.hasOwn(input.files, p)) this.broken.set(p, "could not be read");
    if (input.before) {
      const configsBefore = Object.fromEntries(Object.entries(input.before).filter(([p]) => isConfigPath(p)));
      this.earlier = new Resolver({ files: configsBefore, fileSet: input.fileSet, paths: input.paths, hidden: input.hidden }, this.shared);
    }
  }

  /** What a tsconfig file sets itself, or null when it cannot be read. */
  private ownOptions(p: string): Own | null {
    if (this.own.has(p)) return this.own.get(p)!;
    const json = Object.hasOwn(this.input.files, p) ? this.parse(p) : null;
    let result: Own | null = null;
    if (json) {
      const dir = dirname(p);
      const options = own(json, "compilerOptions");
      const opts = isObject(options) ? options : {};
      const baseUrl = typeof own(opts, "baseUrl") === "string" ? within(dir, own(opts, "baseUrl") as string) : undefined;
      const rawPaths = own(opts, "paths");
      const entries = isObject(rawPaths) ? Object.entries(rawPaths).map(([k, v]) => [k, strings(v)] as [string, string[]]) : [];
      this.pathBudget -= entries.length;
      if (entries.length > MAX_PATHS || this.pathBudget < 0 || entries.some(([, v]) => v.length > MAX_PATH_TARGETS)) this.broken.set(p, "has too many paths");
      else {
        result = { extends: strings(own(json, "extends")) };
        if (baseUrl !== undefined) result.baseUrl = baseUrl;
        // TypeScript allows one "*" in a pattern.
        if (isObject(rawPaths)) result.paths = { root: dir, entries: entries.filter(([k]) => (k.match(/\*/g)?.length ?? 0) <= 1) };
      }
    }
    this.own.set(p, result);
    return result;
  }

  /**
   * Config files that cannot be read and that are in a folder above some code, so they could change what it imports, and
   * config that asked for more work than a check may do, wherever it is.
   */
  problems(sources: Iterable<string>, reached: ReadonlySet<string> = new Set()): UnparsedFile[] {
    const dirs = new Set<string>();
    for (const f of sources) for (const d of ancestors(f)) dirs.add(d);
    // Also a package.json of a folder that a relative import loads, whose "main" decides what it runs.
    const all = new Map([...this.broken].filter(([p]) => dirs.has(dirname(p)) || reached.has(p)));
    for (const [p, reason] of this.shared.gaps) if (!all.has(p)) all.set(p, reason);
    return [...all].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, reason]) => ({ file, reason }));
  }

  private parse(p: string): Json | null {
    if (this.parsed.has(p)) return this.parsed.get(p)!;
    let json: Json | null = null;
    const text = this.input.files[p];
    if (p.endsWith(".yaml")) {
      try {
        const lines = yamlLines(text);
        const top = yamlTop(lines);
        const packages = yamlList(lines, top, "packages");
        const catalog = yamlMap(lines, top, "catalog");
        const over = yamlMap(lines, top, "overrides");
        const named = yamlCatalogs(lines, top);
        if (packages === null) this.broken.set(p, "has a packages list that cannot be read");
        else if (!catalog || !over || !named) this.broken.set(p, "has overrides or a catalog that cannot be read");
        // Each apart, so that an entry of one does not hide the same name in another.
        else json = { packages, overrides: [over, catalog, ...named] };
      } catch (err) {
        this.broken.set(p, (err as Error).message);
      }
    } else {
      try {
        const value = readJsonc(text);
        if (isObject(value)) json = value;
        else this.broken.set(p, "is not a JSON object");
      } catch (err) {
        this.broken.set(p, (err as Error).message);
      }
    }
    this.parsed.set(p, json);
    return json;
  }

  /** A tsconfig file with what it extends, or null when that cannot be read. */
  private options(p: string, stack: string[]): TsOptions | null {
    if (this.effective.has(p)) return this.effective.get(p)!;
    if (stack.includes(p) || stack.length > MAX_EXTENDS) {
      this.broken.set(p, stack.includes(p) ? "extends itself" : "extends too many files");
      return null;
    }
    const mine = this.ownOptions(p);
    let merged: TsOptions | null = mine && {};
    for (const ext of mine?.extends ?? []) {
      // A package is in node_modules, which is not read, and so is what is outside the repo.
      if (!ext.startsWith(".")) continue;
      const target = within(dirname(p), ext);
      if (target === null || target.split("/").includes("node_modules")) continue;
      const names = [target, `${target}.json`];
      const file = names.find((t) => Object.hasOwn(this.input.files, t));
      // Not in the tree at all, as what SvelteKit or Nuxt generate and git ignores: like a package, it is not read.
      if (file === undefined && !names.some((t) => this.input.paths?.has(t))) {
        this.notes.add(`${p} extends ${target}, which is not in the repository (generated or ignored), so what it sets is not used`);
        continue;
      }
      const base = this.options(file ?? target, [...stack, p]);
      if (!base) {
        this.broken.set(p, "extends a file that cannot be read");
        merged = null;
        break;
      }
      merged = { ...merged, ...base };
    }
    const result = merged && mine ? { ...merged, ...(mine.baseUrl !== undefined ? { baseUrl: mine.baseUrl } : {}), ...(mine.paths ? { paths: mine.paths } : {}) } : null;
    this.effective.set(p, result);
    return result;
  }

  private readPackages(configs: string[]): void {
    const packages: Package[] = [];
    const byName = new Map<string, Package[]>();
    const scope = (dir: string): Scope => {
      let s = this.scopes.get(dir);
      if (!s) this.scopes.set(dir, (s = { packages: new Map(), aliases: new Map() }));
      return s;
    };
    const add = (s: Scope, name: string, pkg: Package) => {
      const list = s.packages.get(name) ?? [];
      if (!list.includes(pkg)) list.push(pkg);
      s.packages.set(name, list);
    };
    const alias = (s: Scope, name: string | null, real: string | null) => {
      if (!name || !real) return;
      const list = s.aliases.get(name) ?? [];
      if (!list.includes(real)) list.push(real);
      s.aliases.set(name, list);
    };
    for (const p of configs) {
      if (!p.endsWith("package.json")) continue;
      const json = this.parse(p);
      if (!json) continue;
      const pkg = { dir: dirname(p), json };
      packages.push(pkg);
      const name = own(json, "name");
      if (typeof name === "string" && name) byName.set(name, [...(byName.get(name) ?? []), pkg]);
    }
    const roots: Array<{ file: string; dir: string; globs: string[] }> = [];
    for (const p of configs) {
      if (!p.endsWith("pnpm-workspace.yaml") && !p.endsWith("lerna.json")) continue;
      const json = this.parse(p);
      if (!json) continue;
      const dir = dirname(p);
      if (p.endsWith("pnpm-workspace.yaml")) {
        roots.push({ file: p, dir, globs: strings(own(json, "packages")) });
        const maps = own(json, "overrides");
        for (const map of Array.isArray(maps) ? maps : []) overrides(map, null, 0, (name, real) => alias(scope(dir), name, real));
      } else roots.push({ file: p, dir, globs: own(json, "packages") === undefined ? ["packages/*"] : strings(own(json, "packages")) });
    }
    for (const pkg of packages) {
      const { dir, json } = pkg;
      const s = scope(dir);
      const name = own(json, "name");
      if (typeof name === "string" && name) add(s, name, pkg); // a package may import itself by its name
      const ws = own(json, "workspaces");
      if (ws !== undefined) roots.push({ file: manifest(pkg), dir, globs: strings(isObject(ws) ? own(ws, "packages") : ws) });
      if (isObject(own(json, "imports"))) s.imports = pkg;
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        const deps = own(json, field);
        if (!isObject(deps)) continue;
        for (const [key, value] of Object.entries(deps)) {
          if (typeof value !== "string") continue;
          const protocol = /^(npm|patch|workspace|file|link|portal):(.*)$/s.exec(value);
          if (!protocol) {
            alias(s, key, fetchedPackage(value));
            continue;
          }
          const [, kind, rest] = protocol;
          if (kind === "npm" || kind === "patch") alias(s, key, installedAs(value));
          else if (kind === "workspace") {
            for (const target of byName.get(/^(@?[^@]+)@/.test(rest) && !/^[\^~*\d]/.test(rest) ? rest.slice(0, rest.lastIndexOf("@")) : key) ?? []) add(s, key, target);
          } else {
            const target = within(dir, rest);
            const found = target === null ? undefined : packages.find((other) => other.dir === target);
            if (found) add(s, key, found);
            else alias(s, key, fetchedPackage(rest));
          }
        }
      }
      // What a package manager installs in place of a package, under the name of that package.
      const add2 = (name: string | null, real: string | null) => alias(s, name, real);
      if (!overrides(own(json, "overrides"), null, 0, add2) || !overrides(own(json, "resolutions"), null, 0, add2)) this.broken.set(manifest(pkg), "nests overrides too deeply");
      const pnpm = own(json, "pnpm");
      if (isObject(pnpm) && !overrides(own(pnpm, "overrides"), null, 0, add2)) this.broken.set(manifest(pkg), "nests overrides too deeply");
    }
    let tests = 0;
    for (const root of roots) {
      const globs = root.globs.map((g) => g.replace(/^\.\//, "").replace(/\/+$/, ""));
      tests += globs.length * packages.length;
      if (globs.length > MAX_GLOBS || tests > MAX_GLOB_TESTS) {
        this.broken.set(root.file, "has too many workspace patterns");
        continue;
      }
      const yes = compileGlobs(globs.filter((g) => g && !g.startsWith("!")));
      const no = compileGlobs(globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1)));
      const names: string[] = [];
      for (const pkg of packages) {
        if (pkg.dir === root.dir || !under(root.dir, pkg.dir)) continue;
        const rel = root.dir ? pkg.dir.slice(root.dir.length + 1) : pkg.dir;
        if (!yes(rel) || no(rel)) continue;
        // A package manager installs what a member depends on for the whole workspace.
        const members = this.scopes.get(pkg.dir)!;
        const here = scope(root.dir);
        for (const [key, list] of members.packages) for (const other of list) add(here, key, other);
        for (const [key, list] of members.aliases) for (const real of list) alias(here, key, real);
        const name = own(pkg.json, "name");
        if (typeof name === "string" && name) names.push(name);
      }
      this.workspaceRoots.push({ dir: root.dir, names });
    }
  }

  /** What was left out on purpose, in sentences. */
  noted(): string[] {
    return [...this.notes].sort();
  }

  /** Whether a package.json was read, so that its "main" is known. One in node_modules, too large or broken is not. */
  knows(manifestPath: string): boolean {
    return (this.parsed.get(manifestPath) ?? null) !== null;
  }

  /** The package.json "main" of a folder, for Node. */
  main(dir: string): string | undefined {
    const json = this.parsed.get(dir ? `${dir}/package.json` : "package.json");
    const main = json ? own(json, "main") : undefined;
    return typeof main === "string" ? main : undefined;
  }

  /** The "main" of a folder now, and in the commit the change started from when it was different there. */
  mains(dir: string): Array<string | undefined> {
    const now = this.main(dir);
    const then = this.earlier?.main(dir);
    return then === undefined || then === now ? [now] : [now, then];
  }

  /** Count one target tried. False once a check has tried too many, which leaves a gap at the file that asked for them. */
  private charge(blame: string): boolean {
    const s = this.shared;
    if (s.spent) return false;
    if (++s.work > MAX_WORK || s.probes.size >= MAX_PROBES || s.hidden.size >= MAX_PROBES || s.chars >= MAX_PROBE_CHARS) {
      s.spent = true;
      s.gaps.set(blame, "takes too many lookups to resolve the imports below it");
      return false;
    }
    return true;
  }

  private probe(base: string | null, folder = false): string | undefined {
    if (base === null) return undefined;
    const known = this.shared.probes;
    const key = folder ? `${base}/` : base;
    if (known.has(key)) return known.get(key);
    const file = fileAt(this.input.fileSet, [base], folder);
    known.set(key, file);
    this.shared.chars += base.length + 1;
    return file;
  }

  /**
   * Whether a target leads to a file of the tree that is not a source file but would be run as code: by its very name,
   * which is what Node loads for exports, imports and its own resolution, or, when no source file was found for it, with
   * an ending or as a folder, as bundlers look for it. `types` is for a target that only TypeScript reads: tsconfig, the
   * "types" and "typings" fields and the types condition, where a declaration file is not run.
   */
  private hiddenAt(path: string | null, found: boolean, out: Candidates, types = false, folder = false): void {
    const { hidden, paths } = this.input;
    if (path === null || !hidden || !paths || out.runs || (types && /\.d\.[mc]?ts$/.test(path))) return;
    const key = `${found ? 1 : folder ? 2 : 0}${path}`;
    let runs = this.shared.hidden.get(key);
    if (runs === undefined) {
      const index = ADDED_EXT.map((e) => `${path ? `${path}/` : ""}index${e}`);
      const tries = found ? [path] : folder ? index : [path, ...ADDED_EXT.map((e) => path + e), ...index];
      runs = tries.some((p) => p && paths.has(p) && hidden(p));
      this.shared.hidden.set(key, runs);
      this.shared.chars += path.length + 1;
    }
    if (runs) out.runs = true;
  }

  /** The tsconfig options that apply to code in a folder: those of every tsconfig in it and in the folders above. */
  private optionsFor(dir: string): Applying[] {
    let list = this.byDir.get(dir);
    if (list) return list;
    list = [];
    for (const d of ancestors(dir ? `${dir}/x` : "x")) {
      for (const p of this.tsconfigs.get(d) ?? []) {
        const o = this.effective.get(p);
        if (!o || o.baseUrl === null || (o.baseUrl === undefined && !o.paths)) continue;
        if (list.length >= MAX_APPLYING) this.broken.set(p, "is one of too many tsconfig files with paths or baseUrl that apply to the same code");
        else list.push({ file: p, options: o });
      }
    }
    this.byDir.set(dir, list);
    return list;
  }

  /** Files that path mappings lead to: the first target of the best pattern that is there, as TypeScript takes it. */
  private mapped(entries: Array<[string, string[]]>, root: string, name: string, out: Candidates, blame: string): void {
    const folder = namesFolder(name);
    const hit = patterns(entries, () => entries).match(name, () => this.charge(blame));
    if (!hit) return;
    out.matched = true;
    for (const target of hit.value) {
      if (!this.charge(blame)) return;
      const path = within(root, target.replace("*", hit.star));
      const file = this.probe(path, folder);
      this.hiddenAt(path, file !== undefined, out, true, folder);
      if (file) {
        out.files.push(file);
        return;
      }
      if (path !== null && isConfigPath(path) && this.parsed.has(path)) {
        out.files.push(path);
        return;
      }
    }
  }

  /** What a module name that is not relative may also stand for in the repo. The package edge it has stays as well. */
  resolve(from: string, spec: string): Candidates {
    const now = this.resolveHere(from, spec, 0);
    if (!this.earlier) return now;
    const then = this.earlier.resolveHere(from, spec, 0);
    return finish({ files: [...now.files, ...then.files], packages: [...now.packages, ...then.packages], matched: now.matched || then.matched, runs: now.runs || then.runs });
  }

  private resolveHere(from: string, spec: string, depth: number): Candidates {
    const name = spec.replace(/\?.*$/s, "");
    const dir = dirname(from);
    const key = `${dir}\0${name}`;
    if (depth === 0 && this.memo.has(key)) return this.memo.get(key)!;
    const out: Candidates = { files: [], packages: [], matched: false, runs: false };
    if (!name || this.shared.spent) return out;
    for (const { file: tsconfig, options: o } of this.optionsFor(dir)) {
      if (o.paths) this.mapped(o.paths.entries, o.baseUrl ?? o.paths.root, name, out, tsconfig);
      if (o.baseUrl !== undefined && o.baseUrl !== null && this.charge(tsconfig)) {
        const path = within(o.baseUrl, name);
        const file = this.probe(path, namesFolder(name));
        this.hiddenAt(path, file !== undefined, out, true, namesFolder(name));
        if (file) out.files.push(file);
      }
    }
    if (this.aliasEntries.length) this.mapped(this.aliasEntries, "", name, out, "voxium/architecture.json");
    const scopes = ancestors(from).map((d) => this.scopes.get(d)).filter((s): s is Scope => s !== undefined);
    if (name.startsWith("#")) {
      for (const s of scopes) if (s.imports) this.fromImports(s.imports, name, out, from, depth);
    } else {
      const pkg = packageNameOf(name);
      const sub = name.slice(pkg.length);
      for (const s of scopes) {
        for (const real of s.aliases.get(pkg) ?? []) {
          out.matched = true;
          out.packages.push(packageNameOf(real));
        }
        for (const p of s.packages.get(pkg) ?? []) {
          out.matched = true;
          out.files.push(...this.inPackage(p, sub, out));
        }
      }
    }
    const result = finish(out);
    if (depth === 0) this.memo.set(key, result);
    return result;
  }

  /** Every target of an exports or imports entry, or none with a gap at its package.json when they nest too deeply. */
  private leavesOf(pkg: Package, value: unknown): Leaf[] {
    if (typeof value === "string") return [[value, false]];
    if (typeof value !== "object" || value === null) return [];
    let found = leafCache.get(value);
    if (found) return found;
    try {
      found = leaves(value);
    } catch (err) {
      if (!(err instanceof TooDeep)) throw err;
      this.shared.gaps.set(manifest(pkg), "nests the conditions of exports or imports too deeply");
      found = [];
    }
    leafCache.set(value, found);
    return found;
  }

  /**
   * The exports or imports of a package as a map of entries, the subpaths of exports with "." for a package that exports
   * one thing, or null with a gap at its package.json when it has more entries than any package needs.
   */
  private entries(pkg: Package, field: "exports" | "imports"): Json | null {
    const key = field === "exports" ? exportCache : importCache;
    if (key.has(pkg.json)) return key.get(pkg.json)!;
    const value = own(pkg.json, field);
    let map: Json | null = null;
    if (field === "imports") map = isObject(value) ? value : null;
    else if (value !== undefined && value !== null) map = isObject(value) && Object.keys(value).some((k) => k.startsWith(".")) ? value : { ".": value };
    if (map && Object.keys(map).length > MAX_MAP_ENTRIES) {
      this.shared.gaps.set(manifest(pkg), "has too many entries in exports or imports");
      map = {};
    }
    key.set(pkg.json, map);
    return map;
  }

  private fromImports(pkg: Package, name: string, out: Candidates, from: string, depth: number): void {
    const map = this.entries(pkg, "imports");
    if (!map) return;
    const hit = patterns(map, () => Object.entries(map)).match(name, () => this.charge(manifest(pkg)));
    if (!hit) return;
    out.matched = true;
    for (const [leaf, types] of this.leavesOf(pkg, hit.value)) {
      if (!this.charge(manifest(pkg))) return;
      const target = leaf.replaceAll("*", hit.star);
      if (target.startsWith("./")) {
        const path = within(pkg.dir, target);
        const file = this.inDist(pkg.dir, path);
        this.hiddenAt(path, file !== undefined, out, types);
        if (file) out.files.push(file);
      } else if (!target.startsWith(".") && !target.startsWith("/") && !target.startsWith("#")) {
        // An import that is a package, such as "#db": "pg", is that package.
        out.packages.push(packageNameOf(target.replace(/^node:/, "")));
        if (depth < 1) {
          const more = this.resolveHere(from, target, depth + 1);
          out.files.push(...more.files);
          out.packages.push(...more.packages);
          out.runs ||= more.runs;
        }
      }
    }
  }

  /** The files of a package that a subpath ("" or "/x") stands for, or its package.json when none can be found. */
  private inPackage(pkg: Package, sub: string, out?: Candidates): string[] {
    const found = new Set<string>();
    const at = (path: string | null, types: boolean) => {
      if (!this.charge(manifest(pkg))) return;
      const file = this.inDist(pkg.dir, path);
      if (out) this.hiddenAt(path, file !== undefined, out, types);
      if (file) found.add(file);
    };
    const map = this.entries(pkg, "exports");
    if (map) {
      const hit = patterns(map, () => Object.entries(map)).match(`.${sub}`, () => this.charge(manifest(pkg)));
      for (const [leaf, types] of hit ? this.leavesOf(pkg, hit.value) : []) if (leaf.startsWith("./")) at(within(pkg.dir, leaf.replaceAll("*", hit!.star)), types);
    } else if (!sub) {
      for (const field of ["main", "module", "types", "typings"]) {
        const entry = own(pkg.json, field);
        if (typeof entry === "string") at(within(pkg.dir, entry), field === "types" || field === "typings");
      }
      if (!found.size) {
        const file = this.probe(within(pkg.dir, "src/index")) ?? this.probe(within(pkg.dir, "index"));
        if (file) found.add(file);
      }
    } else {
      if (this.charge(manifest(pkg))) {
        const path = within(pkg.dir, sub.slice(1));
        const folder = namesFolder(sub);
        const file = (folder ? this.probe(path, true) : this.inDist(pkg.dir, path)) ?? this.probe(within(pkg.dir, `src${sub}`), folder);
        if (out) this.hiddenAt(path, file !== undefined, out, false, folder);
        if (file) found.add(file);
      }
    }
    return found.size ? [...found] : [manifest(pkg)];
  }

  /** A file of a package, or the source it is built from: dist/x.js stands for src/x.ts. */
  private inDist(dir: string, path: string | null): string | undefined {
    if (path === null) return undefined;
    const plain = path.replace(/\.d\.[mc]?ts$/, "");
    const file = this.probe(path) ?? this.probe(plain);
    if (file) return file;
    const rel = dir ? plain.slice(dir.length + 1) : plain;
    const built = /^(?:dist|build|out|lib)(?:\/(?:esm|cjs|es|umd|types|mjs|node|browser))?\/(.+)$/.exec(rel);
    return built ? this.probe(within(dir, `src/${built[1]}`)) : undefined;
  }

  /**
   * Aliases of the repo as a whole, for the architecture: the paths of the root tsconfig, and the packages of the root
   * workspace. Checks then still see them when a change edits or removes the config files.
   */
  rootAliases(): Record<string, string[]> {
    const out = new Map<string, string[]>();
    const left: string[] = [];
    // Only what the architecture can hold, so that the rules init writes are valid. A path to the root itself cannot be written.
    const put = (name: string, targets: string[]) => {
      if (out.has(name)) return;
      const ok = targets.filter((t) => aliasTargetOk(name, t));
      if (!aliasNameOk(name) || !ok.length || out.size >= MAX_ALIASES) left.push(name);
      else {
        if (ok.length > MAX_ALIAS_TARGETS) left.push(name);
        out.set(name, ok.slice(0, MAX_ALIAS_TARGETS));
      }
    };
    for (const p of ["tsconfig.json", "jsconfig.json"]) {
      const o = this.effective.get(p);
      if (!o || o.baseUrl === null) continue;
      if (o.paths) {
        const root = o.baseUrl ?? o.paths.root;
        for (const [pattern, targets] of o.paths.entries) {
          const repo = targets.map((t) => within(root, t)).filter((t): t is string => t !== null);
          if (repo.length) put(pattern, repo);
        }
      }
      if (o.baseUrl !== undefined) put("*", [o.baseUrl ? `${o.baseUrl}/*` : "*"]);
    }
    for (const { dir, names } of this.workspaceRoots) {
      if (dir) continue;
      for (const name of names) {
        for (const pkg of this.scopes.get("")?.packages.get(name) ?? []) {
          put(name, this.inPackage(pkg, ""));
          put(`${name}/*`, [`${pkg.dir}/src/*`, `${pkg.dir}/*`]);
        }
      }
    }
    if (left.length) {
      const some = [...new Set(left)];
      this.notes.add(`Not written to "aliases", since the architecture cannot hold them (a path to the root of the repo, a "*" only in the path, more than ${MAX_ALIAS_TARGETS} paths for one name, or more than ${MAX_ALIASES} names): ${some.slice(0, 10).join(", ")}${some.length > 10 ? ", ..." : ""}`);
    }
    return Object.fromEntries([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
}

function finish(out: Candidates): Candidates {
  return { files: [...new Set(out.files)], packages: [...new Set(out.packages)], matched: out.matched, runs: out.runs };
}

/** A target of exports or imports, and whether it is only under a types condition, which TypeScript alone reads. */
type Leaf = [string, boolean];
const leafCache = new WeakMap<object, Leaf[]>();
const exportCache = new WeakMap<Json, Json | null>();
const importCache = new WeakMap<Json, Json | null>();
const isTypes = (condition: string) => condition === "types" || condition === "typings" || condition.startsWith("types@");

/** Every target of an exports or imports entry, under any condition, since which one applies depends on the tool. */
function leaves(value: unknown, depth = 0, types = false): Leaf[] {
  if (typeof value === "string") return [[value, types]];
  if (depth > MAX_CONDITIONS) throw new TooDeep();
  if (Array.isArray(value)) return value.flatMap((v) => leaves(v, depth + 1, types));
  if (isObject(value)) return Object.entries(value).flatMap(([k, v]) => leaves(v, depth + 1, types || isTypes(k)));
  return [];
}

/** The package an npm: alias installs: "npm:pg@8" is pg, and "npm:8.1.0" is only a version of the package itself. */
function aliased(value: string): string | null {
  const rest = value.slice(4);
  const at = rest.lastIndexOf("@");
  const name = at > 0 ? rest.slice(0, at) : rest;
  return name && !/^[\d^~*<>=]/.test(name) ? name : null;
}

/**
 * The package that a dependency or an override installs under its name: what an npm: alias names, what a Yarn patch:
 * wraps ("patch:pg@npm%3A8.11.0#./p.patch" is pg), or a package fetched from elsewhere. Null for a plain version.
 */
function installedAs(value: string, depth = 0): string | null {
  if (value.startsWith("npm:")) return aliased(value);
  if (!value.startsWith("patch:")) return fetchedPackage(value);
  let inner = value.slice(6).replace(/#.*$/s, "");
  try {
    inner = decodeURIComponent(inner);
  } catch {
    // as it is written
  }
  const at = inner.indexOf("@", 1);
  const name = at === -1 ? inner : inner.slice(0, at);
  const range = at === -1 ? "" : inner.slice(at + 1);
  const real = depth < 4 && /^[a-z]+:/i.test(range) ? installedAs(range, depth + 1) : null;
  return real ?? (name || null);
}

/**
 * The package that a dependency fetched from somewhere else than the registry most likely is: a registry tarball by the
 * name in its URL, any other tarball, git or GitHub dependency by the last part of its path. Its real name is in the
 * package itself, which is not read.
 */
function fetchedPackage(value: string): string | null {
  const v = value.trim().replace(/#.*$/s, "").replace(/\?.*$/s, "");
  const registry = /(?:^|\/)((?:@[^/]+\/)?[^/@]+)\/-\/[^/]+\.tgz$/i.exec(v);
  if (registry) return registry[1];
  if (!/^(?:[a-z][a-z\d+.-]*:|[^/@\s]+\/[^/\s]+$)|\.(?:tgz|tar\.gz|tar)$/i.test(v) || /^(?:workspace|catalog|npm):/.test(v)) return null;
  const last = v.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = last.replace(/\.(?:git|tgz|tar\.gz|tar)$/i, "").replace(/-v?\d+(?:\.\d+)*(?:[-+].*)?$/, "");
  return /^[a-z\d][\w.-]*$/i.test(name) ? name : null;
}

/** The package an override key is about: "x", "x@1", "a>x" (pnpm), "**\/x" and "a/x" (yarn), and scoped names. */
function overrideName(key: string): string | null {
  const parts = key.slice(key.lastIndexOf(">") + 1).split("/");
  let name = parts[parts.length - 1];
  if (parts.length > 1 && parts[parts.length - 2].startsWith("@")) name = parts.slice(-2).join("/");
  const at = name.indexOf("@", 1);
  if (at > 0) name = name.slice(0, at);
  return name && name !== "**" && name !== "." ? name : null;
}

/**
 * The packages that overrides, resolutions and pnpm.overrides install in place of others, as npm: aliases or fetched from
 * elsewhere. npm nests them by the package they are for, with "." for that package. False when they nest too deeply.
 */
function overrides(value: unknown, parent: string | null, depth: number, alias: (name: string | null, real: string | null) => void): boolean {
  if (!isObject(value)) return true;
  if (depth > MAX_CONDITIONS) return false;
  for (const [key, v] of Object.entries(value)) {
    const name = key === "." ? parent : overrideName(key);
    if (typeof v === "string") alias(name, installedAs(v));
    else if (!overrides(v, name, depth + 1, alias)) return false;
  }
  return true;
}

/** White space in YAML: only a space or a tab. Other characters that look blank are text to YAML (see yamlLines). */
const isBlank = (c: string | undefined) => c === " " || c === "\t";

/** Where a comment begins in a line of YAML outside quotes: a "#" at its start or after white space. -1 when none. */
function commentAt(s: string): number {
  for (let i = s.indexOf("#"); i !== -1; i = s.indexOf("#", i + 1)) if (i === 0 || isBlank(s[i - 1])) return i;
  return -1;
}

/** A YAML scalar as written in a list or mapping, without quotes or a comment after it. */
function yamlScalar(s: string): string {
  const t = s.trim();
  // A doubled quote inside single quotes is one quote to YAML; such values are not read rather than read wrongly.
  if (t[0] === "'" && t.indexOf("''", 1) !== -1) throw new Error("has a quoted value with a doubled quote, which cannot be read safely");
  if (t[0] === "'" || t[0] === '"') {
    const end = t.indexOf(t[0], 1);
    // YAML goes on reading a quoted value over the next lines until its quote closes; those values are not read.
    if (end === -1) throw new Error("has a quoted value that goes on over lines, which cannot be read safely");
    const after = t.slice(end + 1).trimStart();
    if (after === "" || after[0] === "#") return t.slice(1, end);
    throw new Error("has text after a quoted value, which cannot be read safely");
  }
  const c = commentAt(t);
  return (c === -1 ? t : t.slice(0, c)).trim();
}

/** A quoted or plain key, then a colon and what follows it, or null when the text does not start that way. */
function yamlKeyOf(t: string): { name: string; after: string } | null {
  if (t[0] === "'" || t[0] === '"') {
    const end = t.indexOf(t[0], 1);
    if (end === -1) return null;
    const rest = t.slice(end + 1).trimStart();
    return rest[0] === ":" ? { name: t.slice(1, end), after: rest.slice(1) } : null;
  }
  if (!t || isBlank(t[0]) || t[0] === "#") return null;
  const colon = t.search(/:(?:[ \t]|$)/);
  if (colon <= 0 || t.slice(0, colon).includes("#")) return null;
  return { name: t.slice(0, colon).trimEnd(), after: t.slice(colon + 1) };
}

/** The keys at the top of a YAML file: the line of each, and what follows its colon without a comment. */
type YamlTop = Map<string, { at: number; rest: string }>;

/** How far a flow list or map has been read: inside which quote, and whether a scalar may start here. */
type Flow = { quote: string; start: boolean; closed: boolean };

const newFlow = (): Flow => ({ quote: "", start: true, closed: false });

/**
 * One character of a flow list or map, outside a comment, read as YAML reads it: 0 when it is outside quotes, 1 when it
 * belongs to a quoted scalar (its quotes included), 2 when it and the next one are an escape inside quotes ("''" in single
 * quotes, a backslash and what follows in double quotes). A quote opens a scalar only where one starts: after "[", "{",
 * "," or ": ", or after the ":" of a quoted key. Anywhere else YAML reads it as plain text, so "foo: [it's]" is one word;
 * rather than follow that, it throws, since reading such a quote as the start of a string would hide what comes after it.
 */
function flowStep(f: Flow, text: string, i: number): 0 | 1 | 2 {
  const c = text[i];
  if (f.quote) {
    if (f.quote === '"' && c === "\\") return 2;
    if (c === f.quote) {
      if (c === "'" && text[i + 1] === "'") return 2;
      f.quote = "";
      f.closed = true;
    }
    return 1;
  }
  if (c === "'" || c === '"') {
    if (!f.start) throw new Error("has a quote inside a plain value, which cannot be read safely");
    f.quote = c;
    f.start = false;
    return 1;
  }
  if (isBlank(c)) return 0;
  if (c === "[" || c === "{" || c === ",") f.start = true;
  else if (c === ":") f.start = f.closed || i + 1 >= text.length || isBlank(text[i + 1]);
  else f.start = false;
  f.closed = false;
  return 0;
}

/**
 * A line that goes on with a flow list or map must be indented, except for the bracket that closes it, since YAML parsers
 * differ on what such a line at the left edge means. Throws on one.
 */
function leftEdge(text: string, f: Flow): void {
  if (f.quote || text === "" || isBlank(text[0]) || text[0] === "]" || text[0] === "}" || text[0] === "#") return;
  throw new Error("is written in a form of YAML that cannot be read");
}

/** Whether a "#" outside quotes starts a comment: at the start of a line or after white space. */
const commentStarts = (text: string, i: number) => text[i] === "#" && (i === 0 || isBlank(text[i - 1]));

/**
 * Where the flow list or map that starts a value ends: the index of its last line, or -1 when it does not end. Brackets
 * inside quotes and comments do not count. Throws on a quote YAML reads as plain text (see flowStep).
 */
function flowEnd(first: string, lines: string[], next: number): number {
  const open: string[] = [];
  const f = newFlow();
  for (let text = first, at = next - 1; ; text = lines[++at]) {
    if (at >= next) leftEdge(text, f);
    for (let i = 0; i < text.length; i++) {
      if (!f.quote && commentStarts(text, i)) break;
      const kind = flowStep(f, text, i);
      if (kind === 2) i++;
      if (kind !== 0) continue;
      const c = text[i];
      if (c === "[" || c === "{") open.push(c === "[" ? "]" : "}");
      else if (c === "]" || c === "}") {
        if (open.pop() !== c) throw new Error("has brackets that do not match");
        if (!open.length) return at;
      }
    }
    if (at + 1 >= lines.length) return -1;
  }
}

/** A plain key that YAML reads as it is written: not a tag, anchor, alias, explicit or merge key, nor any other indicator. */
const PLAIN_KEY = /^[^-?:,[\]{}#&*!|>'"%@`<\s]/;

/**
 * The keys at the top of a YAML file, as pnpm-workspace.yaml has them. Throws when the top of the file is written in any
 * other way: a document that is a flow map or list, a tag, anchor or alias, an explicit or merge key, an escape in a
 * quoted key, a key twice, content indented before the first key, or a second document. YAML reads all of these, and
 * pnpm with it, so reading them as no keys at all would let packages and overrides hide.
 */
function yamlTop(lines: string[]): YamlTop {
  const top: YamlTop = new Map();
  const bad = () => new Error("is written in a form of YAML that cannot be read");
  let list = false; // in a block list that is the value of the key before, which may start at the left edge
  let content = false;
  let ended = false;
  let blockText = false; // in the block text that is the value of the key before
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const t = line.trim();
    if (t === "" || t[0] === "#") continue;
    // A document starts with "---" and ends with "..."; a second one is not read.
    if (ended || (line === "---" && content)) throw bad();
    if (line === "---") continue;
    if (line === "...") {
      ended = true;
      continue;
    }
    if (isBlank(line[0])) {
      if (!content) throw bad();
      // A read key indented under another one: YAML parsers differ on whether it belongs to the top. Inside block text
      // ("key: |" or "key: >") it is only text.
      if (!blockText && /^["']?(?:packages|overrides|catalogs?)["']?[ \t]*:/.test(t)) throw bad();
      continue;
    }
    content = true;
    if (list && line[0] === "-" && (line.length === 1 || isBlank(line[1]))) continue;
    const found = yamlKeyOf(line);
    if (!found || escaped(line.slice(0, line.length - found.after.length)) || (line[0] !== '"' && line[0] !== "'" && !PLAIN_KEY.test(line))) throw bad();
    if (top.has(found.name)) throw new Error("has the same key twice");
    // After a plain key the colon is followed by white space; after a quoted one it need not be.
    const raw = found.after.trim();
    const rest = raw[0] === "#" ? "" : raw;
    top.set(found.name, { at: i, rest });
    list = rest === "";
    blockText = /^[|>]/.test(rest);
    if (rest[0] === "[" || rest[0] === "{") {
      const end = flowEnd(rest, lines, i + 1);
      // One that does not end is a gap where its value is read, and here when it is another key's, whose value would take the rest.
      if (end === -1 && !READ_KEYS.has(found.name)) throw bad();
      if (end === -1) break;
      i = end;
    }
  }
  return top;
}

/** The keys of pnpm-workspace.yaml that are read. */
const READ_KEYS = new Set(["packages", "overrides", "catalog", "catalogs"]);

function yamlKey(top: YamlTop, key: string): { at: number; rest: string } | null {
  return top.get(key) ?? null;
}

/** "key: value" with a plain or quoted value, or null when it is not one, or its value is in a form this does not read. */
function yamlPair(t: string): [string, string] | null {
  const key = t.trim();
  const found = yamlKeyOf(key);
  if (!found || escaped(key.slice(0, key.length - found.after.length)) || (key[0] !== "'" && key[0] !== '"' && !PLAIN_KEY.test(key))) return null;
  const raw = found.after.trim();
  const value = yamlScalar(raw);
  return value && !escaped(raw) && !unsafePlain(raw) ? [found.name, value] : null;
}

/**
 * Whether a value that is not quoted is something other than plain text to YAML, or could be: it starts with an indicator
 * (a list, map, anchor, alias, tag, block text, directive or reserved character, or "-", "?" or ":" before white space),
 * or holds ": " or ends in ":", which make it a mapping. Such values are not read rather than read as text.
 */
function unsafePlain(raw: string): boolean {
  if (raw[0] === "'" || raw[0] === '"') return false;
  const value = yamlScalar(raw);
  return /^(?:[[\]{}&*!|>%@`,]|[-?:](?:[ \t]|$))/.test(value) || /:(?:[ \t]|$)/.test(value);
}

/** Whether a scalar is double quoted with an escape in it, which YAML reads as some other text than is written. */
function escaped(raw: string): boolean {
  return raw.trimStart()[0] === '"' && raw.includes("\\");
}

/** The lines of a YAML file, which must not be too large nor have a line too long to read in time. Throws with the reason. */
function yamlLines(text: string): string[] {
  if (text.length > MAX_CONFIG) throw new Error("is too large to be read");
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // YAML parsers differ on what else ends a line (a lone CR, NEL, LS, PS) and on what is white space, and reading those
  // differently from pnpm could hide a key. Honest files have none of them.
  if (/\r(?!\n)|[\u0085\u2028\u2029]|[^\S \t\r\n]/.test(body)) throw new Error("has a line break or white space that YAML readers disagree on");
  const lines = body.split(/\r?\n/);
  if (lines.some((l) => l.length > MAX_YAML_LINE)) throw new Error("has a line too long to be read");
  return lines;
}

const blank = (line: string) => {
  const t = line.trim();
  return t === "" || t[0] === "#" || line.trimEnd() === "---" || line.trimEnd() === "...";
};

/**
 * The items of a flow list or map, which starts with "[" or "{" in the value of a key and may go on over the lines after
 * it: split at the commas outside quotes, without comments. Null when it does not end, has more after its end, or nests.
 */
function yamlFlow(first: string, lines: string[], next: number): string[] | null {
  const close = first[0] === "[" ? "]" : "}";
  const items: string[] = [];
  let item = "";
  const f = newFlow();
  for (let text = first.slice(1), at = next; ; text = lines[at++]) {
    if (at > next) leftEdge(text, f);
    for (let i = 0; i < text.length; i++) {
      if (!f.quote && commentStarts(text, i)) break;
      const kind = flowStep(f, text, i);
      const c = text[i];
      if (kind === 2) {
        item += c + (text[i + 1] ?? "");
        i++;
        continue;
      }
      if (kind === 0 && c === ",") {
        items.push(item);
        item = "";
        continue;
      }
      if (kind === 0 && c === close) {
        const rest = text.slice(i + 1).trim();
        if (rest && rest[0] !== "#") return null;
        items.push(item);
        return items.filter((x) => x.trim());
      }
      if (kind === 0 && (c === "[" || c === "]" || c === "{" || c === "}")) return null;
      item += c;
    }
    if (at >= lines.length) return null;
    // A plain value that goes on over the next line is read differently by YAML parsers; only a break between values is read.
    if (!f.quote && item.trim() && !/^[ \t]*(?:[,\]}]|#|$)/.test(lines[at])) return null;
    item += " ";
  }
}

/**
 * The items of a list under a key at the top of a YAML file, as pnpm-workspace.yaml has it: a block list, indented or
 * not, or a flow list on one or more lines. [] when the key is not there, null when its value is something this cannot
 * read, so that it is a gap rather than no packages.
 */
function yamlList(lines: string[], top: YamlTop, key: string): string[] | null {
  const found = yamlKey(top, key);
  if (!found) return [];
  const { at, rest } = found;
  if (rest.startsWith("[")) {
    const items = yamlFlow(rest, lines, at + 1);
    if (!items) return null;
    const out: string[] = [];
    for (const raw of items) {
      if (escaped(raw) || unsafePlain(raw.trim())) return null;
      const value = yamlScalar(raw);
      if (value) out.push(value);
    }
    return out;
  }
  if (rest) return null;
  const out: string[] = [];
  let indent = -1;
  for (const line of lines.slice(at + 1)) {
    if (blank(line)) continue;
    const t = line.trimStart();
    // Every item at the indent of the first: YAML reads a line indented further as more of the item above.
    const depth = line.length - t.length;
    if (indent === -1) indent = depth;
    if (depth !== indent && (depth > indent || isBlank(line[0]))) return null;
    if (t[0] !== "-" || (t.length > 1 && !isBlank(t[1]))) {
      if (isBlank(line[0])) return null; // more of the value, in a form this does not read
      break;
    }
    const raw = t.slice(1).trim();
    const value = yamlScalar(raw);
    if (!value || escaped(raw) || unsafePlain(raw)) return null;
    out.push(value);
  }
  return out;
}

/**
 * The "name: value" entries of a mapping under a key at the top of a YAML file, as a block or a flow map. {} when the key
 * is not there, null when its value or an entry is in a form this does not read, so that it is a gap rather than nothing.
 */
function yamlMap(lines: string[], top: YamlTop, key: string): Record<string, string> | null {
  const found = yamlKey(top, key);
  const out: Record<string, string> = {};
  const set = ([name, value]: [string, string]) => Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  if (!found) return out;
  if (found.rest) {
    const items = found.rest.startsWith("{") ? yamlFlow(found.rest, lines, found.at + 1) : null;
    if (!items) return null;
    for (const item of items) {
      const pair = yamlPair(item);
      if (!pair) return null;
      set(pair);
    }
    return out;
  }
  let indent = -1;
  for (const line of lines.slice(found.at + 1)) {
    if (blank(line)) continue;
    // A block list at the left edge is this key's value too, and a list is not a map.
    if (line[0] === "-" && (line.length === 1 || isBlank(line[1]))) return null;
    if (!isBlank(line[0])) break;
    // Every entry at the indent of the first: YAML reads a line indented further as more of the entry above.
    const depth = line.length - line.trimStart().length;
    if (indent === -1) indent = depth;
    if (depth !== indent) return null;
    const pair = yamlPair(line);
    if (!pair) return null;
    set(pair);
  }
  return out;
}

/**
 * The named catalogs of pnpm-workspace.yaml ("catalogs:" with one map of "name: version" per catalog, as a block or a flow
 * map), each as a map. [] when the key is not there, null when it is in a form this does not read.
 */
function yamlCatalogs(lines: string[], top: YamlTop): Array<Record<string, string>> | null {
  const found = yamlKey(top, "catalogs");
  if (!found) return [];
  if (found.rest) return null;
  const out: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  let indent = -1;
  const set = (map: Record<string, string>, [name, value]: [string, string]) => Object.defineProperty(map, name, { value, enumerable: true, writable: true, configurable: true });
  for (let i = found.at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (blank(line)) continue;
    if (line[0] === "-" && (line.length === 1 || isBlank(line[1]))) return null;
    if (!isBlank(line[0])) break;
    const depth = line.length - line.trimStart().length;
    if (indent === -1) indent = depth;
    if (depth < indent) return null;
    if (depth > indent) {
      // An entry of the catalog above.
      const pair = current && yamlPair(line);
      if (!current || !pair) return null;
      set(current, pair);
      continue;
    }
    const key = yamlKeyOf(line.trim());
    if (!key) return null;
    const rest = yamlScalar(key.after);
    current = {};
    out.push(current);
    if (!rest) continue;
    if (!rest.startsWith("{")) return null;
    const items = yamlFlow(key.after.trim(), lines, i + 1);
    if (!items) return null;
    for (const item of items) {
      const pair = yamlPair(item);
      if (!pair) return null;
      set(current, pair);
    }
    const end = flowEnd(key.after.trim(), lines, i + 1);
    if (end === -1) return null;
    i = end;
    current = null; // no block entries after a flow map
  }
  return out;
}
