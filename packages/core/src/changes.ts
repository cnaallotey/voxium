import { ARCH_FILE_PATH, BASELINE_FILE_PATH, isBlockLabel, parseBaseline, type ProtectedContents } from "./protect.js";
import { styleName } from "./conventions.js";
import { compileGlob } from "./glob.js";
import { EVERY_MODULE, validateArchitecture } from "./schema.js";
import type { Architecture, Exception, Override, Rule } from "./types.js";

const MAX_LINES = 60;

/** One line of readable text, without invisible or direction changing characters. Names and reasons come from the pull request, so they cannot be trusted to be tidy. */
function oneLine(value: unknown, max = 300): string {
  const s = (typeof value === "string" ? value : (JSON.stringify(value) ?? "nothing")).replace(/[\s\p{C}\p{Z}]+/gu, " ").trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function parse(text: string): Architecture | null {
  try {
    const arch = JSON.parse(text) as Architecture;
    return validateArchitecture(arch).ok ? arch : null;
  } catch {
    return null;
  }
}

/** Every field that differs, so no edit goes unmentioned. */
function fieldChanges(before: object, after: object, skip: string[] = []): string[] {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => !skip.includes(k) && !same(a[k], b[k]))
    .map((k) => `${oneLine(k, 40)} from ${oneLine(a[k], 120)} to ${oneLine(b[k], 120)}`);
}

/** Lists of the newer rule fields, said one item to a line instead of cut short. */
const LISTS = { entries: "entry", modules: "module", except: "module it leaves out", ignoreSuffixes: "ending it leaves out" } as const;
const PLURAL: Record<keyof typeof LISTS, string> = { entries: "entries", modules: "modules", except: "modules it leaves out", ignoreSuffixes: "endings it leaves out" };
/** More items than this that a list of a rule now has are also said together in one line. */
const FEW = 3;
/** Texts of the newer rule fields, which can be long globs. */
const WHOLE = ["files"];

/**
 * Marks a line that says one item of a list of a new rule, or one that a list no longer has, which only make the rules
 * stricter. When there are more lines than are shown, those are left out first, so that a long list cannot push a lower
 * severity, an exception or an ignored path out of sight. The markers are control characters, which oneLine takes out
 * of everything a pull request wrote, so no other line can carry them.
 */
const ITEM = "\u0001";
/** Marks a line that says one item a list of a rule now has. Those are said together too, so they go next. */
const ADDED = "\u0002";
/**
 * Marks what weakens the rules most: a lower severity, a rule, module or alias that goes, a rule whose type or other
 * settings change (which can turn it into another rule under the same id), modules whose paths or order change, the
 * layers in another order, an exception, an ignored path, accepted debt, the rules file removed. These are kept before
 * any other line.
 */
const KEY = "\u0003";
/**
 * Marks what an organization rule or an override does, which goes before even KEY lines: an override can turn a rule off
 * in one line among many. Their number is bounded (MAX_ORG_RULES, MAX_OVERRIDES), so that they always fit.
 */
const TOP = "\u0004";
/** Fields of a rule that only say what it is for. A change to any other one changes what the rule checks. */
const PROSE = ["description", "rationale"];

/** What each wildcard of a module's path stands for in the made up files of the module that entries are tried on. */
const FILLS = {
  dirs: ["", "lib/", "a/b/", "", "x_y/", "index/", "c/", ""],
  any: ["index.ts", "lib/util.ts", "a/b/c.js", "x.vue", "y-z.mjs", "a/types.d.ts", "c/view.tsx", "README.md"],
  star: ["index.ts", "util", "a.tsx", "b.js", "x.vue", "c-d.d.ts", "e.ts", "f_g.jsx"],
  one: ["a", "B", "1", "_", "x", "-", "z", "q"],
};

/** At most this many made up files of a module, each of at most this many characters. */
const MADE_UP = 16;
const MADE_UP_LENGTH = 200;
/**
 * How much matching entries against made up files may cost in one description of a change, in characters of the entry
 * times characters of the file (what matching may take at most), so that rules full of long entries cannot slow it.
 * Once it is used up, the rest are ranked as if they matched none.
 */
