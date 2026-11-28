import { expandImports, newBudget } from "./expand.js";
import { MAX_OPAQUE, scanFile, type ImportScan, type ManyImports } from "./imports.js";
import { ADDED_EXT, dirname, fileAt, isConfigPath, loadsFolder, namesFolder, nodeLoads, normalize, packageNameOf, RESOLVE_EXT, Resolver } from "./resolve.js";
import type { ImportEdge, OpaqueUse, ProjectGraph, UnparsedFile } from "./types.js";

/** Repo relative posix path to file contents. This is the only input the core needs. */
export type FileMap = Record<string, string>;

export const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue"];
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
  ".yarn",
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

/**
 * Make symlinks visible to the import graph. A link to a source file becomes a file that re-exports it, and a
 * link to a folder becomes one such file per source file inside. A link to a config file has its contents. Links are
 * path to repo relative target.
 */
export function expandSymlinks(files: FileMap, links: Record<string, string>): FileMap {
  const out: FileMap = { ...files };
  const reexport = (from: string, to: string) => {
    if (Object.hasOwn(files, from)) return;
    if (isConfigPath(from) && isConfigPath(to)) out[from] = files[to];
    if (!isSourcePath(from) || !isSourcePath(to)) return;
    const up = "../".repeat(from.split("/").length - 1) || "./";
    out[from] = `export * from ${JSON.stringify(up + to)};\n`;
  };
  for (const [link, first] of Object.entries(links)) {
    let target = first;
    for (let hops = 0; hops < 40 && Object.hasOwn(links, target); hops++) target = links[target]; // a link to a link
    if (Object.hasOwn(files, target)) reexport(link, target);
    else for (const f of Object.keys(files)) if (f.startsWith(`${target}/`)) reexport(link + f.slice(target.length), f);
  }
  return out;
}

/** The package a module name is in, without a query such as "?raw". A builtin of Node is the same with "node:" in front or not. */
function packageName(spec: string): string | undefined {
  const name = spec.replace(/\?.*$/s, "");
  return packageNameOf(name.startsWith("node:") ? name.slice(5) : name) || undefined;
}

function isAlias(spec: string): boolean {
  return spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("#/");
}

/** The paths that a relative or alias import may stand for, or null when it is a package. */
function basePaths(fromFile: string, spec: string, aliasRoots: string[]): string[] | null {
  if (spec.startsWith(".")) {
    const d = dirname(fromFile);
    return [normalize(d ? `${d}/${spec}` : spec)];
  }
  if (!isAlias(spec)) return null;
  const rest = spec.slice(2);
  return aliasRoots.map((r) => normalize(r ? `${r}/${rest}` : rest));
}

