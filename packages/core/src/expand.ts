import { compileGlob } from "./glob.js";
import type { ManyImports } from "./imports.js";

/** More files than this from one expression are not all followed. */
export const MAX_TARGETS = 1000;
const MAX_ALTERNATIVES = 64;
const MAX_GLOB = 512;
/** Folders that "/" may stand for. */
const MAX_ROOTS = 20;
/** What looking for a prefix among the files costs. */
const LOOKUP = 200;

/** What is left to spend on a whole project, so that many expressions over many files stay affordable. */
export interface ExpandBudget {
  targets: number;
  work: number;
}

export const newBudget = (): ExpandBudget => ({ targets: 100_000, work: 200_000_000 });

export interface Expansion {
  targets: string[];
  /** Module names that are packages, or begin with one. */
  packages: string[];
  /** Not everything it loads is known. */
  partial: boolean;
}

export interface ExpandContext {
  /** Every file, sorted. */
  files: string[];
  from: string;
  /** Folders that a module name may be relative to, as the beginning of a path, or null when it is a package. */
  bases: (specifier: string) => string[] | null;
  budget: ExpandBudget;
}

/** The files that begin with a prefix. */
function* under(files: string[], prefix: string): Generator<string> {
  let lo = 0;
  let hi = files.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (files[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  for (; lo < files.length && files[lo].startsWith(prefix); lo++) yield files[lo];
}

/** What a file can be imported as: itself, without its extension, with that of its output, or as its folder. */
function namesOf(file: string): string[] {
  const bare = file.replace(/\.[^./]+$/, "");
  const names = [file, bare, `${bare}.js`, `${bare}.mjs`, `${bare}.cjs`];
  if (bare.endsWith("/index")) names.push(bare.slice(0, -"/index".length));
  return names;
}

/** Whether a name consists of the parts, with anything in between. */
function fits(name: string, parts: string[]): boolean {
  const last = parts[parts.length - 1];
  if (!name.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) {
    const found = name.indexOf(parts[i], at);
    if (found === -1) return false;
    at = found + parts[i].length;
  }
  return name.length - last.length >= at && name.endsWith(last);
}

/** The first pair of braces with a comma and no other braces in it. */
function braces(glob: string): [number, number] | null {
  let open = -1;
  let comma = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "{") [open, comma] = [i, false];
    else if (c === ",") comma = true;
    else if (c === "}") {
      if (open !== -1 && comma) return [open, i];
      open = -1;
    }
  }
  return null;
}

/** "a{b,c}" without its braces. Null when there are too many ways. */
function alternatives(glob: string): string[] | null {
  let out = [glob];
  for (;;) {
    const next: string[] = [];
    let changed = false;
    for (const g of out) {
      const pair = braces(g);
      if (!pair) next.push(g);
      else {
        changed = true;
        for (const part of g.slice(pair[0] + 1, pair[1]).split(",")) next.push(g.slice(0, pair[0]) + part + g.slice(pair[1] + 1));
      }
      if (next.length > MAX_ALTERNATIVES) return null;
    }
    out = next;
    if (!changed) return out;
  }
}

/** Parts of a glob that are not supported here, as ones that match more. */
function widen(glob: string): string {
  return glob.replace(/\[[^\]/]*\]/g, "?").replace(/[@!+*?]?\([^()/]*\)/g, "*").replace(/\{[^{}/]*\}/g, "*").replace(/\\/g, "?");
}

/** How many ways to match matchesGlob may have to follow at once. */
const cost = (glob: string) => 1 + (glob.match(/\*/g)?.length ?? 0);