const RANK_WORK = 20_000_000;
interface Budget {
  left: number;
}

/**
 * Files a module's paths match, made up by putting a few different names, folders and endings in place of their
 * wildcards, so that an entry that takes in many of them can be told from one that only looks as if it could.
 */
function madeUpFiles(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    for (let k = 0; k < FILLS.any.length; k++) {
      let f = "";
      for (let i = 0; i < p.length; i++) {
        if (p.startsWith("**/", i)) [f, i] = [f + FILLS.dirs[k], i + 2];
        else if (p.startsWith("**", i)) [f, i] = [f + FILLS.any[k], i + 1];
        else if (p[i] === "*") f += FILLS.star[k];
        else if (p[i] === "?") f += FILLS.one[k];
        else f += p[i];
      }
      if (f.length <= MADE_UP_LENGTH) out.add(f);
      if (out.size === MADE_UP) return [...out];
    }
  }
  return [...out];
}

/**
 * Items a list now has, those that can take in the most first. With the made up files of a module (for the entries of
 * its public_api rule), those that match more of them go first, so that "src/**" leads however many globs that start
 * with a wildcard and match nothing are put before it. Then those with a wildcard before those without, then the less
 * that comes before the first wildcard (or the shorter the item), so that an ending ".ts" leads the few that a summary
 * line names, wherever the change put it.
 */
