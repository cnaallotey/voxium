import type { CycleImport, Violation } from "./types.js";

const MAX_STEPS = 6;

/** One module depending on another. */
export const connection = (d: { fromMod: string; toMod: string }): string => JSON.stringify([d.fromMod, d.toMod]);

/** Imports by the pair of modules they connect. */
export function byPair(imports: CycleImport[]): Map<string, CycleImport[]> {
  const out = new Map<string, CycleImport[]>();
  for (const i of imports) {
    const key = connection(i);
    const list = out.get(key);
    if (list) list.push(i);
    else out.set(key, [i]);
  }
  return out;
}

/** Which modules depend on which, through these imports. */
export function moduleGraph(imports: CycleImport[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { fromMod, toMod } of imports) {
    if (!out.has(fromMod)) out.set(fromMod, new Set());
    out.get(fromMod)!.add(toMod);
  }
  return out;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every import of a cycle takes part in it, so one has to be chosen to point at. First those a change is known to
 * have added, when they connect modules nothing connected before: without them there is no cycle. Then those that go
 * against the layer order, and of these the ones that are not accepted debt. Then the fewest to remove.
 */
function chooser(imports: CycleImport[], isNew?: (i: CycleImport) => boolean): (list: CycleImport[]) => CycleImport {
  const pairs = byPair(imports);
  const fresh = new Set(isNew ? imports.filter(isNew) : []);
  const ranks = new Map<string, { added: number; count: number }>();
  for (const [key, list] of pairs) ranks.set(key, { added: list.every((i) => fresh.has(i)) ? 0 : 1, count: list.length });
  const rank = (i: CycleImport) => ranks.get(connection(i))!;
  const before = (a: CycleImport, b: CycleImport): number =>
    rank(a).added - rank(b).added ||
    Number(b.up) - Number(a.up) ||
    Number(a.accepted) - Number(b.accepted) ||
    Number(fresh.has(b)) - Number(fresh.has(a)) ||
    rank(a).count - rank(b).count ||
    compare(a.file, b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compare(a.to, b.to);
  return (list) => list.reduce((best, i) => (before(i, best) < 0 ? i : best));
}

/** The shortest way from one module to another, as the modules after the first. */
function shortestWay(graph: Map<string, Set<string>>, from: string, to: string): string[] {
  const previous = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  for (let n = 0; n < queue.length && !previous.has(to); n++) {
    for (const next of graph.get(queue[n]) ?? []) {
      if (!previous.has(next)) {
        previous.set(next, queue[n]);
        queue.push(next);
      }
    }
  }
  const way: string[] = [];
  for (let m: string | null | undefined = to; m !== undefined && m !== null && m !== from; m = previous.get(m)) way.unshift(m);
  return way;
}

/**
 * Point a cycle at the import that causes it, and say which imports lead back.
 * `isNew` tells the imports a change added from those that were there before.
 */
export function locateCycle<V extends Pick<Violation, "file" | "line" | "message">>(
  violation: V,
  modules: string[],
  imports: CycleImport[],
  isNew?: (i: CycleImport) => boolean,
): V {
  if (!imports.length) return violation;
  const choose = chooser(imports, isNew);
  const pairs = byPair(imports);
  const cause = choose(imports);
  const steps = [cause];
  let at = cause.toMod;
  for (const next of shortestWay(moduleGraph(imports), cause.toMod, cause.fromMod)) {
    steps.push(choose(pairs.get(connection({ fromMod: at, toMod: next }))!));
    at = next;
  }
  const told = steps.slice(0, MAX_STEPS).map(
    (s) =>
      `${s.file}${s.line ? `:${s.line}` : ""} (${s.fromMod}) ${s.via ? "reaches" : "imports"} ${s.to} (${s.toMod})${s.via ? ` through ${s.via}, which is outside every module` : ""}`,
  );
  if (steps.length > MAX_STEPS) told.push(`${steps.length - MAX_STEPS} more import(s) lead back to ${cause.fromMod}`);
  return {
    ...violation,
    file: cause.file,
    line: cause.line,
    message: `Modules form a dependency cycle: ${modules.join(" <-> ")}. ${told.join("; ")}.`,
  };
}
