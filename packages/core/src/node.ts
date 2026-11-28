/**
 * Node only helpers: reading a project from disk and loading or saving Voxium files.
 * Import from "@voxium/core/node". The main entry point stays free of node:* imports
 * so it can run in Cloudflare Workers.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildGraphFromFiles, expandSymlinks, IGNORE_DIRS, isSourcePath, type BuildGraphOptions, type FileMap } from "./graph.js";
import { isConfigPath } from "./resolve.js";
import { ARCH_FILE_PATH, BASELINE_FILE_PATH, PROTECTED_FILES, parseBaseline, type ProtectedContents } from "./protect.js";
import { validateArchitecture } from "./schema.js";
import type { Proposal } from "./tools.js";
import type { Architecture, ProjectGraph } from "./types.js";

export const ARCH_FILE = ARCH_FILE_PATH;
export const BASELINE_FILE = BASELINE_FILE_PATH;

function walk(root: string, dir: string, acc: FileMap, links: Record<string, string>, paths: string[], outside: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(root, abs, acc, links, paths, outside);
    } else if (entry.isSymbolicLink()) {
      if (!IGNORE_DIRS.has(entry.name)) addLink(root, abs, links, paths, outside);
    } else if (entry.isFile()) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      paths.push(rel);
      if (wanted(rel)) acc[rel] = fs.readFileSync(abs, "utf8");
    }
  }
}

/** Source files, and the config files that say what their imports stand for. */
const wanted = (rel: string) => isSourcePath(rel) || isConfigPath(rel);

/** No fsmonitor command, which a repository's config could name, runs while Voxium reads it. */
const SAFE_GIT = ["-c", "core.fsmonitor=false"];

function git(root: string, args: string[]): string {
  return execFileSync("git", [...SAFE_GIT, ...args], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
}

/** Every tracked or not ignored path, or null when root is not inside a git work tree. */
function gitPaths(root: string): string[] | null {
  try {
    const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    const paths = [...new Set(out.split("\0").filter(Boolean))];
    return paths.length ? paths : null;
  } catch {
    return null;
  }
}

/**
 * Source and config files by path. In a git repo, git decides what counts: everything that is or could be committed,
 * which is what CI and the platform see. Elsewhere, fall back to skipping well known output folders.
 */
export function readProjectFiles(root: string): FileMap {
  return readProject(root).files;
}

/** What a tree is made of: its source and config files, the paths of all files, and where its symlinks lead. */
interface Tree {
  files: FileMap;
  paths: string[];
  links: Record<string, string>;
  /** Source paths that are symlinks leading out of the project or nowhere, whose contents are not known. */
  outside: string[];
}

/** The source files, and the paths of all files, source or not. */
function readProject(root: string): Tree {
  const abs = path.resolve(root);
  const files: FileMap = {};
  const links: Record<string, string> = {};
  const paths: string[] = [];
  const outside: string[] = [];
  collect(abs, abs, files, links, paths, outside);
  return { files: expandSymlinks(files, links), ...linkedPaths(paths, links), outside };
}

/**
 * A symlink, by the path that it points to in the tree. Its own path is a path of the tree, whatever it points to: Node
 * runs what require('./p.txt') names as code, also when it is a link.
 */
function addLink(root: string, p: string, links: Record<string, string>, paths: string[], outside: string[]): void {
  const rel = posixRelative(root, p);
  paths.push(rel);
  let to = "";
  try {
    to = posixRelative(root, path.resolve(path.dirname(p), fs.readlinkSync(p)));
  } catch {
    // unreadable link
  }
  if (to && !to.startsWith("..") && !path.isAbsolute(to)) links[rel] = to;
  else if (isSourcePath(rel)) outside.push(rel);
}

/**
 * The graph with the source paths that are symlinks leading out of the project as files that could not be read, as the
 * platform counts them: what they import is not known, so a check that skipped them would prove nothing.
 */
function withOutside(graph: ProjectGraph, outside: string[]): ProjectGraph {
  for (const file of outside) {
    if (!graph.files.includes(file)) graph.files.push(file);
    graph.unparsed.push({ file, reason: "is a symlink that leads outside the project, so what it holds is not known" });
  }
  return graph;
}

/** The graph of a tree read from disk or from git. */
export function graphOfTree(tree: Pick<Tree, "files" | "paths" | "links" | "outside">, opts: BuildGraphOptions = {}, root?: string): ProjectGraph {
  return withOutside(buildGraphFromFiles(tree.files, { paths: tree.paths, links: tree.links, ...opts }, root), tree.outside);
}

/**
 * The paths of the tree, along with those that a symlink to a folder leads to through it, and the file of the tree that
 * each of those links stands for.
 */
function linkedPaths(paths: string[], links: Record<string, string>): { paths: string[]; links: Record<string, string> } {
  const out = new Set(paths);
  const targets: Record<string, string> = {};
  const sorted = [...paths].sort();
  for (const [link, first] of Object.entries(links)) {
    let target = first;
    for (let hops = 0; hops < 40 && Object.hasOwn(links, target); hops++) target = links[target]; // a link to a link
    if (!Object.hasOwn(links, target) && out.has(target)) targets[link] = target;
    let i = lowerBound(sorted, `${target}/`);
    for (; i < sorted.length && sorted[i].startsWith(`${target}/`); i++) {
      out.add(link + sorted[i].slice(target.length));
      targets[link + sorted[i].slice(target.length)] = sorted[i];
    }
  }
  return { paths: [...out], links: targets };
}

function lowerBound(sorted: string[], key: string): number {
  let lo = 0;
  for (let hi = sorted.length; lo < hi; ) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function posixRelative(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join("/");
}

function lstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null; // deleted in the work tree, or a parent is now a file
  }
}

