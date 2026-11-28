import { conventionViolations } from "./conventions.js";
import { connection, locateCycle, moduleGraph } from "./cycles.js";
import { compileGlob, compileGlobs } from "./glob.js";
import { effectiveRules } from "./org.js";
import { EVERY_MODULE } from "./schema.js";
import type {
  Architecture,
  CheckResult,
  Cycle,
  CycleImport,
  Exception,
  ImportEdge,
  OpaqueUse,
  ProjectGraph,
  Rule,
  UnparsedFile,
  Violation,
} from "./types.js";

/**
 * Which module each file belongs to. Ignored files belong to none, so they are not judged themselves, but
 * like any other file outside the modules they are followed when something imports them.
 */
/** The nodes of a graph: its files, and what imports lead to that is no source file, such as the package.json of a package. */
export function graphNodes(graph: ProjectGraph): string[] {
  const files = new Set(graph.files);
  const more = new Set<string>();
  for (const e of graph.edges) if (e.to && !files.has(e.to)) more.add(e.to);
  return more.size ? [...graph.files, ...[...more].sort()] : graph.files;
}

export function assignModules(arch: Architecture, files: string[]): Map<string, string> {
  return modulesOf(arch, files, compileGlobs(arch.ignore ?? []));
}

/** assignModules, with what is ignored already known. Each glob is read once, not once a file. */
function modulesOf(arch: Architecture, files: string[], ignored: (file: string) => boolean): Map<string, string> {
  const map = new Map<string, string>();
  const entries = Object.entries(arch.modules).map(([name, def]) => [name, compileGlobs(def.paths)] as const);
  for (const file of files) {
    if (ignored(file)) continue;
    for (const [name, matches] of entries) {
      if (matches(file)) {
        map.set(file, name);
        break;
      }
    }
  }
  return map;
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
  /** Line of the import in `from`. */
  line?: number;
  /**
   * From fileDependencies only, for an indirect dependency on one of the modules it was asked about: every file of that
   * module the dependency reaches, sorted. `to` is the first of them.
   */
  reached?: readonly string[];
}

const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[^/]+$/;

/**
 * Everything module files depend on, directly or through files that belong to no module.
 * Unassigned files are transparent: importing one means depending on whatever it leads to. Without this,
 * a file placed outside the modules could be used to pass any import around the rules.
 * Test files that nothing imports are checked on direct imports only, so shared test helpers stay usable.
 */
export function moduleDependencies(graph: ProjectGraph, modOf: Map<string, string>): Dependency[] {
  return dependencies(graph, modOf, new Set());
}

/**
 * As moduleDependencies, but an indirect dependency on one of `modules` lists in `reached` every file of it that it
 * reaches, not only the first, so a file outside the modules that leads to an entry and to another file is seen for both.
 * It is still one Dependency per import, so a barrel that many files import costs no more than one per import.
 */
export function fileDependencies(graph: ProjectGraph, modOf: Map<string, string>, modules: ReadonlySet<string>): Dependency[] {
  return dependencies(graph, modOf, modules);
}

function dependencies(graph: ProjectGraph, modOf: Map<string, string>, everyFile: ReadonlySet<string>): Dependency[] {
  const outgoing = new Map<string, ImportEdge[]>();
  const imported = new Set<string>();
  for (const e of graph.edges) {
    if (e.to) imported.add(e.to);
    if (modOf.has(e.from)) continue;
    const list = outgoing.get(e.from);
    if (list) list.push(e);
    else outgoing.set(e.from, [e]);
  }

  type Reach = { modules: Map<string, Set<string>>; pkgs: Set<string>; sorted?: Map<string, string[]> };
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
          const reached = found.modules.get(mod);
          if (!reached) found.modules.set(mod, new Set([e.to]));
          else if (everyFile.has(mod)) reached.add(e.to);
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
    const { from, line } = e;
    const fromMod = modOf.get(from);
    if (!fromMod) continue;
    if (e.pkg) {
      out.push({ from, fromMod, pkg: e.pkg, line });
      continue;
    }
    if (!e.to) continue;
    const toMod = modOf.get(e.to);
    if (toMod) {
      if (toMod !== fromMod) out.push({ from, fromMod, to: e.to, toMod, line });
      continue;
    }
    if (TEST_FILE.test(from) && !imported.has(from)) continue;
    const r = reach(e.to);
    for (const [mod, files] of r.modules) {
      if (mod === fromMod) continue;
      if (!everyFile.has(mod)) {
        for (const file of files) out.push({ from, fromMod, to: file, toMod: mod, via: e.to, line });
        continue;
      }
      r.sorted ??= new Map();
      let reached = r.sorted.get(mod);
      if (!reached) r.sorted.set(mod, (reached = [...files].sort()));
      out.push({ from, fromMod, to: reached[0], toMod: mod, via: e.to, line, reached });
    }
    for (const pkg of r.pkgs) out.push({ from, fromMod, pkg, via: e.to, line });
  }
  return out;
}

