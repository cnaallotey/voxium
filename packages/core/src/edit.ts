import { assignModules } from "./check.js";
import { compileGlob, globAnchors } from "./glob.js";
import { layersDescription } from "./infer.js";
import { validateArchitecture } from "./schema.js";
import type { Architecture, ModuleDef, Rule, Severity } from "./types.js";

export interface ModuleEdit {
  reject?: boolean;
  rename?: string;
  /** Globs that replace the module's paths. */
  paths?: string[];
}

export interface RuleEdit {
  off?: boolean;
  severity?: Severity;
}

/** What a person changed in a draft architecture. Modules and rules are named as the draft names them. */
export interface ArchitectureEdits {
  modules?: Record<string, ModuleEdit>;
  /** The draft's layers in a new order, top to bottom, every one of them once. Rejected modules are left out after. */
  layers?: string[];
  rules?: Record<string, RuleEdit>;
  ignore?: string[];
}

/** How much of a draft a person kept as it was, changed, or threw out: each module and rule, the layer order and the ignore list. */
export interface EditCounts {
  accepted: number;
  edited: number;
  rejected: number;
}

export type EditResult =
  | { ok: true; architecture: Architecture; counts: EditCounts; warnings: string[] }
  | { ok: false; errors: string[] };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_GLOB = 512;
const MAX_PATHS = 20;
const MAX_IGNORE = 1000;
/** Wildcards a glob the edits add may have. */
const MAX_WILDCARDS = 16;
/**
 * How much matching the globs the edits add against the files of the repo may cost, in the units of globWork: about a
 * second of CPU at worst, so that whoever may send the editor cannot keep the Worker busy with long globs full of
 * wildcards.
 */
export const MAX_GLOB_WORK = 500_000_000;
/**
 * What looking at one file costs for a glob, before following the glob through it. applyEdits looks twice, once to count
 * and once to match, and a check that follows once more, so this is what two looks take.
 */
const FILE_WORK = 128;
/**
 * Looking for a glob's plain text in the middle of a path (see globAnchors, which looks for at most MAX_INNER characters
 * of it) costs about one unit for this many characters of the path after the prefix.
 */
const INNER_CHARS = 2;
/**
 * What looking for that text costs more for each character of the path that the text has too. Searching skips quickly
 * over characters the text does not have, but where most characters of a path are in the text, as in "aaaa..." for
 * "aaab", it compares at nearly every character: measured on V8, about 4 ns a character for a text of 7 characters or
 * more and 9 ns for a shorter one, against under 1 ns otherwise.
 */
const NEEDLE_CHAR_WORK = 8;
/** Comparing the start and the end of a path with a glob's prefix and suffix costs about one unit for this many characters. */
const ANCHOR_CHARS = 4;
/** Characters are counted per file in this many buckets: one for each ASCII character, and one for all others. */
const BUCKETS = 129;

/** How often each character is in each file, BUCKETS counts a file. */
function characterCounts(files: string[]): Uint32Array {
  const counts = new Uint32Array(files.length * BUCKETS);
  files.forEach((f, i) => {
    const at = i * BUCKETS;
    for (let j = 0; j < f.length; j++) {
      const c = f.charCodeAt(j);
      counts[at + (c < 128 ? c : 128)]++;
    }
  });
  return counts;
}

