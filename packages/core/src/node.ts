/**
 * Node only helpers: reading a project from disk and loading or saving Voxium files.
 * Import from "@voxium/core/node". The main entry point stays free of node:* imports
 * so it can run in Cloudflare Workers.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildGraphFromFiles, expandSymlinks, IGNORE_DIRS, isSourcePath, type BuildGraphOptions, type FileMap } from "./graph.js";
import { ARCH_FILE_PATH, BASELINE_FILE_PATH, PROTECTED_FILES, parseBaseline, type ProtectedContents } from "./protect.js";
import { validateArchitecture } from "./schema.js";
import type { Architecture, ProjectGraph } from "./types.js";

export const ARCH_FILE = ARCH_FILE_PATH;
export const BASELINE_FILE = BASELINE_FILE_PATH;

function walk(root: string, dir: string, acc: FileMap): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(root, abs, acc);
    } else if (entry.isFile()) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (isSourcePath(rel)) acc[rel] = fs.readFileSync(abs, "utf8");
    }
  }
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
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
 * Source files by path. In a git repo, git decides what counts: everything that is or could be committed,
 * which is what CI and the platform see. Elsewhere, fall back to skipping well known output folders.
 */
export function readProjectFiles(root: string): FileMap {
  const abs = path.resolve(root);
  const files: FileMap = {};
  const links: Record<string, string> = {};
  collect(abs, abs, files, links);
  return expandSymlinks(files, links);
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

function collect(root: string, dir: string, files: FileMap, links: Record<string, string>): void {
  const listed = gitPaths(dir);
  if (!listed) {
    walk(root, dir, files);
    return;
  }
  for (const entry of listed) {
    const p = path.join(dir, entry);
    const rel = posixRelative(root, p);
    const stat = lstat(p);
    if (stat?.isDirectory()) {
      // Git lists a submodule or nested repo as one entry. Look inside, with its own git when it has one.
      if (fs.existsSync(path.join(p, ".git"))) collect(root, p, files, links);
      else walk(root, p, files);
    } else if (stat?.isSymbolicLink()) {
      const target = path.resolve(path.dirname(p), fs.readlinkSync(p));
      const to = posixRelative(root, target);
      if (to && !to.startsWith("..") && !path.isAbsolute(to)) links[rel] = to;
    } else if (stat?.isFile() && isSourcePath(rel)) {
      files[rel] = fs.readFileSync(p, "utf8");
    }
  }
}

/** Contents of the protected files at a git ref. Throws when the ref itself cannot be read. */
export function readProtectedAtRef(root: string, ref: string): ProtectedContents {
  let sha: string;
  try {
    sha = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).trim();
  } catch {
    throw new Error(`Cannot read rules from "${ref}": no such commit. In CI, check out with full history (fetch-depth: 0).`);
  }
  const out: ProtectedContents = {};
  for (const rel of PROTECTED_FILES) {
    const exists = git(root, ["ls-tree", "--name-only", sha, "--", rel]).trim() !== "";
    out[rel] = exists ? git(root, ["show", `${sha}:./${rel}`]) : null;
  }
  return out;
}

export function readProtected(root: string): ProtectedContents {
  return Object.fromEntries(PROTECTED_FILES.map((rel) => [rel, readIfExists(root, rel) ?? null]));
}

export function buildGraph(root: string, opts: BuildGraphOptions = {}): ProjectGraph {
  const abs = path.resolve(root);
  return buildGraphFromFiles(readProjectFiles(abs), opts, abs);
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
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
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

export function writeText(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