/** A relative module name as it is written, and as what a URL makes of it. */
function readings(spec: string): string[] {
  const path = spec.replace(/[\t\n\r]/g, "").replace(/\\/g, "/").replace(/[?#].*$/s, "").replace(/[\0- ]+$/, "");
  const decoded = path.replace(/(?:%[\da-f]{2})+/gi, (codes) => {
    try {
      return decodeURIComponent(codes);
    } catch {
      return codes;
    }
  });
  return [...new Set([spec, path, decoded])];
}

/** Names of files by where they are on the disk, which is not known here, or of code that is in the name itself. */
const ELSEWHERE = /^(?:(?:file|data|blob):|[a-z]:[\\/]|\/(?!\/))/i;

/** Whether a path has the ending of something else than code. */
function isAsset(spec: string): boolean {
  const ext = /\.[a-z\d]+$/i.exec(spec.replace(/[?#].*$/s, ""))?.[0];
  return ext !== undefined && !RESOLVE_EXT.includes(ext.toLowerCase());
}

/** The files that a name may stand for. Nearly always one, or none when it is a package or not there. */
function resolveInternal(fileSet: Set<string>, fromFile: string, spec: string, aliasRoots: string[]): string[] {
  const found = new Set<string>();
  for (const name of readings(spec)) {
    // Some tools take "/" for the root of the project.
    const bases = /^\/(?!\/)/.test(name) ? [normalize(name)] : (basePaths(fromFile, name, aliasRoots) ?? []);
    const file = fileAt(fileSet, bases, namesFolder(name));
    if (file) found.add(file);
  }
  return [...found];
}

/**
 * Endings of files that tools take for data or assets, not for code. Node runs any other file that require() names as
 * JavaScript, whatever its ending, and with type stripping runs a .d.ts file too.
 */
const DATA_EXT = new Set(
  ("json json5 jsonc css scss sass less styl stylus pcss postcss sss svg png jpg jpeg gif webp avif ico bmp tif tiff apng jxl heic woff woff2 ttf otf eot " +
    "mp4 webm ogg ogv mp3 wav flac aac m4a mov avi pdf wasm html htm md mdx yaml yml toml graphql gql csv xml glsl frag vert wgsl").split(" "),
);
/** Queries with which bundlers load a file as text or as a URL, never as code. */
const AS_DATA = /\?(?:raw|url|inline)(?:&|$)/;

/** Whether a file of the tree that is not a source file would still be run as code, when it is loaded. */
function runsAsCode(path: string): boolean {
  if (isSourcePath(path)) return false;
  const file = path.slice(path.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot <= 0 || !DATA_EXT.has(file.slice(dot + 1).toLowerCase());
}

/**
 * Whether a relative or alias name that leads to no source file leads to a file of the tree that would still be run as
 * code: by its name, with an ending added, or as the index of a folder, as in a committed node_modules folder.
 */
function namesHiddenCode(paths: Set<string>, hidden: (p: string) => boolean, fromFile: string, spec: string, aliasRoots: string[]): boolean {
  if (AS_DATA.test(spec)) return false;
  for (const name of readings(spec)) {
    for (const base of basePaths(fromFile, name, aliasRoots) ?? []) {
      const tries = !base ? ["index"] : namesFolder(name) ? [`${base}/index`] : [base, `${base}/index`];
      for (const b of tries) for (const ext of ADDED_EXT) if (paths.has(b + ext) && hidden(b + ext)) return true;
    }
  }
  return false;
}

/** The folders of committed packages in node_modules folders of the tree, and files directly in them without their ending. */
function committedPackages(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] !== "node_modules") continue;
      const end = Math.min(parts.length, i + (parts[i + 1].startsWith("@") ? 3 : 2));
      const name = parts.slice(0, end).join("/");
      out.add(end === parts.length ? name.replace(/\.[^./]+$/, "") : name);
    }
  }
  return out;
}

function describeMany(many: ManyImports): string {
  if (many.type === "template") return many.parts.join("${...}");
  return many.type === "glob" ? many.patterns.map((p) => p ?? "...").join(", ").slice(0, 200) : many.dir;
}

export interface BuildGraphOptions {
  /** Alias roots for "@/" and "~/" style imports, repo relative. Defaults to src then root. */
  aliasRoots?: string[];
  /**
   * Every file path of the tree, source or not. With it, an import of a file that is not a source file, such as
   * require('./x.txt'), './x' without an ending or './x.d.ts', is opaque unless the file is data or an asset.
   */
  paths?: Iterable<string>;
  /** Where each symlink of the tree leads in the tree, also those within a linked folder. A link is judged by its target. */
  links?: Record<string, string>;
  /** Trusted aliases, from the architecture of the base branch. They add to what config files say. */
  aliases?: Record<string, string[]>;
  /**
   * The config files (package.json, tsconfig and the like) of the trusted commit a change started from, such as where a
   * pull request branched off. Names resolve with these as well as with the config files at hand, so a change that edits
   * or removes a mapping still has the imports it stood for seen. Other files in the map are not used.
   */
  configBefore?: FileMap;
  /**
   * What reading each file found, kept between builds: a file whose contents are the same as last time is not read
   * again, as when a pull request and the commit it branched off are both built. Only the contents decide, never the
   * other options, since reading a file does not depend on them.
   */
  scans?: ScanCache;
}

/** What reading a file found, by path, with the contents it was found in. */
export type ScanCache = Map<string, { raw: string; scan: ImportScan }>;

/**
 * Build the import graph from in memory files. Pure: no filesystem, no network. Config files in the map (package.json,
 * tsconfig and the like) say what names that are not relative stand for. They are not nodes of the graph.
 */
export function buildGraphFromFiles(input: FileMap, opts: BuildGraphOptions = {}, rootLabel = "."): ProjectGraph {
  const files = Object.keys(input).filter(isSourcePath).sort();
  const fileSet = new Set(files);
  const hasSrc = files.some((f) => f.startsWith("src/"));
  const aliasRoots = opts.aliasRoots ?? (hasSrc ? ["src", ""] : [""]);

  const edges: ImportEdge[] = [];
  const lines: Record<string, number> = {};
  const opaque: OpaqueUse[] = [];
  const unparsed: UnparsedFile[] = [];
  const budget = newBudget();
  const paths = opts.paths ? new Set(opts.paths) : null;
  const links = opts.links ?? {};
  const exists = (p: string) => fileSet.has(p) || (paths ? paths.has(p) : Object.hasOwn(input, p));
  /**
   * Whether loading a path runs code that is not read as a source file there. A symlink is judged by what it leads to, so
   * a link named like data that leads to code is code, and a link without an ending that leads to data is data.
   */
  const hiddenCode = (p: string): boolean => {
    if (fileSet.has(p)) return false;
    const target = Object.hasOwn(links, p) ? links[p] : p;
    return isSourcePath(target) || runsAsCode(target);
  };
  const resolver = new Resolver({ files: input, fileSet, paths, aliases: opts.aliases, hidden: paths ? hiddenCode : undefined, before: opts.configBefore });
  /** The files that are not source files but would be run as code, sorted, which a name with unknown parts may also match. */
  let hidden: string[] | undefined;
  let committed: Set<string> | undefined;
  let unresolved = 0;
  /** Each package.json of a folder that a relative import loads, and that cannot be read. */
  const manifests = new Set<string>();

  for (const file of files) {
    const raw = input[file];
    lines[file] = raw.split("\n").length;
    const kept = opts.scans?.get(file);
    const scan = kept && kept.raw === raw ? kept.scan : scanFile(file, raw);
    if (opts.scans && kept?.scan !== scan) opts.scans.set(file, { raw, scan });
    if (scan.unparsed !== undefined) {
      // What was found up to there may not be what the code says, so it counts for nothing, like a file that is missing.
      unparsed.push({ file, reason: scan.unparsed });
      continue;
    }
    const targets = new Set<string>();
    const uses: OpaqueUse[] = scan.opaque.map((o) => ({ file, ...o }));
    const opaqueImport = (line: number) => uses.length < MAX_OPAQUE && uses.push({ file, line, kind: "import" });
    for (const { specifier: spec, line } of scan.imports) {
      const found = new Set(resolveInternal(fileSet, file, spec, aliasRoots));
      const local = spec.startsWith(".") || isAlias(spec);
      // Node loads the file of that very name first, then tries endings, then a folder's package.json. Bundlers differ, so both count.
      let runs = false;
      let reached = false;
      if (local) {
        for (const name of readings(spec)) {
          // A name that ends with "/", "." or ".." is a folder only, whatever file of that name there is.
          const folder = namesFolder(name);
          for (const base of basePaths(file, name, aliasRoots) ?? []) {
            for (const main of resolver.mains(base)) {
              const loaded = nodeLoads(base, exists, () => main, folder);
              reached ||= loaded !== undefined;
              if (loaded && fileSet.has(loaded)) found.add(loaded);
              else if (loaded && paths && !AS_DATA.test(spec) && hiddenCode(loaded)) runs = true;
            }
            // Node reads the folder's package.json before its index. When that is in the tree but was not read (as in a
            // committed node_modules folder), or cannot be read, its "main" may name anything, whatever index is there.
            const manifest = base ? `${base}/package.json` : "package.json";
            if (!AS_DATA.test(spec) && loadsFolder(base, exists, folder) && (paths ? paths.has(manifest) : Object.hasOwn(input, manifest)) && !resolver.knows(manifest)) {
              runs = true;
              manifests.add(manifest);
            }
          }
        }
      }
      const config = ELSEWHERE.test(spec) || spec.startsWith(".") ? null : resolver.resolve(file, spec);
      for (const to of config?.files ?? []) found.add(to);
      if (config?.runs && !AS_DATA.test(spec)) runs = true;
      for (const to of found) {
        targets.add(to);
        if (to !== file) edges.push({ from: file, to, specifier: spec, line });
      }
      if (runs) opaqueImport(line);
      if (local) {
        // Internal style but unresolved: nothing there, or a file that is not read.
        if (found.size || runs) continue;
        if (paths && namesHiddenCode(paths, hiddenCode, file, spec, aliasRoots)) opaqueImport(line);
        else if (!reached && !isAsset(spec) && !AS_DATA.test(spec)) unresolved++;
        continue;
      }
      if (ELSEWHERE.test(spec)) {
        if (!found.size && !isAsset(spec)) opaqueImport(line);
        continue;
      }
      if (config?.matched && !config.files.length && !config.packages.length && !config.runs) unresolved++;
      // A bare name keeps its package edge, so rules about packages still see it, whatever else it stands for.
      const pkg = packageName(spec);
      for (const name of new Set([pkg, ...(config?.packages ?? [])])) if (name) edges.push({ from: file, pkg: name, specifier: spec, line });
      if (pkg && paths && !spec.startsWith("node:")) {
        // Node finds a package in the node_modules folder of any folder above, which may be committed.
        committed ??= committedPackages(paths);
        for (let dir = dirname(file); ; dir = dirname(dir)) {
          if (committed.has(dir ? `${dir}/node_modules/${pkg}` : `node_modules/${pkg}`)) {
            opaqueImport(line);
            break;
          }
          if (!dir) break;
        }
      }
    }

    for (const many of scan.many) {
      const found = expandImports(many, {
        files,
        from: file,
        bases: (spec) => basePaths(file, spec, aliasRoots)?.map((b) => (b ? `${b}/` : "")) ?? null,
        budget,
      });
      const specifier = describeMany(many);
      const { line } = many;
      for (const to of found.targets) {
        if (targets.has(to)) continue;
        targets.add(to);
        edges.push({ from: file, to, specifier, line });
      }
      for (const name of found.packages) {
        const pkg = packageName(name);
        if (pkg) edges.push({ from: file, pkg, specifier, line });
      }
      let partial = found.partial;
      if (paths && !partial && (many.type === "context" || (many.type === "template" && !AS_DATA.test(many.parts.join(""))))) {
        // Also in a node_modules folder that is committed, which Node loads from as from any other.
        hidden ??= [...paths].filter((p) => hiddenCode(p) && !p.split("/").includes(".git")).sort();
        if (hidden.length) partial = expandImports(many, { files: hidden, from: file, bases: (spec) => basePaths(file, spec, aliasRoots)?.map((b) => (b ? `${b}/` : "")) ?? null, budget }).targets.length > 0;
      }
      if (partial && uses.length < MAX_OPAQUE) uses.push({ file, line, kind: many.type === "template" ? many.kind : "glob" });
    }
    opaque.push(...uses.sort((a, b) => a.line - b.line));
  }

  // A config file that cannot be read could change what any code below it imports.
  unparsed.push(...resolver.problems(files, manifests));
  const aliases = resolver.rootAliases();
  const notes = resolver.noted();
  return { root: rootLabel, files, lines, edges, opaque, unparsed, unresolved, ...(Object.keys(aliases).length ? { aliases } : {}), ...(notes.length ? { notes } : {}) };
}
