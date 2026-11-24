import { assignModules, checkArchitecture } from "./check.js";
import type { Architecture, InferResult, ProjectGraph } from "./types.js";

const GROUP_DIRS = new Set(["features", "modules", "domains", "packages", "apps", "services"]);
/** Folders that hold tests, demos or tooling rather than application architecture. */
const NOT_MODULES = new Set([
  "test", "tests", "__tests__", "test_dts", "e2e", "spec", "specs", "playground", "playgrounds",
  "docs", "doc", "scripts", "examples", "example", "fixtures", "benchmark", "benchmarks", "bench", "tools", "stories",
]);
const PIN_TOP =new Set(["app", "pages", "routes", "views", "screens", "cli", "bin", "main", "ui"]);
const PIN_BOTTOM = new Set(["shared", "utils", "util", "lib", "libs", "common", "types", "constants", "config"]);

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "module";
}

function pickSourceRoot(files: string[]): string {
  // Prefer src/ whenever it holds at least two sub folders of code, even if tests or
  // scripts elsewhere outnumber it. Those other folders are intentionally not modules.
  const subs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    if (parts[0] === "src" && parts.length >= 3) subs.add(parts[1]);
  }
  return subs.size >= 2 ? "src" : "";
}

function rank(name: string): number {
  if (PIN_TOP.has(name)) return 0;
  if (PIN_BOTTOM.has(name)) return 2;
  return 1;
}

/** Order modules top to bottom: importers first. Breaks cycles by fewest importers. */
export function orderLayers(names: string[], edgeWeights: Map<string, number>): string[] {
  const remaining = new Set(names);
  const importersOf = (m: string): number => {
    let n = 0;
    for (const o of remaining) if (o !== m && (edgeWeights.get(`${o}>${m}`) ?? 0) > 0) n++;
    return n;
  };
  const out: string[] = [];
  while (remaining.size) {
    const scored = [...remaining].map((m) => ({ m, n: importersOf(m) }));
    const min = Math.min(...scored.map((s) => s.n));
    const tier = scored
      .filter((s) => s.n === min)
      .map((s) => s.m)
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    // Take one at a time when breaking a cycle, the whole tier when it is a clean layer.
    const take = min === 0 ? tier : [tier[0]];
    for (const m of take) {
      out.push(m);
      remaining.delete(m);
    }
  }
  return out;
}

export function inferArchitecture(graph: ProjectGraph): InferResult {
  const notes: string[] = [];
  const srcRoot = pickSourceRoot(graph.files);
  const prefix = srcRoot ? `${srcRoot}/` : "";

  // Count files per candidate folder.
  const counts = new Map<string, number>();
  for (const f of graph.files) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const parts = rest.split("/");
    if (parts.length < 2) continue;
    const top = parts[0];
    if (!srcRoot && NOT_MODULES.has(top.toLowerCase())) continue;
    if (GROUP_DIRS.has(top) && parts.length >= 3) {
      const key = `${top}/${parts[1]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } else {
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
  }

  // Collapse group dirs with a single child back to the group.
  const groupChildren = new Map<string, string[]>();
  for (const key of counts.keys()) {
    const [top, sub] = key.split("/");
    if (sub) groupChildren.set(top, [...(groupChildren.get(top) ?? []), key]);
  }
  for (const [top, kids] of groupChildren) {
    if (kids.length < 2) {
      const total = kids.reduce((n, k) => n + (counts.get(k) ?? 0), 0);
      for (const k of kids) counts.delete(k);
      counts.set(top, total);
    }
  }

  const modules: Architecture["modules"] = {};
  const nameOf = new Map<string, string>();
  for (const key of [...counts.keys()].sort()) {
    const base = sanitize(key.includes("/") ? key.split("/")[1] : key);
    let name = base;
    if (modules[name]) name = sanitize(key);
    modules[name] = { paths: [`${prefix}${key}/**`], description: `Files under ${prefix}${key}/` };
    nameOf.set(key, name);
  }

  if (Object.keys(modules).length === 0) {
    notes.push("No folders with source files were found, so no modules could be proposed.");
  } else if (Object.keys(modules).length === 1) {
    notes.push("Only one module was found, so there is no layer structure to enforce yet. The code looks flat. Define modules by hand in voxium/architecture.json.");
  }

  const draft: Architecture = {
    version: 1,
    modules,
    layers: Object.keys(modules),
    rules: [],
    exceptions: [],
  };

  // Module edges from the import graph.
  const modOf = assignModules(draft, graph.files);
  const weights = new Map<string, number>();
  for (const e of graph.edges) {
    if (!e.to) continue;
    const a = modOf.get(e.from);
    const b = modOf.get(e.to);
    if (!a || !b || a === b) continue;
    weights.set(`${a}>${b}`, (weights.get(`${a}>${b}`) ?? 0) + 1);
  }

  const layers = orderLayers(Object.keys(modules), weights);
  draft.layers = layers;
  const pos = new Map(layers.map((m, i) => [m, i]));

  let total = 0;
  let consistent = 0;
  for (const [k, w] of weights) {
    const [a, b] = k.split(">");
    total += w;
    if ((pos.get(a) ?? 0) <= (pos.get(b) ?? 0)) consistent += w;
  }
  const confidence = total === 0 ? (Object.keys(modules).length ? 0.5 : 0) : consistent / total;

  draft.rules = [
    {
      id: "LAYER01",
      type: "layers",
      severity: "block",
      description: `Modules may only import from their own module or from modules lower in the layer order: ${layers.join(" > ")}.`,
      rationale: "A fixed dependency direction keeps lower layers reusable and stops circular knowledge between areas of the app.",
    },
    {
      id: "CYCLE01",
      type: "no_cycles",
      severity: "block",
      description: "Modules must not depend on each other in a cycle.",
      rationale: "Cycles make modules impossible to change, test or extract on their own.",
    },
    {
      id: "SIZE01",
      type: "max_file_lines",
      max: 600,
      severity: "warn",
      description: "Source files should stay under 600 lines.",
      rationale: "Very large files usually mix responsibilities and are hard for humans and agents to change safely.",
    },
  ];

  const result = checkArchitecture(draft, graph);
  const existing = result.violations.filter((v) => v.severity === "block");
  if (existing.length) {
    notes.push(
      `${existing.length} existing blocking violation(s) were found in the current code. Voxium init records them as a baseline so CI starts green.`,
    );
  }
  if (confidence < 0.8 && total > 0) {
    notes.push("Layer order is a weak fit for the current imports. Review the order before enforcing it.");
  }
  if (layers.length > 2) {
    notes.push(
      "Modules with no imports between them are ordered arbitrarily. If you expect one to depend on another later, check that it sits above it in the layer order.",
    );
  }
  const unassigned = graph.files.length - modOf.size;
  if (unassigned > 0) {
    notes.push(`${unassigned} file(s) sit outside any module (for example root level files) and are not checked.`);
  }

  return { architecture: draft, confidence, notes, existingViolations: existing.length };
}
