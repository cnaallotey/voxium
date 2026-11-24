/**
 * Node only helpers: reading a project from disk and loading or saving Voxium files.
 * Import from "@voxium/core/node". The main entry point stays free of node:* imports
 * so it can run in Cloudflare Workers.
 */
import fs from "node:fs";
import path from "node:path";
import { buildGraphFromFiles, IGNORE_DIRS, isSourcePath, type BuildGraphOptions, type FileMap } from "./graph.js";
import { validateArchitecture } from "./schema.js";
import type { Architecture, ProjectGraph } from "./types.js";

export const DIR = "voxium";
export const ARCH_FILE = `${DIR}/architecture.json`;
export const BASELINE_FILE = `${DIR}/baseline.json`;

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

export function readProjectFiles(root: string): FileMap {
  const acc: FileMap = {};
  walk(path.resolve(root), path.resolve(root), acc);
  return acc;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    throw new Error(`${ARCH_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  const res = validateArchitecture(parsed);
  if (!res.ok) throw new Error(`${ARCH_FILE} is invalid:\n  ${res.errors.join("\n  ")}`);
  return parsed as Architecture;
}

export function writeJson(root: string, rel: string, data: unknown): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
}

export function loadBaseline(root: string): string[] {
  const p = path.join(root, BASELINE_FILE);
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(data.violations) ? data.violations : [];
  } catch {
    return [];
  }
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
