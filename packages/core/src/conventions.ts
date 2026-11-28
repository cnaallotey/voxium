import { compileGlob, compileGlobs } from "./glob.js";
import { EVERY_MODULE } from "./schema.js";
import type { Architecture, NamingStyle, Rule, Violation } from "./types.js";
import type { Dependency } from "./check.js";

type Naming = Extract<Rule, { type: "naming" }>;
type Placement = Extract<Rule, { type: "placement" }>;
type PublicApi = Extract<Rule, { type: "public_api" }>;

/** ASCII only, so a name with a letter that only looks like one of these does not pass. */
const STYLES: Record<NamingStyle, { test: RegExp; name: string; join: (words: string[]) => string }> = {
  kebab: { test: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, name: "kebab-case", join: (w) => w.join("-") },
  snake: { test: /^[a-z0-9]+(?:_[a-z0-9]+)*$/, name: "snake_case", join: (w) => w.join("_") },
  camel: { test: /^[a-z][a-zA-Z0-9]*$/, name: "camelCase", join: (w) => w.map((x, i) => (i ? cap(x) : x)).join("") },
  pascal: { test: /^[A-Z][a-zA-Z0-9]*$/, name: "PascalCase", join: (w) => w.map(cap).join("") },
};
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * Names that frameworks give files, which no style can change: Next, Nuxt, SvelteKit and Remix routes and special files.
 * In a routes folder, Remix flat routes also mark a pathless layout with a leading "_" (`_auth.login.tsx`, `_index.tsx`),
 * a route that leaves its parent's layout with a trailing "_" (`concerts_.mine.tsx`), an optional segment with
 * parentheses (`($lang)._index.tsx`, `(en).about.tsx`), and characters the URL keeps as they are with square brackets
 * (`sitemap[.]xml.tsx`). There a dot in square brackets does not end the name, what is in square brackets and the
 * markers are left out, an optional parameter is skipped like any parameter, and the rest is judged.
 */
const ROUTE_PARAM = /^\[\[?(?:\.\.\.)?[^[\]/]+\]\]?(?:\.|$)/;
const FRAMEWORK = new Set(["index", "_app", "_document", "_error", "_middleware", "+page", "+layout", "+server", "+error"]);
const REMIX_PARAM = /^\$[A-Za-z0-9_]*$/;
/** Remix flat routes are files in a routes folder. */
const REMIX_ROUTES = /(?:^|\/)routes\//;
/** The first segment of a Remix flat route name: up to a dot that is not in square brackets. */
const REMIX_SEGMENT = /^(?:\[[^\]/]*\]|[^.])*/;
const REMIX_ESCAPE = /\[[^\]/]*\]/g;
const REMIX_OPTIONAL = /^\((.*)\)$/;

export const styleName = (style: NamingStyle) => STYLES[style].name;

/**
 * The part of a file name whose style is judged: before the first dot (after any leading dots), without one of the endings
 * the rule leaves out. Null for names a framework decides.
 */
export function nameStem(file: string, ignoreSuffixes: string[] = []): string | null {
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (ROUTE_PARAM.test(base)) return null;
  const rest = base.replace(/^\.+/, "");
  const routes = REMIX_ROUTES.test(file);
  const first = routes ? REMIX_SEGMENT.exec(rest)![0] : rest.split(".")[0];
  if (FRAMEWORK.has(first) || REMIX_PARAM.test(first)) return null;
  let stem = first;
  if (routes) {
    const optional = REMIX_OPTIONAL.exec(stem);
    if (optional && REMIX_PARAM.test(optional[1])) return null;
    stem = (optional ? optional[1] : stem).replace(REMIX_ESCAPE, "").replace(/^_(?!_)/, "").replace(/([^_])_$/, "$1");
    if (!stem) return null;
  }
  if (FRAMEWORK.has(stem)) return null;
  const suffix = [...ignoreSuffixes].sort((a, b) => b.length - a.length).find((s) => stem.endsWith(s) && stem.length > s.length);
  return suffix ? stem.slice(0, -suffix.length) : stem;
}

/** The name in the style, when it can be told: words split at "-", "_" and changes of case, letters and digits only. */
function suggest(stem: string, style: NamingStyle): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(stem)) return null;
  const words = stem
    .split(/[-_]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const name = STYLES[style].join(words);
  return STYLES[style].test.test(name) ? name : null;
}

/** Whether a file name breaks a naming rule, and the name it could have. */
export function namingProblem(file: string, rule: Pick<Naming, "style" | "ignoreSuffixes">): { stem: string; suggestion: string | null } | null {
  const stem = nameStem(file, rule.ignoreSuffixes);
  if (stem === null || STYLES[rule.style].test.test(stem)) return null;
  return { stem, suggestion: suggest(stem, rule.style) };
}

export interface ConventionInput {
  arch: Architecture;
  /** The source files to judge, with the module each belongs to. */
  files: string[];
  owner: (file: string) => string | undefined;
  /** Dependencies on every file of the modules that have public_api rules, from fileDependencies. */
  dependencies: () => Dependency[];
}

type Found = Omit<Violation, "id"> & { key: string };