/** The buckets of the characters a text has, each once. */
function buckets(text: string): number[] {
  const seen = new Set<number>();
  for (let j = 0; j < text.length; j++) {
    const c = text.charCodeAt(j);
    seen.add(c < 128 ? c : 128);
  }
  return [...seen];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (s: string) => JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}...` : s);
const wild = (segment: string) => /[*?]/.test(segment);
const wildcards = (glob: string) => glob.replace(/[^*?]/g, "").length;

/**
 * About what matching one character of a path against a glob costs: nothing much for a glob without wildcards or a folder
 * with "**" at the end, otherwise some for each character of the rest of the glob from its first wildcard, since each can
 * be in play at every character of the path, and more for each wildcard.
 */
export function globCost(glob: string): number {
  const first = glob.search(/[*?]/);
  if (first < 0 || glob.slice(first) === "**") return 1;
  return 4 * (glob.length - first) + 32 * wildcards(glob);
}

/**
 * About what matching files against globs costs, each glob as often as it is listed, in the order passesAnchors does it:
 * a little for each file; for a file long enough to have the glob's prefix and suffix, some for each of their characters;
 * for one that has them and when the glob has plain text in the middle to look for, some for each character of the file
 * after the prefix and more for each character of the file that the text has too; and for each file that has all the
 * glob asks for before following it (see globAnchors), globCost for each character after the prefix. Stops counting once
 * past limit.
 */
export function globWork(globs: string[], files: string[], limit = Infinity): number {
  let work = 0;
  let counts: Uint32Array | undefined;
  for (const g of globs) {
    work += files.length * FILE_WORK;
    if (work > limit) return work;
    const anchors = globAnchors(g);
    if (anchors.literal) continue;
    const cost = globCost(g);
    const p = anchors.prefix.length;
    const ends = anchors.prefix.length + anchors.suffix.length;
    const compare = Math.ceil(ends / ANCHOR_CHARS);
    const needle = anchors.inner ? buckets(anchors.inner) : [];
    if (needle.length) counts ??= characterCounts(files);
    for (const [i, f] of files.entries()) {
      if (work > limit) return work;
      if (f.length < ends) continue;
      work += compare;
      if ((p && f.slice(0, p) !== anchors.prefix) || (anchors.suffix && f.slice(f.length - anchors.suffix.length) !== anchors.suffix)) continue;
      if (anchors.inner) {
        // Counted over the whole path, prefix included, which can only charge more.
        let near = 0;
        for (const b of needle) near += counts![i * BUCKETS + b];
        work += Math.ceil((f.length - p) / INNER_CHARS) + near * NEEDLE_CHAR_WORK;
        if (!f.includes(anchors.inner, p)) continue;
      }
      work += (f.length - p) * cost;
    }
  }
  return work;
}

/** The first item a list has more than once, unless the draft's own list has it as often. */
function repeated(list: string[], draft: string[]): string | undefined {
  const left = new Map<string, number>();
  for (const g of draft) left.set(g, (left.get(g) ?? 0) + 1);
  for (const g of list) if (!left.has(g)) left.set(g, 1);
  for (const g of list) {
    const n = left.get(g)!;
    if (n === 0) return g;
    left.set(g, n - 1);
  }
  return undefined;
}

/** A repo relative glob that is not too long. */
function globProblem(glob: unknown): string | null {
  if (typeof glob !== "string" || !glob) return "must not be empty";
  if (glob.length > MAX_GLOB) return `must be at most ${MAX_GLOB} characters`;
  if (glob.startsWith("/") || glob.includes("\\") || glob.split("/").includes("..")) return "must be a path inside the repository";
  return null;
}

/**
 * Apply a person's edits to a draft architecture. Edits can only keep, rename, re-path, reorder, switch off or change the
 * severity of what the draft has, and change what it ignores: they cannot add rules, exceptions or anything else. With
 * the source files of the repo, an architecture that leaves no file in any module is refused, and modules that match no
 * file and ignored globs that take in most files are warned about.
 */
export function applyEdits(draft: Architecture, edits: ArchitectureEdits, files?: string[]): EditResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts: EditCounts = { accepted: 0, edited: 0, rejected: 0 };
  const moduleEdits = edits.modules ?? {};
  const ruleEdits = edits.rules ?? {};
  for (const k of Object.keys(moduleEdits)) if (!Object.hasOwn(draft.modules, k)) errors.push(`There is no module ${show(k)} to edit.`);
  for (const k of Object.keys(ruleEdits)) if (!draft.rules.some((r) => r.id === k)) errors.push(`There is no rule ${show(k)} to edit.`);

  const rename = new Map<string, string>();
  const modulesKept: Array<[string, ModuleDef]> = [];
  for (const [name, def] of Object.entries(draft.modules)) {
    const edit = Object.hasOwn(moduleEdits, name) ? moduleEdits[name] : {};
    if (edit.reject) {
      counts.rejected++;
      continue;
    }
    const to = edit.rename ?? name;
    if (to !== name && !NAME.test(to)) errors.push(`Module name ${show(to)} must be up to 64 letters, digits, "-" and "_", starting with a letter or digit.`);
    if (modulesKept.some(([n]) => n === to)) errors.push(`Two modules would be called ${show(to)}.`);
    const paths = edit.paths ?? def.paths;
    if (edit.paths) {
      if (!paths.length || paths.length > MAX_PATHS) errors.push(`Module ${show(to)} needs 1 to ${MAX_PATHS} paths.`);
      const twice = repeated(paths, def.paths);
      if (twice !== undefined) errors.push(`Path ${show(String(twice))} of module ${show(to)} is listed twice.`);
      for (const p of paths) {
        const problem = globProblem(p);
        if (problem) errors.push(`A path of module ${show(to)} ${problem}.`);
        // First match wins, so a module whose path starts with a wildcard could take in every file of the repo.
        else if (wild(p.split("/")[0])) errors.push(`Path ${show(p)} of module ${show(to)} must start with a folder name, so that it cannot take in every file.`);
      }
    }
    const changedPaths = !same(paths, def.paths);
    counts[to !== name || changedPaths ? "edited" : "accepted"]++;
    rename.set(name, to);
    const description = changedPaths && def.description?.startsWith("Files under ") ? `Files matching ${paths.join(", ")}` : def.description;
    modulesKept.push([to, { ...def, paths, ...(description === undefined ? {} : { description }) }]);
  }
  // Own entries even for a name such as "__proto__", which an assignment would not create.
  const modules: Record<string, ModuleDef> = Object.fromEntries(modulesKept);

  const order = edits.layers ?? draft.layers;
  if (order.length !== draft.layers.length || new Set(order).size !== order.length || order.some((l) => !draft.layers.includes(l))) {
    errors.push("The new layer order must list every layer of the draft once.");
  }
  const kept = (list: string[]) => list.filter((l) => rename.has(l)).map((l) => rename.get(l)!);
  const layers = kept(order);
  counts[same(layers, kept(draft.layers)) ? "accepted" : "edited"]++;

  const rules: Rule[] = [];
  for (const r of draft.rules) {
    const edit = Object.hasOwn(ruleEdits, r.id) ? ruleEdits[r.id] : {};
    if (edit.off) {
      counts.rejected++;
      continue;
    }
    if (edit.severity !== undefined && edit.severity !== "block" && edit.severity !== "warn") errors.push(`Rule ${show(r.id)} can only be block or warn.`);
    const severity = edit.severity ?? r.severity;
    counts[severity === r.severity ? "accepted" : "edited"]++;
    const gone = referencedModules(r).filter((m) => !rename.has(m));
    if (gone.length) errors.push(`Rule ${show(r.id)} names module ${show(gone[0])}, which is rejected. Switch the rule off or keep the module.`);
    rules.push(renameModules({ ...r, severity }, rename, draft.layers, layers));
  }

  const ignore = edits.ignore ?? draft.ignore ?? [];
  if (edits.ignore) {
    if (ignore.length > MAX_IGNORE) errors.push(`At most ${MAX_IGNORE} globs can be ignored.`);
    for (const g of ignore.slice(0, MAX_IGNORE)) {
      const problem = globProblem(g);
      if (problem) errors.push(`Ignored glob ${show(String(g))} ${problem}.`);
    }
    const twice = repeated(ignore, draft.ignore ?? []);
    if (twice !== undefined) errors.push(`Ignored glob ${show(String(twice))} is listed twice.`);
  }
  if (edits.ignore || draft.ignore) counts[same(ignore, draft.ignore ?? []) ? "accepted" : "edited"]++;
  // Only what the edits add is held to the limits below, so that a draft accepted as it is always passes. A glob the
  // draft has is added when it is listed more often than in the draft, since each time it is listed it is matched.
  const known = new Map<string, number>();
  for (const g of [...(draft.ignore ?? []), ...Object.values(draft.modules).flatMap((m) => m.paths)]) known.set(g, (known.get(g) ?? 0) + 1);
  const added: string[] = [];
  for (const g of [...ignore, ...modulesKept.flatMap(([, m]) => m.paths)]) {
    if (typeof g !== "string") continue;
    const n = known.get(g) ?? 0;
    if (n > 0) known.set(g, n - 1);
    else added.push(g);
  }
  for (const g of new Set(added)) if (wildcards(g) > MAX_WILDCARDS) errors.push(`Glob ${show(g)} must have at most ${MAX_WILDCARDS} wildcards.`);
  if (errors.length) return { ok: false, errors };

  // Fields stay in the draft's order, so that a draft accepted as it is writes the same file.
  const architecture: Architecture = { ...draft, modules, layers, rules, ignore };
  if (!ignore.length) delete architecture.ignore;
  // An override of a rule switched off goes with it; the description of the change names both.
  if (draft.overrides) {
    const overrides = draft.overrides.filter((o) => rules.some((r) => r.id === o.rule));
    if (overrides.length) architecture.overrides = overrides;
    else delete architecture.overrides;
  }
  const valid = validateArchitecture(architecture);
  if (!valid.ok) return { ok: false, errors: valid.errors };

  for (const g of ignore) if (wild(g.split("/")[0])) warnings.push(`Ignoring ${show(g)} leaves out matching files anywhere in the repository.`);
  if (files) {
    if (globWork(added, files, MAX_GLOB_WORK) > MAX_GLOB_WORK) {
      return { ok: false, errors: [`The new ignored globs and module paths would take too long to match against the ${files.length} source files. Use fewer globs, shorter ones, or fewer wildcards.`] };
    }
    // Every file is matched against each ignored glob once, which both counts what each glob leaves out and says what is left.
    const ignoring = ignore.map(compileGlob);
    const left = new Array<number>(ignore.length).fill(0);
    const code = files.filter((f) => {
      let out = false;
      ignoring.forEach((m, i) => {
        if (m(f)) {
          left[i]++;
          out = true;
        }
      });
      return !out;
    });
    const assigned = assignModules({ ...architecture, ignore: [] }, code);
    if (assigned.size === 0) return { ok: false, errors: ["No file would be in any module, so nothing would be checked. Keep or fix a module, or ignore less."] };
    const used = new Set(assigned.values());
    for (const name of Object.keys(modules)) {
      if (!used.has(name)) warnings.push(`Module ${show(name)} has no files: another module or the ignore list takes them, or its paths match none.`);
    }
    for (const [i, g] of ignore.entries()) {
      const n = left[i];
      if (n * 2 > files.length) warnings.push(`Ignoring ${show(g)} leaves out ${n} of ${files.length} source files, which are then not checked.`);
    }
  }
  return { ok: true, architecture, counts, warnings };
}

/** The modules a rule names. */
export function referencedModules(r: Rule): string[] {
  switch (r.type) {
    case "deny_dependency":
      return [r.from, r.to];
    case "deny_external":
      return [...(r.module === "*" ? [] : [r.module]), ...(r.except ?? [])];
    case "naming":
      return r.module === "*" ? [] : [r.module];
    case "placement":
      return r.modules;
    case "public_api":
      return [r.module];
    default:
      return [];
  }
}

/** A rule with the new names of the modules it names, and a layers rule's own description following the new order. */
function renameModules(r: Rule, names: Map<string, string>, before: string[], after: string[]): Rule {
  const to = (m: string) => names.get(m) ?? m;
  switch (r.type) {
    case "layers":
      return r.description === layersDescription(before) ? { ...r, description: layersDescription(after) } : r;
    case "deny_dependency":
      return { ...r, from: to(r.from), to: to(r.to) };
    case "deny_external":
      return { ...r, module: r.module === "*" ? r.module : to(r.module), ...(r.except ? { except: r.except.map(to) } : {}) };
    case "naming":
      return r.module === "*" ? r : { ...r, module: to(r.module) };
    case "placement":
      return { ...r, modules: r.modules.map(to) };
    case "public_api":
      return { ...r, module: to(r.module) };
    default:
      return r;
  }
}
