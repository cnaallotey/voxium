import { assignModules, checkArchitecture, graphNodes, moduleDependencies } from "./check.js";
import { compileGlobs } from "./glob.js";
import { IGNORE_DIRS, isSourcePath } from "./graph.js";
import type { Architecture, CheckResult, InferProposal, InferResult, ProjectGraph, Rule } from "./types.js";

const GROUP_DIRS = new Set(["features", "modules", "domains", "packages", "apps", "services"]);
/** Folders that hold tests, demos or tooling rather than application architecture. */
const NOT_MODULES = new Set([
  "test", "tests", "__tests__", "test_dts", "e2e", "spec", "specs", "playground", "playgrounds",
  "docs", "doc", "scripts", "examples", "example", "fixtures", "benchmark", "benchmarks", "bench", "tools", "stories",
  "build", "dist", "out", "coverage",
]);
const PIN_TOP =new Set(["app", "pages", "routes", "views", "screens", "cli", "bin", "main", "ui"]);
const PIN_BOTTOM = new Set(["shared", "utils", "util", "lib", "libs", "common", "types", "constants", "config"]);

/** A module name made of lower case letters, digits and "_". */
export function sanitize(name: string): string {
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

/**
 * Committed build output, as ignore globs. A folder qualifies when it has a typical build or cache name,
 * is not inside a src folder, and holds only plain JavaScript (or is a dot folder).
 */
export function detectBuildOutput(paths: string[]): string[] {
  const onlyJs = new Map<string, boolean>();
  for (const p of paths) {
    const dirs = p.split("/").slice(0, -1);
    const i = dirs.findIndex((d) => IGNORE_DIRS.has(d));
    if (i === -1 || dirs.slice(0, i).includes("src")) continue;
    const dir = dirs.slice(0, i + 1).join("/");
    const js = dirs[i].startsWith(".") || /\.(?:js|mjs|cjs)$/.test(p);
    onlyJs.set(dir, (onlyJs.get(dir) ?? true) && js);
  }
  const pnp = paths.filter((p) => /(?:^|\/)\.pnp\.(?:c?js|loader\.mjs)$/.test(p)); // written by Yarn
  return [...[...onlyJs].filter(([, js]) => js).map(([dir]) => `${dir}/**`), ...pnp].sort();
}

/** What a layers rule says when Voxium wrote it for this order. */
export function layersDescription(layers: string[]): string {
  return `Modules may only import from their own module or from modules lower in the layer order: ${layers.join(" > ")}.`;
}

/** The rules init and setup propose for any architecture: layers in the given order, no cycles, no opaque imports, file size. */
export function defaultRules(layers: string[]): Rule[] {
  return [
    {
      id: "LAYER01",
      type: "layers",
      severity: "block",
      description: layersDescription(layers),
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
      id: "OPAQUE01",
      type: "no_opaque_imports",
      severity: "warn",
      description: "Code must not load modules in a way that hides which ones, such as import() of a variable.",
      rationale: "What cannot be told from the code cannot be checked, so such an import can break any other rule unnoticed.",
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
}

/** Frameworks a package.json depends on, by the name Voxium gives them, in a fixed order. Null when it is not readable. */
export function detectFrameworks(packageJson: string): string[] | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(packageJson);
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return null;
  const deps = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const list = (pkg as Record<string, unknown>)[field];
    if (list && typeof list === "object") for (const name of Object.keys(list)) deps.add(name);
  }
  return FRAMEWORKS.filter(([, names]) => names.some((n) => deps.has(n))).map(([name]) => name);
}

const FRAMEWORKS: Array<[string, string[]]> = [
  ["next", ["next"]],
  ["nuxt", ["nuxt", "nuxt3", "nuxt-nightly"]],
  ["express", ["express"]],
  ["nest", ["@nestjs/core"]],
  ["vite", ["vite"]],
];
/** Frameworks that have a template of their own. */
const FRAMEWORK_TEMPLATES = new Set(["next", "nuxt"]);

const round = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;
/** A module with this many files or more is as certain as a module can be. */
const SURE_FILES = 10;

/**
 * How well the code supports each module, layer and rule of an architecture: the files a module has, the share of the
 * imports between a layer and the others that go down the order, and the share of files a rule finds nothing wrong with.
 */
export function rateArchitecture(arch: Architecture, graph: ProjectGraph, result: CheckResult = checkArchitecture(arch, graph)): InferProposal[] {
  const modOf = assignModules(arch, graphNodes(graph));
  const counts = new Map<string, number>();
  for (const f of graph.files) {
    const m = modOf.get(f);
    if (m !== undefined) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const pos = new Map(arch.layers.map((m, i) => [m, i]));
  const weights = new Map<string, number>();
  for (const d of moduleDependencies(graph, modOf)) {
    if (!d.toMod || d.toMod === d.fromMod || !pos.has(d.fromMod) || !pos.has(d.toMod)) continue;
    const k = `${d.fromMod}>${d.toMod}`;
    weights.set(k, (weights.get(k) ?? 0) + 1);
  }
  const share = (match: (from: string, to: string) => boolean) => {
    let total = 0;
    let down = 0;
    for (const [k, w] of weights) {
      const [a, b] = k.split(">");
      if (!match(a, b)) continue;
      total += w;
      if (pos.get(a)! < pos.get(b)!) down += w;
    }
    return { total, down };
  };

  const out: InferProposal[] = [];
  for (const [name, def] of Object.entries(arch.modules)) {
    const n = counts.get(name) ?? 0;
    out.push({
      kind: "module",
      name,
      confidence: round(n / SURE_FILES),
      evidence: n ? `${n} source file(s) match ${def.paths.join(", ")}.` : `No source file matches ${def.paths.join(", ")}.`,
    });
  }
  for (const name of arch.layers) {
    const { total, down } = share((a, b) => a === name || b === name);
    out.push({
      kind: "layer",
      name,
      confidence: total ? round(down / total) : 0.5,
      evidence: total
        ? `${down} of ${total} import(s) between ${name} and other layers go down the order.`
        : `No imports between ${name} and other layers, so its place in the order is a guess.`,
    });
  }
  const assigned = [...counts.values()].reduce((a, b) => a + b, 0);
  for (const rule of arch.rules) {
    const found = result.violations.filter((v) => v.ruleId === rule.id);
    const files = new Set(found.map((v) => v.file)).size;
    const now = found.length ? `${found.length} violation(s) in ${files} file(s) of the current code` : "No violations in the current code";
    let confidence = assigned ? 1 - files / assigned : found.length ? 0 : 1;
    let evidence = `${now}.`;
    if (rule.type === "layers") {
      const { total, down } = share(() => true);
      confidence = total ? down / total : 0.5;
      evidence = `${down} of ${total} import(s) between layers go down the order. ${now}.`;
    } else if (rule.type === "no_cycles") {
      const inCycles = new Set(found.flatMap((v) => result.cycles.get(v.id)?.modules ?? []));
      const modules = Object.keys(arch.modules).length;
      confidence = modules ? 1 - inCycles.size / modules : 1;
      evidence = inCycles.size ? `${inCycles.size} of ${modules} module(s) are in a cycle now.` : "No modules depend on each other in a cycle now.";
    }
    out.push({ kind: "rule", name: rule.id, confidence: round(confidence), evidence });
  }
  return out;
}

/**
 * "unread" lists files in the graph whose contents could not be read. They are proposed as ignored too, as are those that
 * could not be read to their end. "packageJson" is the root package.json, to name the frameworks it uses in a note.
 */
export function inferArchitecture(graph: ProjectGraph, opts: { unread?: string[]; packageJson?: string | null } = {}): InferResult {
  const notes: string[] = [];
  const frameworks = typeof opts.packageJson === "string" ? detectFrameworks(opts.packageJson) : [];
  if (frameworks === null) notes.push("The root package.json could not be read, so no framework was detected.");
  else if (frameworks.length) {
    const templates = frameworks.filter((f) => FRAMEWORK_TEMPLATES.has(f));
    const offer = templates.length ? ` A template fits it: ${templates.join(", ")}.` : "";
    notes.push(`package.json uses ${frameworks.join(", ")}.${offer}`);
  }
  const output = detectBuildOutput(graph.files);
  const isOutput = compileGlobs(output);
  // A config file that cannot be read is not proposed as ignored: that would drop what it says without a word.
  const unread = [...(opts.unread ?? []), ...graph.unparsed.map((u) => u.file).filter(isSourcePath)].filter((p) => !isOutput(p));
  const ignore = [...output, ...unread];
  const isIgnored = compileGlobs(ignore);
  const files = graph.files.filter((f) => !isIgnored(f));
  if (graph.aliases && Object.keys(graph.aliases).length) {
    notes.push(`Module names from the root tsconfig and workspace were written to "aliases", so a change to those files cannot hide imports: ${Object.keys(graph.aliases).slice(0, 10).join(", ")}${Object.keys(graph.aliases).length > 10 ? ", ..." : ""}.`);
  }
  notes.push(...(graph.notes ?? []).map((n) => `${n}.`));
  if (output.length) {
    notes.push(`Treated as build output or tooling and not checked: ${output.join(", ")}. Remove from "ignore" if any of it is source code.`);
  }
  if (unread.length) {
    notes.push(`Could not be read and not checked: ${unread.join(", ")}. If checked code imports one of them, the check is an error.`);
  }
  const srcRoot = pickSourceRoot(files);
  const prefix = srcRoot ? `${srcRoot}/` : "";

  // Count files per candidate folder.
  const counts = new Map<string, number>();
  for (const f of files) {
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
    ...(ignore.length ? { ignore } : {}),
    ...(graph.aliases && Object.keys(graph.aliases).length ? { aliases: graph.aliases } : {}),
  };

  // Module edges from the import graph.
  const modOf = assignModules(draft, graphNodes(graph));
  const weights = new Map<string, number>();
  for (const d of moduleDependencies(graph, modOf)) {
    if (!d.toMod) continue;
    const k = `${d.fromMod}>${d.toMod}`;
    weights.set(k, (weights.get(k) ?? 0) + 1);
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

  draft.rules = defaultRules(layers);

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
  const unassigned = files.filter((f) => !modOf.has(f)).length;
  if (unassigned > 0) {
    notes.push(`${unassigned} file(s) sit outside any module (for example root level files) and are not checked themselves. Importing one counts as importing everything it leads to.`);
  }

  return {
    architecture: draft,
    confidence,
    notes,
    existingViolations: existing.length,
    proposals: rateArchitecture(draft, graph, result),
    frameworks: frameworks ?? [],
  };
}