const OPAQUE: Record<OpaqueUse["kind"], string> = {
  import: "calls import() with a module name that is only known when it runs",
  require: "calls require() with a module name that is only known when it runs",
  require_value: "uses require as a value",
  glob: "loads more files than can be told with one pattern",
  url: "uses new URL() with a name that is only known when it runs",
};

/** Opaque imports in the files of modules, and in those outside that they lead to. */
function opaqueUses(graph: ProjectGraph, modOf: Map<string, string>): OpaqueUse[] {
  if (!graph.opaque.length) return [];
  const imported = new Set(graph.edges.map((e) => e.to));
  const next = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!e.to || modOf.has(e.to)) continue;
    const list = next.get(e.from);
    if (list) list.push(e.to);
    else next.set(e.from, [e.to]);
  }
  const reached = new Set(modOf.keys());
  // Test files that nothing imports may share helpers with any code in them, as in moduleDependencies.
  const queue = [...reached].filter((f) => !TEST_FILE.test(f) || imported.has(f));
  for (let i = 0; i < queue.length; i++) {
    for (const to of next.get(queue[i]) ?? []) {
      if (reached.has(to)) continue;
      reached.add(to);
      queue.push(to);
    }
  }
  return graph.opaque.filter((u) => reached.has(u.file));
}

/**
 * Of the files whose contents are not known, those that matter. An ignored one is fine only while nothing that is
 * checked leads to it, because otherwise it could carry any import out of sight.
 */
export function uncheckedPaths(graph: ProjectGraph, unread: string[], ignore: string[] = []): string[] {
  if (!unread.length) return [];
  return uncheckedWith(graph, unread, compileGlobs(ignore));
}

/** uncheckedPaths, with what is ignored already known. */
function uncheckedWith(graph: ProjectGraph, unread: string[], ignored: (file: string) => boolean): string[] {
  if (!unread.length) return [];
  const missing = new Set(unread);
  const next = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!e.to) continue;
    const list = next.get(e.from);
    if (list) list.push(e.to);
    else next.set(e.from, [e.to]);
  }
  const queue = graph.files.filter((f) => !missing.has(f) && !ignored(f));
  const reached = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    for (const to of next.get(queue[i]) ?? []) {
      if (!reached.has(to)) {
        reached.add(to);
        queue.push(to);
      }
    }
  }
  return unread.filter((p) => reached.has(p) || !ignored(p));
}

