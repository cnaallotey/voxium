import { globToRegExp, matchesAny } from "./glob.js";
import type {
  Architecture,
  CheckResult,
  Exception,
  ProjectGraph,
  Rule,
  Violation,
} from "./types.js";

export function assignModules(arch: Architecture, files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const entries = Object.entries(arch.modules);
  for (const file of files) {
    for (const [name, def] of entries) {
      if (matchesAny(file, def.paths)) {
        map.set(file, name);
        break;
      }
    }
  }
  return map;
}

/** Tarjan strongly connected components over a module graph. */
export function findCycles(adj: Map<string, Set<string>>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const out: string[][] = [];

  const visit = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };

  for (const v of adj.keys()) if (!idx.has(v)) visit(v);
  return out;
}

function ruleOf<T extends Rule["type"]>(arch: Architecture, type: T): Extract<Rule, { type: T }>[] {
  return arch.rules.filter((r) => r.type === type) as Extract<Rule, { type: T }>[];
}

export interface CheckOptions {
  /** Violation ids that are accepted debt. They are reported but do not fail. */
  baseline?: string[];
  /** Override today for tests. */
  today?: Date;
}

export function checkArchitecture(
  arch: Architecture,
  graph: ProjectGraph,
  opts: CheckOptions = {},
): CheckResult {
  const modOf = assignModules(arch, graph.files);
  const violations: Violation[] = [];
  const layerIndex = new Map(arch.layers.map((m, i) => [m, i]));
  const baseline = new Set(opts.baseline ?? []);
  const today = (opts.today ?? new Date()).toISOString().slice(0, 10);

  const add = (v: Omit<Violation, "id"> & { key: string }): void => {
    const { key, ...rest } = v;
    violations.push({ ...rest, id: `${v.ruleId}:${key}` });
  };

  // Layer and dependency denial rules, evaluated per file edge.
  const layersRule = ruleOf(arch, "layers")[0];
  const denyDeps = ruleOf(arch, "deny_dependency");
  const denyExt = ruleOf(arch, "deny_external");
  const moduleEdges = new Map<string, Set<string>>();
  const evidence = new Map<string, { from: string; to: string }>();

  for (const e of graph.edges) {
    const fromMod = modOf.get(e.from);
    if (!fromMod) continue;

    if (e.pkg) {
      for (const r of denyExt) {
        if (r.module === fromMod && r.packages.includes(e.pkg)) {
          add({
            ruleId: r.id,
            severity: r.severity,
            file: e.from,
            key: `${e.from}->${e.pkg}`,
            message: `${e.from} imports package "${e.pkg}", which module "${fromMod}" must not use.`,
            fix: `Move this usage into the module that is allowed to use "${e.pkg}" and call it from there.`,
            rationale: r.rationale,
          });
        }
      }
      continue;
    }

    const toMod = e.to ? modOf.get(e.to) : undefined;
    if (!e.to || !toMod || toMod === fromMod) continue;

    if (!moduleEdges.has(fromMod)) moduleEdges.set(fromMod, new Set());
    moduleEdges.get(fromMod)!.add(toMod);
    const ek = `${fromMod}>${toMod}`;
    if (!evidence.has(ek)) evidence.set(ek, { from: e.from, to: e.to });

    if (layersRule) {
      const a = layerIndex.get(fromMod);
      const b = layerIndex.get(toMod);
      if (a !== undefined && b !== undefined && a > b) {
        add({
          ruleId: layersRule.id,
          severity: layersRule.severity,
          file: e.from,
          key: `${e.from}->${e.to}`,
          message: `${e.from} (${fromMod}) imports ${e.to} (${toMod}). Layer order puts ${toMod} above ${fromMod}.`,
          fix: `Invert the dependency: have ${toMod} pass the data in, or move the shared code into a lower layer such as "${arch.layers[arch.layers.length - 1]}".`,
          rationale: layersRule.rationale,
        });
      }
    }

    for (const r of denyDeps) {
      if (r.from === fromMod && r.to === toMod) {
        add({
          ruleId: r.id,
          severity: r.severity,
          file: e.from,
          key: `${e.from}->${e.to}`,
          message: `${e.from} imports ${e.to}. Module "${fromMod}" must not depend on "${toMod}".`,
          fix: `Go through an allowed module instead of importing "${toMod}" directly.`,
          rationale: r.rationale,
        });
      }
    }
  }

  // Cycles between modules.
  for (const r of ruleOf(arch, "no_cycles")) {
    for (const comp of findCycles(moduleEdges)) {
      const sample = comp
        .flatMap((a) => comp.map((b) => evidence.get(`${a}>${b}`)))
        .find((x) => x);
      add({
        ruleId: r.id,
        severity: r.severity,
        file: sample?.from ?? comp[0],
        key: comp.join("+"),
        message: `Modules form a dependency cycle: ${comp.join(" <-> ")}.`,
        fix: `Break the cycle by extracting the shared piece into a lower layer module or inverting one dependency.`,
        rationale: r.rationale,
      });
    }
  }

  // File size limit.
  for (const r of ruleOf(arch, "max_file_lines")) {
    for (const f of graph.files) {
      if (!modOf.has(f)) continue;
      if ((graph.lines[f] ?? 0) > r.max) {
        add({
          ruleId: r.id,
          severity: r.severity,
          file: f,
          key: f,
          message: `${f} has ${graph.lines[f]} lines, over the limit of ${r.max}.`,
          fix: `Split the file by responsibility.`,
          rationale: r.rationale,
        });
      }
    }
  }

  // Exceptions and baseline.
  const expiredExceptions: Exception[] = [];
  const activeExceptions: Exception[] = [];
  for (const ex of arch.exceptions) {
    if (ex.expires < today) expiredExceptions.push(ex);
    else activeExceptions.push(ex);
  }
  for (const v of violations) {
    if (activeExceptions.some((ex) => ex.rule === v.ruleId && globToRegExp(ex.file).test(v.file))) {
      v.excepted = true;
    }
    if (baseline.has(v.id)) v.baseline = true;
  }

  return {
    violations,
    expiredExceptions,
    stats: {
      files: graph.files.length,
      assigned: modOf.size,
      edges: graph.edges.length,
      modules: Object.keys(arch.modules).length,
    },
  };
}

/** Violations that should fail CI: blocking, not baseline, not excepted. */
export function failing(result: CheckResult): Violation[] {
  return result.violations.filter((v) => v.severity === "block" && !v.baseline && !v.excepted);
}