function collect(root: string, dir: string, files: FileMap, links: Record<string, string>, paths: string[], outside: string[]): void {
  const listed = gitPaths(dir);
  if (!listed) {
    walk(root, dir, files, links, paths, outside);
    return;
  }
  for (const entry of listed) {
    const p = path.join(dir, entry);
    const rel = posixRelative(root, p);
    const stat = lstat(p);
    if (stat?.isDirectory()) {
      // Git lists a submodule or nested repo as one entry. Look inside, with its own git when it has one.
      if (fs.existsSync(path.join(p, ".git"))) collect(root, p, files, links, paths, outside);
      else walk(root, p, files, links, paths, outside);
    } else if (stat?.isSymbolicLink()) {
      addLink(root, p, links, paths, outside);
    } else if (stat?.isFile()) {
      paths.push(rel);
      if (wanted(rel)) files[rel] = fs.readFileSync(p, "utf8");
    }
  }
}

/** The commit a ref names, or null when there is none, as before the first commit. */
export function commitOf(root: string, ref: string): string | null {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Contents of the protected files at a git ref, or of other files given. Throws when the ref itself cannot be read.
 */
export function readProtectedAtRef(root: string, ref: string, files: readonly string[] = PROTECTED_FILES): ProtectedContents {
  const sha = commitOf(root, ref);
  if (!sha) throw new Error(`Cannot read rules from "${ref}": no such commit. In CI, check out with full history (fetch-depth: 0).`);
  const out: ProtectedContents = {};
  for (const rel of files) {
    const exists = git(root, ["ls-tree", "--name-only", sha, "--", rel]).trim() !== "";
    out[rel] = exists ? git(root, ["show", `${sha}:./${rel}`]) : null;
  }
  return out;
}

/** Where HEAD branched off from a ref, or the ref itself when git cannot tell, as in a shallow clone. */
export function mergeBaseOf(root: string, ref: string): string {
  try {
    return git(root, ["merge-base", "--end-of-options", ref, "HEAD"]).trim();
  } catch {
    const sha = commitOf(root, ref);
    if (!sha) throw new Error(`Cannot compare with "${ref}": no such commit.`);
    return sha;
  }
}

interface Blob {
  rel: string;
  link: boolean;
  id: string;
}

/** Source and config files in a commit, or those a filter wants, and the paths of all its files. Submodules are not looked into. */
function readFilesAtCommit(root: string, sha: string, want: (rel: string) => boolean = wanted): Tree {
  const blobs: Blob[] = [];
  const paths: string[] = [];
  for (const entry of git(root, ["ls-tree", "-r", "-z", sha]).split("\0")) {
    const m = /^(\d+) blob (\S+)\t([^]+)$/.exec(entry);
    if (m) paths.push(m[3]);
    if (m && (m[1] === "120000" || want(m[3]))) blobs.push({ rel: m[3], link: m[1] === "120000", id: m[2] });
  }
  return readBlobs(root, blobs, paths);
}

/**
 * What git has staged: the source and config files, the paths of all files, and the contents of `extra` paths (null
 * when not staged). This is what a commit would hold, whatever the work tree has since. Works before the first commit.
 */
export function readStaged(root: string, extra: readonly string[] = []): Tree & { extra: ProtectedContents } {
  const blobs: Blob[] = [];
  const paths: string[] = [];
  const more: Blob[] = [];
  for (const entry of git(root, ["ls-files", "-s", "-z"]).split("\0")) {
    if (!entry) continue;
    const m = /^(\d+) (\S+) (\d)\t([^]+)$/.exec(entry);
    if (!m) throw new Error("git ls-files printed what Voxium cannot read.");
    if (m[3] !== "0") throw new Error("The index has merge conflicts. Resolve them, then check again.");
    if (m[1] === "160000") continue; // a submodule
    paths.push(m[4]);
    const blob = { rel: m[4], link: m[1] === "120000", id: m[2] };
    if (blob.link || wanted(blob.rel)) blobs.push(blob);
    if (!blob.link && extra.includes(blob.rel)) more.push(blob);
  }
  const tree = readBlobs(root, blobs, paths);
  const texts = readBlobs(root, more, []).files;
  return { ...tree, extra: Object.fromEntries(extra.map((p) => [p, Object.hasOwn(texts, p) ? texts[p] : null])) };
}

/**
 * Paths that differ between the work tree and where HEAD branched off from a ref, untracked ones included. Renames
 * count as both paths.
 */
export function changedSince(root: string, ref: string): string[] {
  const sha = mergeBaseOf(root, ref);
  const diff = git(root, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", sha, "--"]);
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  return [...new Set(`${diff}\0${untracked}`.split("\0").filter(Boolean))].sort();
}

/** The blobs read at once, as files or, for symlinks, as where they lead. */
function readBlobs(root: string, blobs: Blob[], paths: string[]): Tree {
  const files: FileMap = {};
  const links: Record<string, string> = {};
  const outside: string[] = [];
  if (!blobs.length) return { files, ...linkedPaths(paths, links), outside };
  const out = execFileSync("git", [...SAFE_GIT, "cat-file", "--batch"], {
    cwd: root,
    input: blobs.map((b) => `${b.id}\n`).join(""),
    maxBuffer: 1 << 29,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let at = 0;
  for (const b of blobs) {
    const end = out.indexOf(10, at);
    const [id, type, size] = out.toString("latin1", at, end).split(" ").map((x, i) => (i === 2 ? Number(x) : x)) as [string, string, number];
    if (id !== b.id || type !== "blob" || !Number.isInteger(size)) throw new Error("git cannot read the commit");
    const text = out.toString("utf8", end + 1, end + 1 + size);
    at = end + 1 + size + 1;
    if (b.link) {
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(b.rel), text));
      if (!to.startsWith("..") && !text.startsWith("/")) links[b.rel] = to;
      else if (isSourcePath(b.rel)) outside.push(b.rel);
    } else files[b.rel] = text;
  }
  return { files: expandSymlinks(files, links), ...linkedPaths(paths, links), outside };
}

/**
 * The project as it was before the change: where HEAD branched off from a ref, or HEAD itself, which leaves what is
 * not committed yet as the change. Null when git cannot tell.
 */
export function buildGraphBefore(root: string, ref?: string, opts: BuildGraphOptions = {}): ProjectGraph | null {
  try {
    const sha = ref === undefined ? git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) : git(root, ["merge-base", "--end-of-options", ref, "HEAD"]);
    return graphOfTree(readFilesAtCommit(root, sha.trim()), opts);
  } catch {
    return null;
  }
}

/**
 * The config files (package.json, tsconfig and the like) of the commit a change started from: where HEAD branched off
 * from a ref, or the ref itself when git cannot tell (as in a shallow clone), or HEAD without a ref. With them as
 * configBefore, a change cannot remove a mapping to hide an import. Throws when a ref is given and cannot be read; null
 * without a ref when there is no git.
 */
export function readConfigBefore(root: string, ref?: string): FileMap | null {
  let sha: string;
  if (ref === undefined) {
    try {
      sha = git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).trim();
    } catch {
      return null;
    }
  } else {
    try {
      sha = git(root, ["merge-base", "--end-of-options", ref, "HEAD"]).trim();
    } catch {
      sha = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).trim();
    }
  }
  return readFilesAtCommit(root, sha, isConfigPath).files;
}