function widestFirst(items: string[], files: string[] = [], budget: Budget = { left: 0 }): string[] {
  const takesIn = (x: string) => {
    const matches = compileGlob(x);
    let n = 0;
    for (const f of files) {
      if (budget.left < x.length * f.length) break;
      budget.left -= x.length * f.length;
      if (matches(f)) n++;
    }
    return n;
  };
  const reach = (x: string) => {
    const at = x.search(/[*?]/);
    return [-takesIn(x), at < 0 ? 1 : 0, at < 0 ? x.length : at, x.length];
  };
  return items
    .map((x, i) => ({ x, i, r: reach(x) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.r[3] - b.r[3] || a.i - b.i)
    .map(({ x }) => x);
}

const list = (r: Rule, key: keyof typeof LISTS): string[] => {
  const value = (r as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.map(String) : [];
};

/** What a rule of a newer type does, beyond its description, so that each of its fields is seen when it is added. */
function ruleDetails(r: Rule): string[] {
  const id = oneLine(r.id, 60);
  const items = (key: keyof typeof LISTS, what: string) => list(r, key).map((x) => `${ITEM}Rule ${id} ${what} ${label(x, 200)}`);
  if (r.type === "naming") {
    const where = r.module === EVERY_MODULE ? "in every file" : `in module ${oneLine(r.module, 60)}`;
    return [`Rule ${id} wants ${styleName(r.style)} names for files matching ${label(r.files, 600)} ${where}`, ...items("ignoreSuffixes", "leaves out the ending")];
  }
  if (r.type === "placement") return [`Rule ${id} wants files matching ${label(r.files, 600)} in the modules it names`, ...items("modules", "allows module")];
  if (r.type === "public_api") return [`Rule ${id} lets other modules import ${oneLine(r.module, 60)} only through its entries`, ...items("entries", "has the entry")];
  if (r.type === "deny_external" && r.module === EVERY_MODULE) return [`Rule ${id} applies to every module`, ...items("except", "leaves out module")];
  return [];
}

/** Every field of a rule that differs, with lists said item by item. */
function ruleChanges(was: Rule, r: Rule, modules: Architecture["modules"], budget: Budget): string[] {
  const id = oneLine(r.id, 60);
  const skip = [...Object.keys(LISTS), ...WHOLE];
  const out: string[] = [];
  const fields = fieldChanges(was, r, skip);
  const checks = fieldChanges(was, r, [...skip, ...PROSE]).length > 0;
  if (fields.length) out.push(`${checks ? KEY : ""}Changes rule ${id}: ${fields.join(", ")}`);
  for (const key of WHOLE) {
    const [a, b] = [(was as Record<string, unknown>)[key], (r as Record<string, unknown>)[key]];
    if (!same(a, b)) out.push(`${KEY}Changes rule ${id}: ${key} from ${a === undefined ? "nothing" : label(String(a), 600)} to ${b === undefined ? "nothing" : label(String(b), 600)}`);
  }
  for (const key of Object.keys(LISTS) as Array<keyof typeof LISTS>) {
    const [a, b] = [list(was, key), list(r, key)];
    // An item a list no longer has makes the rule stricter, one it now has allows more (an entry, a module, an ending).
    for (const x of a) if (!b.includes(x)) out.push(`${ITEM}Changes rule ${id}: no longer has the ${LISTS[key]} ${label(x, 200)}`);
    // Each of a few items is kept with what weakens the rules (an entry "src/**" turns a public_api rule off); many are
    // kept as one line that says how many, so that one long list cannot push the other weakening lines out of sight.
    const added = b.filter((x) => !a.includes(x));
    if (added.length > FEW) {
      const wild = added.filter((x) => /[*?]/.test(x)).length;
      const files = r.type === "public_api" && key === "entries" && Object.hasOwn(modules, r.module) ? madeUpFiles(modules[r.module].paths) : [];
      const among = widestFirst(added, files, budget).slice(0, FEW).map((x) => label(x, 60)).join(", ");
      out.push(`${KEY}Changes rule ${id}: now has ${added.length} more ${PLURAL[key]}${wild ? ` (${wild} with wildcards)` : ""}, among them ${among}`);
    }
    for (const x of added) out.push(`${added.length > FEW ? ADDED : KEY}Changes rule ${id}: now has the ${LISTS[key]} ${label(x, 200)}`);
    if (a.length === b.length && a.every((x) => b.includes(x)) && !same(a, b)) out.push(`Changes rule ${id}: the order of ${key}`);
  }
  return out.length ? out : [`Changes rule ${id}: field order only`];
}

function describeRules(before: Rule[], after: Rule[], modules: Architecture["modules"]): string[] {
  const budget = { left: RANK_WORK };
  const out: string[] = [];
  const old = new Map(before.map((r) => [r.id, r]));
  const now = new Map(after.map((r) => [r.id, r]));
  for (const r of before) {
    if (now.has(r.id)) continue;
    const what = r.org ? `organization rule ${oneLine(r.id, 60)} (version ${r.org.version})` : `rule ${oneLine(r.id, 60)}`;
    out.push(`${r.org ? TOP : KEY}Removes ${what} [${r.severity}]: ${oneLine(r.description)}`);
  }
  for (const r of after) {
    const was = old.get(r.id);
    if (!was) {
      out.push(r.org ? `${TOP}Adds organization rule ${oneLine(r.id, 60)} from version ${r.org.version} [${r.severity}]: ${oneLine(r.description)}` : `Adds rule ${oneLine(r.id, 60)} [${r.severity}]: ${oneLine(r.description)}`);
      for (const line of ruleDetails(r)) out.push(line);
    } else if (!same(was, r)) {
      if (was.type !== r.type) out.push(`${KEY}Changes the type of rule ${oneLine(r.id, 60)} from ${was.type} to ${r.type}, so debt accepted under its id now accepts violations of the new type`);
      const line = orgLine(was, r);
      if (line) out.push(line);
      const { org: _a, ...a } = was;
      const { org: _b, ...b } = r;
      if (!same(a, b)) for (const l of ruleChanges(a as Rule, b as Rule, modules, budget)) out.push(l);
    }
  }
  return out;
}

/** What a change does to whether a rule is an organization rule, and to which version of it. */
function orgLine(was: Rule, r: Rule): string | null {
  const id = oneLine(r.id, 60);
  if (!was.org && r.org) return `${TOP}Marks rule ${id} as an organization rule (version ${r.org.version}), so that an override can turn it off or make it a warning`;
  if (was.org && !r.org) return `Makes organization rule ${id} a rule of this repository only, which no override can change`;
  if (!was.org || !r.org) return null;
  const { org: _a, ...a } = was;
  const { org: _b, ...b } = r;
  const content = !same(a, b);
  if (was.org.version === r.org.version) return content ? `${TOP}Changes organization rule ${id}, which no longer matches version ${r.org.version} of the organization's rule set` : null;
  return `${TOP}Updates organization rule ${id} from version ${was.org.version} to version ${r.org.version}${content ? "" : ", which checks the same"}`;
}

function describeArchitecture(before: Architecture, after: Architecture): string[] {
  const out: string[] = [];
  const mods = new Set([...Object.keys(before.modules), ...Object.keys(after.modules)]);
  // A file belongs to the first module whose paths match it, so a new module placed before one that exists can take its
  // files away from it, and with them the rules that apply to them.
  const names = Object.keys(after.modules);
  const kept = names.map((m) => Object.hasOwn(before.modules, m));
  const ahead = names.filter((m, i) => !kept[i] && kept.indexOf(true, i) > i);
  if (ahead.length > FEW) {
    out.push(`${KEY}Adds ${ahead.length} modules before modules that exist, which can take their files: ${ahead.slice(0, FEW).map((m) => oneLine(m, 60)).join(", ")} and more`);
  }
  for (const m of mods) {
    const a = Object.hasOwn(before.modules, m) ? before.modules[m] : undefined;
    const b = Object.hasOwn(after.modules, m) ? after.modules[m] : undefined;
    const first = ahead.includes(m);
    if (!a) {
      const where = first ? ", before modules that exist, so it can take their files" : "";
      out.push(`${first && ahead.length <= FEW ? KEY : ""}Adds module ${oneLine(m, 60)} (${oneLine(b!.paths.join(", "))})${where}`);
    } else if (!b) out.push(`${KEY}Removes module ${oneLine(m, 60)} (${oneLine(a.paths.join(", "))}), so its files are no longer checked as a module`);
    else if (!same(a, b)) out.push(`${fieldChanges(a, b).length ? KEY : ""}Changes module ${oneLine(m, 60)}: ${fieldChanges(a, b).join(", ") || "field order only"}`);
  }
  const order = (x: Architecture) => Object.keys(x.modules).filter((m) => Object.hasOwn(before.modules, m) && Object.hasOwn(after.modules, m));
  if (!same(order(before), order(after))) out.push(`${KEY}Changes which module wins when paths overlap: ${oneLine(order(after).join(", "))}`);
  if (!same(before.layers, after.layers)) {
    out.push(`${KEY}Changes the layers from ${oneLine(before.layers.join(" > "))} to ${oneLine(after.layers.join(" > "))}`);
  }
  for (const line of describeRules(before.rules, after.rules, after.modules)) out.push(line);
  const text = (e: Exception) =>
    `exception to ${oneLine(e.rule, 60)} for ${oneLine(e.file, 120)} until ${oneLine(e.expires, 20)} (owner ${oneLine(e.owner, 60)}: ${oneLine(e.reason)})`;
  const list = (x: Architecture) => x.exceptions.map((e) => JSON.stringify(e));
  const [oldEx, newEx] = [list(before), list(after)];
  before.exceptions.forEach((e, i) => newEx.includes(oldEx[i]) || out.push(`Removes ${text(e)}`));
  after.exceptions.forEach((e, i) => oldEx.includes(newEx[i]) || out.push(`${KEY}Adds ${text(e)}`));
  const action = (o: Override) => (o.action === "disable" ? "turns it off" : "makes it a warning");
  const oldOv = new Map((before.overrides ?? []).map((o) => [o.rule, o]));
  const newOv = new Map((after.overrides ?? []).map((o) => [o.rule, o]));
  for (const [rule, o] of newOv) {
    if (same(oldOv.get(rule), o)) continue;
    out.push(`${TOP}Overrides organization rule ${oneLine(rule, 60)}: ${action(o)} until ${oneLine(o.expires, 20)} (owner ${oneLine(o.owner, 60)}: ${oneLine(o.reason)})`);
  }
  for (const rule of oldOv.keys()) {
    if (newOv.has(rule)) continue;
    const stays = after.rules.some((r) => r.id === rule);
    out.push(`Removes the override of organization rule ${oneLine(rule, 60)}${stays ? ", which is enforced again" : ", with the rule"}`);
  }
  const [oldIg, newIg] = [before.ignore ?? [], after.ignore ?? []];
  for (const g of newIg) if (!oldIg.includes(g)) out.push(`${KEY}Stops checking ${oneLine(g, 120)}`);
  for (const g of oldIg) if (!newIg.includes(g)) out.push(`Starts checking ${oneLine(g, 120)} again`);
  out.push(...describeAliases(before.aliases ?? {}, after.aliases ?? {}));
  const [oldSet, newSet] = [before.meta?.orgRules, after.meta?.orgRules];
  if (!same(oldSet, newSet)) {
    out.push(newSet ? `Takes its organization rules from version ${newSet.version} of the rule set of ${oneLine(newSet.org, 100)}` : "No longer names an organization rule set");
  }
  const handled = ["modules", "layers", "rules", "exceptions", "ignore", "aliases", "overrides", "meta"];
  for (const c of fieldChanges(before, after, handled)) out.push(`Changes ${c}`);
  const meta = (x: Architecture) => {
    const { orgRules: _, ...rest } = x.meta ?? {};
    return rest;
  };
  for (const c of fieldChanges(meta(before), meta(after))) out.push(`Changes meta: ${c}`);
  return out.length ? out : ["Changes only the order or formatting of voxium/architecture.json"];
}

/** A short hash of a text, to tell apart texts that are only shown in part. FNV-1a, so that the core needs no node:crypto. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** One line of text, cut to a length, with a hash of the whole when it is cut, so that two that begin alike still read apart. */
function label(value: string, max: number): string {
  const full = oneLine(value, Number.MAX_SAFE_INTEGER);
  return full.length > max ? `${full.slice(0, max - 14)}... (#${hash(value)})` : full;
}

/**
 * One line per alias, and per path an alias no longer or now also stands for, what is taken away first, so that none is
 * lost in a long line, at the end, or between two names that begin alike. When two different texts that are cut would
 * still read the same, as when their hashes collide, both are shown whole.
 */
function describeAliases(before: Record<string, string[]>, after: Record<string, string[]>): string[] {
  const shown = new Map<string, Set<string>>();
  aliasLines(before, after, (value, max) => {
    const l = label(value, max);
    let texts = shown.get(l);
    if (!texts) shown.set(l, (texts = new Set()));
    texts.add(value);
    return l;
  });
  const whole = new Set([...shown.values()].filter((texts) => texts.size > 1).flatMap((texts) => [...texts]));
  return aliasLines(before, after, (value, max) => (whole.has(value) ? oneLine(value, Number.MAX_SAFE_INTEGER) : label(value, max)));
}

function aliasLines(before: Record<string, string[]>, after: Record<string, string[]>, show: (value: string, max: number) => string): string[] {
  const removed: string[] = [];
  const added: string[] = [];
  const paths = (targets: string[]) => targets.map((t) => show(t, 120)).join(", ");
  for (const [name, targets] of Object.entries(before)) {
    if (!Object.hasOwn(after, name)) removed.push(`${KEY}Removes alias ${show(name, 80)} (was ${paths(targets)}), so imports by that name may no longer be seen`);
  }
  for (const [name, targets] of Object.entries(after)) {
    if (!Object.hasOwn(before, name)) {
      added.push(`Adds alias ${show(name, 80)} for ${paths(targets)}`);
      continue;
    }
    const was = before[name];
    if (same(was, targets)) continue;
    const gone = was.filter((t) => !targets.includes(t));
    const more = targets.filter((t) => !was.includes(t));
    for (const t of gone) removed.push(`Changes alias ${show(name, 80)}: it no longer stands for ${show(t, 200)}, so imports by that name may no longer be seen there`);
    for (const t of more) added.push(`Changes alias ${show(name, 80)}: it now also stands for ${show(t, 200)}`);
    if (!gone.length && !more.length) added.push(`Changes the order of the paths of alias ${show(name, 80)}, which decides the one TypeScript takes: ${paths(targets)}`);
  }
  return [...removed, ...added];
}

function describeBaseline(before: string | null, after: string | null): string[] {
  const [a, b] = [parseBaseline(before), parseBaseline(after)];
  if (!b) return ["Makes voxium/baseline.json unreadable, so no existing violation is accepted"];
  const old = new Set(a ?? []);
  const now = new Set(b);
  const added = [...now].filter((x) => !old.has(x));
  const gone = [...old].filter((x) => !now.has(x));
  const some = (ids: string[]) => ids.slice(0, 5).map((x) => oneLine(x, 120)).join("; ") + (ids.length > 5 ? `; and ${ids.length - 5} more` : "");
  return [
    ...(added.length ? [`${KEY}Accepts ${added.length} violation(s) as existing debt: ${some(added)}`] : []),
    ...(gone.length ? [`Stops accepting ${gone.length} violation(s): ${some(gone)}`] : []),
    ...(!added.length && !gone.length ? ["Changes only the formatting of voxium/baseline.json"] : []),
  ];
}

/**
 * What a change to the protected files does, in plain sentences for the person who approves it.
 * `changed` is the list from findProtectedChanges.
 */
export function describeRuleChanges(before: ProtectedContents, after: ProtectedContents, changed: string[]): string[] {
  const out: string[] = [];
  for (const p of changed) {
    const a = before[p] ?? null;
    const b = after[p] ?? null;
    if (p === ARCH_FILE_PATH) {
      if (b === null) out.push(`${KEY}Removes voxium/architecture.json. Voxium stops checking this repository`);
      else {
        const now = parse(b);
        const was = a === null ? null : parse(a);
        if (!now) out.push("Makes voxium/architecture.json invalid");
        else if (a === null) out.push(`Adds the architecture rules, with layers ${oneLine(now.layers.join(" > "))}`);
        else if (!was) out.push(`Replaces rules that were invalid, with layers ${oneLine(now.layers.join(" > "))}`);
        else out.push(...describeArchitecture(was, now));
      }
    } else if (p === BASELINE_FILE_PATH) {
      out.push(...describeBaseline(a, b));
    } else if (isBlockLabel(p)) {
      out.push(`${KEY}Changes or removes the Voxium block in ${p.slice(0, -" (Voxium block)".length)}, which tells coding agents the rules. Read it on GitHub`);
    } else {
      out.push(`${a === null ? "Adds" : b === null ? "Removes" : "Changes"} ${p}. Read it on GitHub`);
    }
  }
  return shorten(out);
}

/**
 * At most MAX_LINES lines, in their order. When some must go, lines marked ITEM go first, then those marked ADDED, then
 * unmarked ones, and those marked KEY last, so that what weakens the rules (a lower severity, a removal, a rule or module
 * that now checks something else, the layers in another order, an exception, an ignored path) is shown however long the
 * lists are.
 */
function shorten(lines: string[]): string[] {
  const rank = (line: string) => (line.startsWith(TOP) ? -1 : line.startsWith(KEY) ? 0 : line.startsWith(ADDED) ? 2 : line.startsWith(ITEM) ? 3 : 1);
  const plain = (line: string) => (rank(line) === 1 ? line : line.slice(1));
  if (lines.length <= MAX_LINES) return lines.map(plain);
  const order = lines.map((_, i) => i).sort((x, y) => rank(lines[x]) - rank(lines[y]) || x - y);
  const kept = new Set(order.slice(0, MAX_LINES));
  const out = lines.filter((_, i) => kept.has(i)).map(plain);
  const onlyItems = order.slice(MAX_LINES).every((i) => rank(lines[i]) >= 2);
  return [...out, `And ${lines.length - out.length} ${onlyItems ? "more items of lists" : "more"}. Read them on GitHub`];
}