/** Violations of naming, placement and public_api rules. Each id appears once, at the lowest line, whatever the order of the files. */
export function conventionViolations({ arch, files, owner, dependencies }: ConventionInput): Found[] {
  const out: Found[] = [];
  const rules = arch.rules;
  // Appended one by one: push(...list) passes each item as an argument, which overflows the stack for a large repo.
  for (const r of rules) {
    if (r.type === "naming") naming(r, files, owner, out);
    if (r.type === "placement") placement(arch, r, files, owner, out);
  }
  const api = rules.filter((r): r is PublicApi => r.type === "public_api");
  if (api.length) publicApi(api, dependencies(), out);
  return out;
}

function naming(r: Naming, files: string[], owner: ConventionInput["owner"], out: Found[]): void {
  const every = r.module === EVERY_MODULE;
  const matches = compileGlob(r.files);
  for (const file of files) {
    if (!every && owner(file) !== r.module) continue;
    if (!matches(file)) continue;
    const problem = namingProblem(file, r);
    if (!problem) continue;
    const style = styleName(r.style);
    out.push({
      ruleId: r.id,
      severity: r.severity,
      file,
      key: file,
      message: `${file} is named "${problem.stem}", which is not ${style}.`,
      fix: problem.suggestion ? `Rename it to ${style}, for example "${problem.suggestion}".` : `Rename it to ${style}, with letters a to z and digits only.`,
      rationale: r.rationale,
    });
  }
}

function placement(arch: Architecture, r: Placement, files: string[], owner: ConventionInput["owner"], out: Found[]): void {
  const allowed = new Set(r.modules);
  const where = r.modules.map((m) => `${m} (${arch.modules[m].paths.join(", ")})`).join(", ");
  const matches = compileGlob(r.files);
  for (const file of files) {
    if (!matches(file)) continue;
    const mod = owner(file);
    if (mod !== undefined && allowed.has(mod)) continue;
    out.push({
      ruleId: r.id,
      severity: r.severity,
      file,
      key: file,
      message: `${file} is ${mod === undefined ? "outside every module" : `in module "${mod}"`}, but files like it belong in ${r.modules.length > 1 ? "one of the modules" : "module"} ${r.modules.join(", ")}.`,
      fix: `Move it into ${where}.`,
      rationale: r.rationale,
    });
  }
}

/**
 * How many files of a module one import through a file outside the modules is reported for, one violation each. Past
 * that, the import is one violation for the module, whose id names the module instead of a file. A barrel that
 * re-exports hundreds of internal files, imported by hundreds of files, would otherwise give importers times files
 * violations, and a baseline of that size. Which files there are never decides which ids exist, so deleting one of
 * them cannot bring up a new id, and a new file is a new id as long as the import is reported per file.
 */
export const MAX_REACHED = 20;

function publicApi(rules: PublicApi[], deps: Dependency[], out: Found[]): void {
  for (const r of rules) {
    const entry = new Map<string, boolean>();
    const matchesEntry = compileGlobs(r.entries);
    const isEntry = (file: string) => {
      let yes = entry.get(file);
      if (yes === undefined) entry.set(file, (yes = matchesEntry(file)));
      return yes;
    };
    // The files an import through one outside file reaches that are no entry, in path order.
    const internal = new Map<readonly string[], string[]>();
    const notEntries = (reached: readonly string[]) => {
      let hit = internal.get(reached);
      if (!hit) internal.set(reached, (hit = reached.filter((f) => !isEntry(f))));
      return hit;
    };
    // One import per (from, to) or (from, via), at its lowest line, whatever the order of the edges.
    const imports = new Map<string, Dependency>();
    for (const d of deps) {
      if (d.toMod !== r.module || !d.to) continue;
      if (!d.via && isEntry(d.to)) continue;
      // A path cannot hold "\0", so a direct import and one through another file never share a key.
      const key = d.via ? `${d.from}\0${d.via}` : `${d.from}->${d.to}`;
      const old = imports.get(key);
      if (old && (old.line ?? Infinity) <= (d.line ?? Infinity)) continue;
      imports.set(key, d);
    }
    const fix = (d: Dependency) =>
      `Import it through ${r.entries.length > 1 ? "one of the entries" : "the entry"} of "${r.module}": ${r.entries.join(", ")}.${d.via ? ` Or assign ${d.via} to a module so its own imports are checked.` : ""}`;
    for (const d of imports.values()) {
      const base = { ruleId: r.id, severity: r.severity, file: d.from, line: d.line, fix: fix(d), rationale: r.rationale };
      if (!d.via) {
        out.push({ ...base, key: `${d.from}->${d.to}`, message: `${d.from} (${d.fromMod}) imports ${d.to}. It is not a public entry of module "${r.module}".` });
        continue;
      }
      const files = notEntries(d.reached ?? [d.to!]);
      const through = ` through ${d.via}, which is outside every module`;
      const whole = `${d.from}->${d.via}=>${r.module}`;
      if (files.length > MAX_REACHED) {
        out.push({
          ...base,
          key: whole,
          message: `${d.from} (${d.fromMod}) reaches ${files.length} files of module "${r.module}"${through}, and none of them is a public entry, for example ${files.slice(0, 3).join(", ")}.`,
        });
        continue;
      }
      for (const to of files) {
        out.push({ ...base, key: `${d.from}->${d.via}=>${to}`, acceptedAs: `${r.id}:${whole}`, message: `${d.from} (${d.fromMod}) reaches ${to}${through}. It is not a public entry of module "${r.module}".` });
      }
    }
  }
}