/** A path without "." and "..", which is how they are taken out of a glob as well. Null when it leads out of the project. */
function plain(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

/** A part of a path that is empty, "." or "..". */
const ODD_PART = /(?:^|\/)(?:\.{1,2})?(?:\/|$)/;

interface GlobPart {
  not: boolean;
  /** What it begins with, which stands for one of several folders. Both lists are the same length for every glob of that kind. */
  kind: "root" | "alias" | "path";
  bases: string[];
  rest: string;
}

function expandGlobs(patterns: Array<string | null>, ctx: ExpandContext): Expansion {
  const found = new Set<string>();
  const { budget, files, from } = ctx;
  const parts: GlobPart[] = [];
  let partial = false;
  const roots = [""];
  for (let i = from.indexOf("/"); i !== -1; i = from.indexOf("/", i + 1)) roots.push(from.slice(0, i + 1));
  // Relative to the root of an app, which is the repository or a folder that this file is in.
  const near = roots.slice(0, MAX_ROOTS);

  for (const pattern of patterns) {
    const not = pattern?.startsWith("!") ?? false;
    const glob = not ? pattern!.slice(1) : pattern;
    const alts = glob === null || glob.length > MAX_GLOB ? null : alternatives(glob);
    // widen() takes the square of the length for what is written to be slow.
    for (const alt of alts ?? []) budget.work -= alt.length ** 2 + LOOKUP;
    if (!alts || budget.work < 0) {
      budget.work -= Math.min(glob?.length ?? 0, MAX_GLOB) * MAX_ALTERNATIVES;
      partial = true;
      continue;
    }
    // Which parts ".." takes away is certain only where nothing else is in the way.
    const special = glob!.search(/[[({]/);
    if (!not && special !== -1 && ODD_PART.test(glob!.slice(special))) partial = true;
    for (const alt of alts) {
      const wide = widen(alt);
      const star = wide.search(/[*?]/);
      if (!not && /[[\](){}]/.test(wide)) partial = true; // it means something that widen() does not know
      const odd = ODD_PART.test(wide.slice(wide.lastIndexOf("/", star === -1 ? wide.length : star) + 1));
      if (not) {
        // Leave out no more than it does: "**" goes into folders only where it stands alone.
        if (wide !== alt || odd || /[^/]\*\*|\*\*[^/]/.test(wide)) continue;
      } else if (wide.endsWith("/")) partial = true;

      if (wide.startsWith("/")) {
        if (!not && roots.length > near.length) partial = true;
        parts.push({ not, kind: "root", bases: near, rest: wide.slice(1) });
      } else if (wide.startsWith("**")) parts.push({ not, kind: "path", bases: [""], rest: wide });
      else {
        const cut = wide.lastIndexOf("/", star === -1 ? wide.length : star) + 1;
        const bases = cut > 0 ? ctx.bases(wide.slice(0, cut)) : null;
        if (bases) parts.push({ not, kind: bases.length > 1 ? "alias" : "path", bases, rest: wide.slice(cut) });
        else if (!not) partial = true;
      }
    }
  }

  // What is included and what is left out have to agree on the folder that "/" or an alias stands for.
  const ways = (kind: GlobPart["kind"]) => Math.max(1, ...parts.filter((p) => p.kind === kind).map((p) => p.bases.length));
  const [rootWays, aliasWays] = [ways("root"), ways("alias")];
  const done = new Set<string>();
  for (let way = 0; way < rootWays * aliasWays; way++) {
    const globs = (not: boolean): string[] => {
      const out: string[] = [];
      for (const p of parts) {
        if (p.not !== not) continue;
        const base = p.kind === "root" ? p.bases[way % rootWays] : p.kind === "alias" ? p.bases[Math.floor(way / rootWays)] : p.bases[0];
        const path = base === undefined ? null : ODD_PART.test(p.rest) ? plain(base + p.rest) : base + p.rest;
        budget.work -= LOOKUP;
        if (path !== null) out.push(path);
      }
      return out;
    };
    const without = globs(true).map((g) => ({ cost: cost(g), matches: compileGlob(g) }));
    for (const glob of globs(false)) {
      const key = without.length ? "" : glob;
      if (key && done.has(key)) continue;
      done.add(key);
      if (budget.work < 0) return { targets: [...found], packages: [], partial: true };
      const star = glob.search(/[*?]/);
      const matches = compileGlob(glob);
      for (const file of under(files, star === -1 ? glob : glob.slice(0, star))) {
        budget.work -= cost(glob) * file.length;
        if (budget.work < 0) return { targets: [...found], packages: [], partial: true };
        if (file === from || found.has(file) || !matches(file)) continue;
        // Wildcards do not match names that start with a dot everywhere.
        const hidden = /(?:^|\/)\./.test(file);
        if (!hidden && without.some((g) => ((budget.work -= g.cost * file.length), g.matches(file)))) continue;
        found.add(file);
      }
    }
  }
  return { targets: [...found], packages: [], partial };
}

/** Whether known parts of a name leave the folder it starts with, or stand for another one than what is written. */
function leaves(parts: string[]): boolean {
  return parts.some((part, i) => {
    const names = part.split("/");
    const inner = names.slice(1, -1);
    const last = names[names.length - 1];
    if (i === 0) return last === "." || last === "..";
    return [".", ".."].includes(names[0]) || inner.some((n) => n === "" || n === "." || n === "..") || (names.length > 1 && (last === "." || last === ".." || (last === "" && i === parts.length - 1)));
  });
}

function expandTemplate(all: string[], ctx: ExpandContext): Expansion {
  // What is asked of a module, as in "./a.js?url", is not a part of its name.
  const query = all.findIndex((part) => /[?#]/.test(part));
  const parts = query === -1 ? all : [...all.slice(0, query), all[query].replace(/[?#].*$/s, "")];
  const [first] = parts;
  const slash = first.lastIndexOf("/");
  const roots = slash === -1 ? null : ctx.bases(first.slice(0, slash + 1));
  // A URL makes something else of these.
  const partial = leaves(parts) || parts.some((p) => /[%\\\t\n\r]/.test(p));
  if (!roots) {
    // The name of a package can be complete before the first unknown part.
    const pkg = /^(?:@[^/:!]+\/)?[^./:#~@!][^/:!]*\//.exec(first);
    return { targets: [], packages: pkg ? [first] : [], partial: partial || !pkg || ODD_PART.test(first.slice(0, -1)) };
  }
  const found = new Set<string>();
  for (const root of roots) {
    const whole = [root + first.slice(slash + 1), ...parts.slice(1)];
    for (const file of under(ctx.files, whole[0])) {
      ctx.budget.work -= 6 * file.length;
      if (ctx.budget.work < 0) return { targets: [...found], packages: [], partial: true };
      if (file !== ctx.from && namesOf(file).some((n) => fits(n, whole))) found.add(file);
    }
  }
  return { targets: [...found], packages: [], partial };
}

/** The endings of a regular expression such as /\.(js|ts)$/, or null when it is of another form. */
function endings(regex: string): string[] | null {
  const m = /^\/(?:\^\\\.\\\/)?(?:\.\*)?((?:\\[./-]|[\w-])*)(?:\((?:\?:)?([\w|]+)\))?(x\?)?\$\/$/.exec(regex);
  if (!m || /^[\w-]/.test(m[1].replace(/\\[./-]/g, "."))) return null;
  const start = m[1].replace(/\\/g, "");
  return (m[2] ?? "").split("|").flatMap((e) => (m[3] ? [`${start}${e}`, `${start}${e}x`] : [`${start}${e}`]));
}

function expandContext(dir: string, recursive: boolean, regex: string, ctx: ExpandContext): Expansion {
  const roots = ctx.bases(dir.endsWith("/") ? dir : `${dir}/`);
  if (!roots) return { targets: [], packages: [], partial: true };
  const ends = endings(regex);
  const found = new Set<string>();
  for (const root of roots) {
    for (const file of under(ctx.files, root)) {
      ctx.budget.work -= file.length;
      if (ctx.budget.work < 0) return { targets: [...found], packages: [], partial: true };
      if (file === ctx.from || (!recursive && file.includes("/", root.length))) continue;
      // It also matches names without their extension, and folders by their index file.
      const bare = file.replace(/\.[^./]+$/, "");
      const names = [file, bare, bare.replace(/\/index$/, "")];
      if (!ends || ends.some((e) => names.some((n) => n.endsWith(e)))) found.add(file);
    }
  }
  return { targets: [...found], packages: [], partial: false };
}

/** The files that an expression loads, as far as that can be told without running it. */
export function expandImports(many: ManyImports, ctx: ExpandContext): Expansion {
  if (ctx.budget.targets <= 0 || ctx.budget.work < 0) return { targets: [], packages: [], partial: true };
  const all =
    many.type === "glob" ? expandGlobs(many.patterns, ctx)
    : many.type === "template" ? expandTemplate(many.parts, ctx)
    : expandContext(many.dir, many.recursive, many.regex, ctx);
  const max = Math.min(MAX_TARGETS, ctx.budget.targets);
  const targets = all.targets.sort().slice(0, max);
  ctx.budget.targets -= targets.length;
  return { ...all, targets, partial: all.partial || all.targets.length > max };
}
