import { ARCH_FILE_PATH, BASELINE_FILE_PATH, parseBaseline, type ProtectedContents } from "./protect.js";
import { validateArchitecture } from "./schema.js";
import type { Architecture, Exception, Rule } from "./types.js";

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

function describeRules(before: Rule[], after: Rule[]): string[] {
  const out: string[] = [];
  const old = new Map(before.map((r) => [r.id, r]));
  const now = new Map(after.map((r) => [r.id, r]));
  for (const r of before) if (!now.has(r.id)) out.push(`Removes rule ${oneLine(r.id, 60)} [${r.severity}]: ${oneLine(r.description)}`);
  for (const r of after) {
    const was = old.get(r.id);
    if (!was) out.push(`Adds rule ${oneLine(r.id, 60)} [${r.severity}]: ${oneLine(r.description)}`);
    else if (!same(was, r)) out.push(`Changes rule ${oneLine(r.id, 60)}: ${fieldChanges(was, r).join(", ") || "field order only"}`);
  }
  return out;
}

function describeArchitecture(before: Architecture, after: Architecture): string[] {
  const out: string[] = [];
  const mods = new Set([...Object.keys(before.modules), ...Object.keys(after.modules)]);
  for (const m of mods) {
    const a = before.modules[m];
    const b = after.modules[m];
    if (!a) out.push(`Adds module ${oneLine(m, 60)} (${oneLine(b.paths.join(", "))})`);
    else if (!b) out.push(`Removes module ${oneLine(m, 60)} (${oneLine(a.paths.join(", "))}), so its files are no longer checked as a module`);
    else if (!same(a, b)) out.push(`Changes module ${oneLine(m, 60)}: ${fieldChanges(a, b).join(", ") || "field order only"}`);
  }
  // A file belongs to the first module whose paths match it.
  const order = (x: Architecture) => Object.keys(x.modules).filter((m) => m in before.modules && m in after.modules);
  if (!same(order(before), order(after))) out.push(`Changes which module wins when paths overlap: ${oneLine(order(after).join(", "))}`);
  if (!same(before.layers, after.layers)) {
    out.push(`Changes the layers from ${oneLine(before.layers.join(" > "))} to ${oneLine(after.layers.join(" > "))}`);
  }
  out.push(...describeRules(before.rules, after.rules));
  const text = (e: Exception) =>
    `exception to ${oneLine(e.rule, 60)} for ${oneLine(e.file, 120)} until ${oneLine(e.expires, 20)} (owner ${oneLine(e.owner, 60)}: ${oneLine(e.reason)})`;
  const list = (x: Architecture) => x.exceptions.map((e) => JSON.stringify(e));
  const [oldEx, newEx] = [list(before), list(after)];
  before.exceptions.forEach((e, i) => newEx.includes(oldEx[i]) || out.push(`Removes ${text(e)}`));
  after.exceptions.forEach((e, i) => oldEx.includes(newEx[i]) || out.push(`Adds ${text(e)}`));
  const [oldIg, newIg] = [before.ignore ?? [], after.ignore ?? []];
  for (const g of newIg) if (!oldIg.includes(g)) out.push(`Stops checking ${oneLine(g, 120)}`);
  for (const g of oldIg) if (!newIg.includes(g)) out.push(`Starts checking ${oneLine(g, 120)} again`);
  const handled = ["modules", "layers", "rules", "exceptions", "ignore"];
  for (const c of fieldChanges(before, after, handled)) out.push(`Changes ${c}`);
  return out.length ? out : ["Changes only the order or formatting of voxium/architecture.json"];
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
    ...(added.length ? [`Accepts ${added.length} violation(s) as existing debt: ${some(added)}`] : []),
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
      if (b === null) out.push("Removes voxium/architecture.json. Voxium stops checking this repository");
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
    } else {
      out.push(`${a === null ? "Adds" : b === null ? "Removes" : "Changes"} ${p}. Read it on GitHub`);
    }
  }
  return out.length > MAX_LINES ? [...out.slice(0, MAX_LINES), `And ${out.length - MAX_LINES} more. Read them on GitHub`] : out;
}
