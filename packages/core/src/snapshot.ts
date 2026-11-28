import { assignModules, moduleDependencies } from "./check.js";
import type { Architecture, CheckResult, ProjectGraph } from "./types.js";

/**
 * What a check of a branch found, for dashboards: counts by module, rule and module pair, and the exceptions with their
 * expiry. Analysis output only: module names, rule ids, counts and the exceptions of the rules, never a line of code or
 * the message of a violation, which can quote one.
 */
export interface Snapshot {
  modules: Array<{ name: string; files: number; /** Place in the layers, from the top, or null when not in them. */ layer: number | null; debt: number }>;
  /** Imports from one module into another. Violating is how many of them the rules forbid. */
  edges: Array<{ from: string; to: string; imports: number; violating: number }>;
  rules: Array<{ id: string; type: string; severity: string; new: number; baseline: number; excepted: number; warn: number }>;
  exceptions: Array<{ rule: string; file: string; owner: string; expires: string; expired: boolean }>;
  totals: { files: number; modules: number; new: number; baseline: number; excepted: number; warn: number; edges: number };
  /** The version of the organization's rule set the rules come from, or null. */
  orgVersion: number | null;
  /** Overrides of organization rules, without their reasons. */
  overrides: Array<{ rule: string; action: string; owner: string; expires: string; expired: boolean }>;
  /** Some edges or exceptions were left out to stay within MAX_SNAPSHOT_BYTES. */
  truncated: boolean;
}

/** The most a snapshot may take as JSON. */
export const MAX_SNAPSHOT_BYTES = 200 * 1024;
/** The most exceptions a snapshot lists; the totals still count all of them. */
const MAX_EXCEPTIONS = 500;

const bytes = (s: Snapshot) => new TextEncoder().encode(JSON.stringify(s)).length;

/** Whether the rules forbid an import from one module to another: upward against the layers, or a deny_dependency. */
export function forbiddenEdge(arch: Architecture, from: string, to: string): boolean {
  if (from === to) return false;
  if (arch.rules.some((r) => r.type === "deny_dependency" && r.from === from && r.to === to)) return true;
  if (!arch.rules.some((r) => r.type === "layers")) return false;
  const a = arch.layers.indexOf(from);
  const b = arch.layers.indexOf(to);
  return a !== -1 && b !== -1 && b < a;
}

/** A snapshot of a branch from its graph and the result of checking it, within MAX_SNAPSHOT_BYTES. */
export function buildSnapshot(arch: Architecture, graph: ProjectGraph, result: CheckResult, today: Date = new Date()): Snapshot {
  const modOf = assignModules(arch, graph.files);
  const names = Object.keys(arch.modules);
  const fileCount = new Map<string, number>(names.map((n) => [n, 0]));
  for (const m of modOf.values()) fileCount.set(m, (fileCount.get(m) ?? 0) + 1);

  const pairs = new Map<string, { from: string; to: string; imports: number; violating: number }>();
  for (const d of moduleDependencies(graph, modOf)) {
    if (!d.toMod || d.toMod === d.fromMod) continue;
    const key = JSON.stringify([d.fromMod, d.toMod]);
    const edge = pairs.get(key) ?? { from: d.fromMod, to: d.toMod, imports: 0, violating: 0 };
    edge.imports++;
    if (forbiddenEdge(arch, d.fromMod, d.toMod)) edge.violating++;
    pairs.set(key, edge);
  }

  const rules = new Map(arch.rules.map((r) => [r.id, { id: r.id, type: r.type, severity: r.severity, new: 0, baseline: 0, excepted: 0, warn: 0 }]));
  const debt = new Map<string, number>();
  const totals = { files: graph.files.length, modules: names.length, new: 0, baseline: 0, excepted: 0, warn: 0, edges: 0 };
  for (const v of result.violations) {
    const row = rules.get(v.ruleId);
    const kind = v.excepted ? "excepted" : v.baseline ? "baseline" : v.severity === "warn" ? "warn" : "new";
    if (row) row[kind]++;
    totals[kind]++;
    if (kind === "baseline") {
      const m = modOf.get(v.file);
      if (m) debt.set(m, (debt.get(m) ?? 0) + 1);
    }
  }

  const day = today.toISOString().slice(0, 10);
  const exceptions = [...arch.exceptions]
    .sort((a, b) => (a.expires < b.expires ? -1 : a.expires > b.expires ? 1 : 0))
    .map((e) => ({ rule: e.rule, file: e.file, owner: e.owner, expires: e.expires, expired: e.expires < day }));

  // Most telling first, so that what is cut to fit is what matters least.
  const edges = [...pairs.values()].sort((a, b) => b.violating - a.violating || b.imports - a.imports || (a.from + "\0" + a.to < b.from + "\0" + b.to ? -1 : 1));
  totals.edges = edges.length;
  const snapshot: Snapshot = {
    modules: names.map((name) => ({ name, files: fileCount.get(name) ?? 0, layer: arch.layers.includes(name) ? arch.layers.indexOf(name) : null, debt: debt.get(name) ?? 0 })),
    edges,
    rules: [...rules.values()],
    exceptions: exceptions.slice(0, MAX_EXCEPTIONS),
    totals,
    orgVersion: arch.meta?.orgRules?.version ?? null,
    overrides: (arch.overrides ?? []).map((o) => ({ rule: o.rule, action: o.action, owner: o.owner, expires: o.expires, expired: o.expires < day })),
    truncated: exceptions.length > MAX_EXCEPTIONS,
  };
  if (bytes(snapshot) <= MAX_SNAPSHOT_BYTES) return snapshot;
  // Cut the edges by halves until it fits, then the exceptions, then everything but the totals.
  snapshot.truncated = true;
  let keep = snapshot.edges.length;
  while (keep > 0 && bytes(snapshot) > MAX_SNAPSHOT_BYTES) snapshot.edges = edges.slice(0, (keep = Math.floor(keep / 2)));
  while (snapshot.exceptions.length && bytes(snapshot) > MAX_SNAPSHOT_BYTES) snapshot.exceptions = snapshot.exceptions.slice(0, Math.floor(snapshot.exceptions.length / 2));
  if (bytes(snapshot) > MAX_SNAPSHOT_BYTES) snapshot.rules = snapshot.rules.slice(0, 100);
  if (bytes(snapshot) > MAX_SNAPSHOT_BYTES) snapshot.modules = snapshot.modules.slice(0, 100);
  // Names have no length limit of their own, so what is left can still be too large: then only the totals stay.
  if (bytes(snapshot) > MAX_SNAPSHOT_BYTES) return { ...snapshot, modules: [], edges: [], rules: [], exceptions: [], overrides: [] };
  return snapshot;
}