export function readProtected(root: string): ProtectedContents {
  return Object.fromEntries(PROTECTED_FILES.map((rel) => [rel, readIfExists(root, rel) ?? null]));
}

export function buildGraph(root: string, opts: BuildGraphOptions = {}): ProjectGraph {
  const abs = path.resolve(root);
  return graphOfTree(readProject(abs), opts, abs);
}

export function loadArchitecture(root: string): Architecture {
  const p = path.join(root, ARCH_FILE);
  if (!fs.existsSync(p)) {
    throw new Error(`No ${ARCH_FILE} found in ${root}. Run "voxium init" first.`);
  }
  return parseArchitecture(fs.readFileSync(p, "utf8"));
}

export function parseArchitecture(text: string, label: string = ARCH_FILE): Architecture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${(err as Error).message}`);
  }
  const res = validateArchitecture(parsed);
  if (!res.ok) throw new Error(`${label} is invalid:\n  ${res.errors.join("\n  ")}`);
  return parsed as Architecture;
}

export function writeJson(root: string, rel: string, data: unknown): void {
  writeText(root, rel, `${JSON.stringify(data, null, 2)}\n`);
}

export function loadBaseline(root: string): string[] {
  return parseBaseline(readIfExists(root, BASELINE_FILE)) ?? [];
}

export function saveBaseline(root: string, ids: string[]): void {
  writeJson(root, BASELINE_FILE, { violations: [...new Set(ids)].sort() });
}

export function readIfExists(root: string, rel: string): string | undefined {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
}

/** Write a file of the project. A symlink that leads out of the project, or nowhere, is refused, so nothing is written outside it. */
export function writeText(root: string, rel: string, content: string): void {
  const base = fs.realpathSync(root);
  const p = path.resolve(base, rel);
  const inside = (q: string) => q === base || q.startsWith(base + path.sep);
  // The deepest part of the path that is there, followed through every symlink, decides where the file goes.
  let at = p;
  while (inside(at) && at !== base && !lstat(at)) at = path.dirname(at);
  let real: string | null = null;
  try {
    real = fs.realpathSync(at);
  } catch {
    // a symlink that leads nowhere
  }
  if (!inside(p) || !real || !inside(real)) throw new Error(`${rel} leads outside the project, through a symlink. Nothing was written there.`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export const PROPOSALS_DIR = "voxium/proposals";

/**
 * Save a proposal under voxium/proposals without replacing one that is there: a taken name gets a number. The folders
 * must be real ones inside the project, so a symlink cannot send the file elsewhere. Returns the path and the id it got.
 */
export function saveProposal(root: string, proposal: Proposal): { path: string; id: string } {
  let dir = root;
  for (const part of PROPOSALS_DIR.split("/")) {
    dir = path.join(dir, part);
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat) fs.mkdirSync(dir);
    else if (!stat.isDirectory()) throw new Error(`${path.relative(root, dir)} must be a folder, not a link or a file.`);
  }
  for (let n = 1; n <= 100; n++) {
    const id = n === 1 ? proposal.id : `${proposal.id}_${n}`;
    const rel = `${PROPOSALS_DIR}/${id}.json`;
    try {
      fs.writeFileSync(path.join(root, rel), `${JSON.stringify({ ...proposal, id }, null, 2)}\n`, { flag: "wx" });
      return { path: rel, id };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("There are too many proposals with this title today.");
}