/** Files whose imports are not known because their code could not be read to its end, and that matter. */
export function unparsedFiles(graph: ProjectGraph, ignore: string[] = []): UnparsedFile[] {
  const left = new Set(uncheckedPaths(graph, graph.unparsed.map((u) => u.file), ignore));
  return graph.unparsed.filter((u) => left.has(u.file));
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

/** A builtin of Node is the same with "node:" in front or not. */
const samePackage = (a: string, b: string) => a.replace(/^node:/, "") === b.replace(/^node:/, "");

function ruleOf<T extends Rule["type"]>(arch: Architecture, type: T): Extract<Rule, { type: T }>[] {
  return arch.rules.filter((r) => r.type === type) as Extract<Rule, { type: T }>[];
}

export interface CheckOptions {
  /** Violation ids that are accepted debt. They are reported but do not fail. */
  baseline?: string[];
  /**
   * Which modules depended on which before the change, from moduleConnections. With it, what is left of an accepted
   * cycle is accepted too, as long as it has no new connections. Without it, only exactly the accepted cycle is.
   */
  connections?: ReadonlySet<string>;
  /** Override today for tests. */
  today?: Date;
}

/** Which modules depend on which. */
export function moduleConnections(arch: Architecture, graph: ProjectGraph): Set<string> {
  const out = new Set<string>();
  for (const { fromMod, toMod } of moduleDependencies(graph, assignModules(arch, graphNodes(graph)))) if (toMod) out.add(connection({ fromMod, toMod }));
  return out;
}

/** Whether the code from before the change is needed to decide. See CheckOptions.connections. */
export function needsConnections(result: CheckResult): boolean {
  return [...result.cycles.values()].some((c) => c.undecided);
}

export function checkArchitecture(
  input: Architecture,
  graph: ProjectGraph,
  opts: CheckOptions = {},
): CheckResult {
  // Overrides of organization rules apply first: the rules checked are those in force today.
  const { rules: inForce, expired: expiredOverrides } = effectiveRules(input, (opts.today ?? new Date()).toISOString().slice(0, 10));
  const arch: Architecture = inForce === input.rules ? input : { ...input, rules: inForce };
  // Each ignored glob is read once and followed once a file, so that the check costs what applyEdits' budget counts.
  const nodes = graphNodes(graph);
  const isIgnored = compileGlobs(arch.ignore ?? []);
  const ignoredNodes = new Set(arch.ignore?.length ? nodes.filter(isIgnored) : []);
  const ignored = (f: string) => ignoredNodes.has(f);
  const modOf = modulesOf(arch, nodes, ignored);
  const violations: Violation[] = [];
  const layerIndex = new Map(arch.layers.map((m, i) => [m, i]));
  const baseline = new Set(opts.baseline ?? []);
  const today = (opts.today ?? new Date()).toISOString().slice(0, 10);

  const add = (v: Omit<Violation, "id"> & { key: string }): void => {
    const { key, ...rest } = v;
    violations.push({ ...rest, id: `${v.ruleId}:${key}` });
  };

  // Layer and dependency denial rules, evaluated per file edge.
  const layersRules = ruleOf(arch, "layers");
  const denyDeps = ruleOf(arch, "deny_dependency");
  const denyExt = ruleOf(arch, "deny_external");
  const between: CycleImport[] = [];

  for (const d of moduleDependencies(graph, modOf)) {
    const through = d.via ? ` through ${d.via}, which is outside every module` : "";
    const viaFix = d.via ? ` Or assign ${d.via} to a module so its own imports are checked.` : "";

    if (d.pkg) {
      for (const r of denyExt) {
        const applies = r.module === EVERY_MODULE ? !r.except?.includes(d.fromMod) : r.module === d.fromMod;
        if (applies && r.packages.some((p) => samePackage(p, d.pkg!))) {
          add({
            ruleId: r.id,
            severity: r.severity,
            file: d.from,
          line: d.line,
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

    const a = layerIndex.get(fromMod);
    const b = layerIndex.get(toMod);
    const up = a !== undefined && b !== undefined && a > b;
    between.push({
      file: d.from,
      line: d.line,
      to: d.to,
      ...(d.via ? { via: d.via } : {}),
      fromMod,
      toMod,
      up,
      accepted: layersRules.some((r) => baseline.has(`${r.id}:${key}`)),
    });

    for (const layersRule of up ? layersRules : []) {
      add({
        ruleId: layersRule.id,
        severity: layersRule.severity,
        file: d.from,
        line: d.line,
        key,
        message: `${d.from} (${fromMod}) ${verb} ${d.to} (${toMod})${through}. Layer order puts ${toMod} above ${fromMod}.`,
        fix: `Invert the dependency: have ${toMod} pass the data in, or move the shared code into a lower layer such as "${arch.layers[arch.layers.length - 1]}".${viaFix}`,
        rationale: layersRule.rationale,
      });
    }

    for (const r of denyDeps) {
      if (r.from === fromMod && r.to === toMod) {
        add({
          ruleId: r.id,
          severity: r.severity,
          file: d.from,
          line: d.line,
          key,
          message: `${d.from} ${verb} ${d.to}${through}. Module "${fromMod}" must not depend on "${toMod}".`,
          fix: `Go through an allowed module instead of importing "${toMod}" directly.${viaFix}`,
          rationale: r.rationale,
        });
      }
    }
  }

  // Exceptions.
  const expiredExceptions: Exception[] = [];
  const activeExceptions: Exception[] = [];
  for (const ex of arch.exceptions) {
    if (ex.expires < today) expiredExceptions.push(ex);
    else activeExceptions.push(ex);
  }

  // Cycles between modules.
  const cycles = new Map<string, Cycle>();
  // Ids join module names with "+", so they can only be taken apart when no name has one.
  const readable = !Object.keys(arch.modules).some((m) => m.includes("+"));
  for (const r of ruleOf(arch, "no_cycles")) {
    const idOf = (modules: string[]) => `${r.id}:${modules.join("+")}`;
    const accepted = readable
      ? [...baseline].filter((id) => id.startsWith(`${r.id}:`)).map((id) => new Set(id.slice(r.id.length + 1).split("+")))
      : [];
    const among = (modules: string[], imports: CycleImport[]) => imports.filter((i) => modules.includes(i.fromMod) && modules.includes(i.toMod));
    const judge = (modules: string[], imports: CycleImport[]): "accepted" | "new" | "undecided" => {
      if (baseline.has(idOf(modules))) return "accepted";
      if (!accepted.some((set) => modules.every((m) => set.has(m)))) return "new";
      if (!opts.connections) return "undecided";
      return imports.every((i) => opts.connections!.has(connection(i))) ? "accepted" : "new";
    };
    const excepts = compileGlobs(activeExceptions.filter((ex) => ex.rule === r.id).map((ex) => ex.file));
    for (const modules of findCycles(moduleGraph(between))) {
      let imports = among(modules, between);
      let verdict = judge(modules, imports);
      // An exception is about the imports in its files: without them there must be no cycle left that is not accepted.
      // When there is one, only imports that no exception covers are kept, so below nothing excepts it.
      const counted = imports.filter((i) => !excepts(i.file));
      let excepted = false;
      if (counted.length < imports.length) {
        const left = findCycles(moduleGraph(counted)).map((c) => ({ imports: among(c, counted), verdict: judge(c, among(c, counted)) }));
        const worst = left.find((c) => c.verdict !== "accepted");
        excepted = !worst;
        if (worst) imports = worst.imports;
        if (worst && verdict !== "accepted") verdict = worst.verdict;
      }
      const id = idOf(modules);
      cycles.set(id, { modules, imports, ...(verdict === "undecided" && !excepted ? { undecided: true } : {}) });
      const violation: Violation = {
        id,
        ruleId: r.id,
        severity: r.severity,
        file: modules[0],
        message: "",
        fix: `Break the cycle by extracting the shared piece into a lower layer module or inverting one dependency.`,
        rationale: r.rationale,
        ...(verdict === "accepted" ? { baseline: true } : {}),
        ...(excepted ? { excepted } : {}),
      };
      const known = opts.connections;
      violations.push(locateCycle(violation, modules, imports, known && ((i) => !known.has(connection(i)))));
    }
  }

  // Imports that cannot be told from the code.
  const opaque = opaqueUses(graph, modOf);
  for (const r of ruleOf(arch, "no_opaque_imports")) {
    const byFile = new Map<string, OpaqueUse[]>();
    for (const u of opaque) {
      const uses = byFile.get(u.file);
      if (uses) uses.push(u);
      else byFile.set(u.file, [u]);
    }
    for (const [file, uses] of byFile) {
      const [first] = uses;
      const more = uses.length > 1 ? `, and ${uses.length - 1} more like it` : "";
      add({
        ruleId: r.id,
        severity: r.severity,
        file,
        line: first.line,
        key: file,
        message: `${file} ${OPAQUE[first.kind]} on line ${first.line}${more}, so the rules cannot be checked there.`,
        fix: `Write the name of the module out, or load from a list of imports that names each one.`,
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

  // Naming, placement and public entry points. An ignored file is judged too once checked code leads to it, as in
  // uncheckedPaths, so that it cannot be used to hide one.
  const reachedIgnored = new Set(uncheckedWith(graph, graph.files.filter(ignored), ignored));
  const owners = reachedIgnored.size ? Object.entries(arch.modules).map(([name, def]) => [name, compileGlobs(def.paths)] as const) : [];
  for (const v of conventionViolations({
    arch,
    files: graph.files.filter((f) => !ignored(f) || reachedIgnored.has(f)),
    owner: (f) => modOf.get(f) ?? (reachedIgnored.has(f) ? owners.find(([, matches]) => matches(f))?.[0] : undefined),
    dependencies: () => fileDependencies(graph, modOf, new Set(ruleOf(arch, "public_api").map((r) => r.module))),
  })) {
    add(v);
  }

  // Exceptions and baseline.
  const exceptionMatchers = activeExceptions.map((ex) => ({ rule: ex.rule, matches: compileGlob(ex.file) }));
  for (const v of violations) {
    if (exceptionMatchers.some((ex) => ex.rule === v.ruleId && ex.matches(v.file))) {
      v.excepted = true;
    }
    if (baseline.has(v.id) || (v.acceptedAs !== undefined && baseline.has(v.acceptedAs))) v.baseline = true;
  }

  return {
    violations,
    cycles,
    expiredExceptions,
    expiredOverrides,
    opaque,
    stats: {
      files: graph.files.length,
      assigned: graph.files.filter((f) => modOf.has(f)).length,
      edges: graph.edges.length,
      modules: Object.keys(arch.modules).length,
      unresolved: graph.unresolved ?? 0,
    },
  };
}

/** Violations that should fail CI: blocking, not baseline, not excepted. */
export function failing(result: CheckResult): Violation[] {
  return result.violations.filter((v) => v.severity === "block" && !v.baseline && !v.excepted);
}
