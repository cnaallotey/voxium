import { globToRegExp, matchesAny } from "./glob.js";
import type {
  Architecture,
  CheckResult,
  Exception,
  ImportEdge,
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

/** Drop files the architecture explicitly ignores, and every import from or to them. */
export function withoutIgnored(graph: ProjectGraph, ignore: string[] | undefined): ProjectGraph {
  if (!ignore?.length) return graph;
  const files = graph.files.filter((f) => !matchesAny(f, ignore));
  if (files.length === graph.files.length) return graph;
  const keep = new Set(files);
  return { ...graph, files, edges: graph.edges.filter((e) => keep.has(e.from) && (!e.to || keep.has(e.to))) };
}

export interface Dependency {
  /** File inside a module that has the dependency. */
  from: string;
  fromMod: string;
  /** Target file and its module, for internal dependencies. */
  to?: string;
  toMod?: string;
  /** Target package, for external dependencies. */
  pkg?: string;
  /** The file outside every module that the dependency passes through, when it is indirect. */
  via?: string;
}

const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[^/]+$/;

/**
 * Everything module files depend on, directly or through files that belong to no module.
 * Unassigned files are transparent: importing one means depending on whatever it leads to. Without this,
 * a file placed outside the modules could be used to pass any import around the rules.
 * Test files that nothing imports are checked on direct imports only, so shared test helpers stay usable.
 */
export function moduleDependencies(graph: ProjectGraph, modOf: Map<string, string>): Dependency[] {
  const outgoing = new Map<string, ImportEdge[]>();
  const imported = new Set<string>();
  for (const e of graph.edges) {
    if (e.to) imported.add(e.to);
    if (modOf.has(e.from)) continue;
    const list = outgoing.get(e.from);
    if (list) list.push(e);
    else outgoing.set(e.from, [e]);
  }

  type Reach = { modules: Map<string, string>; pkgs: Set<string> };
  const memo = new Map<string, Reach>();
  const reach = (start: string): Reach => {
    const hit = memo.get(start);
    if (hit) return hit;
    const found: Reach = { modules: new Map(), pkgs: new Set() };
    const seen = new Set([start]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      for (const e of outgoing.get(queue[i]) ?? []) {
        if (e.pkg) found.pkgs.add(e.pkg);
        if (!e.to) continue;
        const mod = modOf.get(e.to);
        if (mod) {
          if (!found.modules.has(mod)) found.modules.set(mod, e.to);
        } else if (!seen.has(e.to)) {
          seen.add(e.to);
          queue.push(e.to);
        }
      }
    }
    memo.set(start, found);
    return found;
  };

  const out: Dependency[] = [];
  for (const e of graph.edges) {
    const from = e.from;
    const fromMod = modOf.get(from);
    if (!fromMod) continue;
    if (e.pkg) {
      out.push({ from, fromMod, pkg: e.pkg });
      continue;
    }
    if (!e.to) continue;
    const toMod = modOf.get(e.to);
    if (toMod) {
      if (toMod !== fromMod) out.push({ from, fromMod, to: e.to, toMod });
      continue;
    }
    if (TEST_FILE.test(from) && !imported.has(from)) continue;
    const r = reach(e.to);
    for (const [mod, file] of r.modules) {
      if (mod !== fromMod) out.push({ from, fromMod, to: file, toMod: mod, via: e.to });
    }
    for (const pkg of r.pkgs) out.push({ from, fromMod, pkg, via: e.to });
  }
  return out;
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
  input: ProjectGraph,
  opts: CheckOptions = {},
): CheckResult {
  const graph = withoutIgnored(input, arch.ignore);
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

  for (const d of moduleDependencies(graph, modOf)) {
    const through = d.via ? ` through ${d.via}, which is outside every module` : "";
    const viaFix = d.via ? ` Or assign ${d.via} to a module so its own imports are checked.` : "";

    if (d.pkg) {
      for (const r of denyExt) {
        if (r.module === d.fromMod && r.packages.includes(d.pkg)) {
          add({
            ruleId: r.id,
            severity: r.severity,
            file: d.from,
            key: d.via ? `${d.from}->${d.via}=>${d.pkg}` : `${d.from}->${d.pkg}`,
            message: `${d.from} ${d.via ? "reaches" : "imports"} package "${d.pkg}"${through}, which module "${d.fromMod}" must not use.`,
            fix: `Move this usage into the module that is allowed to use "${d.pkg}" and call it from there.${viaFix}`,
            rationale: r.rationale,
          });
        }
      }
      continue;
    }

    if (!d.to || !d.toMod) continue;
    const { fromMod, toMod } = d;
    // Indirect dependencies are identified per target module, so unrelated edits do not change the id.
    const key = d.via ? `${d.from}->${d.via}=>${toMod}` : `${d.from}->${d.to}`;
    const verb = d.via ? "reaches" : "imports";

    if (!moduleEdges.has(fromMod)) moduleEdges.set(fromMod, new Set());
    moduleEdges.get(fromMod)!.add(toMod);
    const ek = `${fromMod}>${toMod}`;
    if (!evidence.has(ek)) evidence.set(ek, { from: d.from, to: d.to });

    if (layersRule) {
      const a = layerIndex.get(fromMod);
      const b = layerIndex.get(toMod);
      if (a !== undefined && b !== undefined && a > b) {
        add({
          ruleId: layersRule.id,
          severity: layersRule.severity,
          file: d.from,
          key,
          message: `${d.from} (${fromMod}) ${verb} ${d.to} (${toMod})${through}. Layer order puts ${toMod} above ${fromMod}.`,
          fix: `Invert the dependency: have ${toMod} pass the data in, or move the shared code into a lower layer such as "${arch.layers[arch.layers.length - 1]}".${viaFix}`,
          rationale: layersRule.rationale,
        });
      }
    }

    for (const r of denyDeps) {
      if (r.from === fromMod && r.to === toMod) {
        add({
          ruleId: r.id,
          severity: r.severity,
          file: d.from,
          key,
          message: `${d.from} ${verb} ${d.to}${through}. Module "${fromMod}" must not depend on "${toMod}".`,
          fix: `Go through an allowed module instead of importing "${toMod}" directly.${viaFix}`,
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
