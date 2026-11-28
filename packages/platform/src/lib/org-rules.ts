import { ARCH_FILE_PATH, describeRuleChanges, MAX_ORG_RULES, orgRuleErrors, type Architecture, type Rule } from "@voxium/core";
import { rulesHash } from "./proposals";
import type { OrgRuleDraftRow, OrgRuleSetRow } from "./store";

/** What a preview showed, so that saving saves that and nothing that changed since. */
export const draftHash = (d: Pick<OrgRuleDraftRow, "based_on" | "rules_json" | "note">) => rulesHash(JSON.stringify([d.based_on, d.rules_json, d.note]));

/** The largest rule set text a form may send. */
export const MAX_SET_TEXT = 64 * 1024;
/** The reason saved with a version. */
export const MAX_NOTE = 500;

export type ParsedSet = { ok: true; rules: Rule[]; text: string } | { ok: false; errors: string[] };

/** Rules of an organization's set as a person sent them: a JSON list, checked as organization rules. */
export function parseSetRules(input: unknown): ParsedSet {
  if (typeof input !== "string" || !input.trim()) return { ok: false, errors: ["Write the rules as a JSON list."] };
  if (input.length > MAX_SET_TEXT) return { ok: false, errors: [`The rules may be at most ${MAX_SET_TEXT / 1024} KB.`] };
  let rules: unknown;
  try {
    rules = JSON.parse(input);
  } catch {
    return { ok: false, errors: ["The rules are not valid JSON."] };
  }
  const errors = orgRuleErrors(rules);
  if (errors.length) return { ok: false, errors: errors.slice(0, 10) };
  // Stored as Voxium writes it, so that the same rules are the same text.
  return { ok: true, rules: rules as Rule[], text: `${JSON.stringify(rules, null, 2)}\n` };
}

/** A reason for a version: one line, nothing invisible. Null when there is none. */
export function cleanNote(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const note = input.replace(/[\s\p{C}\p{Z}]+/gu, " ").trim();
  return note.length >= 3 && note.length <= MAX_NOTE ? note : null;
}

export function setRules(row: Pick<OrgRuleSetRow, "rules_json"> | null): Rule[] {
  if (!row) return [];
  try {
    const rules = JSON.parse(row.rules_json) as unknown;
    return Array.isArray(rules) && rules.length <= MAX_ORG_RULES ? (rules as Rule[]) : [];
  } catch {
    return [];
  }
}

/** An architecture holding nothing but a set's rules as a repo takes them, to describe a change between versions. */
function holding(rules: Rule[], version: number): Architecture {
  const modules = new Set<string>();
  for (const r of rules) {
    if (r.type === "placement") r.modules.forEach((m) => modules.add(m));
    if (r.type === "deny_external") r.except?.forEach((m) => modules.add(m));
  }
  return {
    version: 1,
    modules: Object.fromEntries([...modules].map((m) => [m, { paths: [`${m}/**`] }])),
    layers: [],
    rules: rules.map((r) => ({ ...r, org: { version } }) as Rule),
    exceptions: [],
  };
}

/** What a new version does to the rules of the one before, in the sentences a change to a repo's rules gets. */
export function describeNewVersion(before: Rule[], beforeVersion: number, after: Rule[]): string[] {
  const text = (a: Architecture) => `${JSON.stringify(a)}\n`;
  const lines = describeRuleChanges({ [ARCH_FILE_PATH]: text(holding(before, beforeVersion)) }, { [ARCH_FILE_PATH]: text(holding(after, beforeVersion + 1)) }, [ARCH_FILE_PATH]);
  // Every rule moves to the new version; that it checks the same is what matters, and the modules are made up.
  return lines.filter((l) => !/^Updates organization rule .*, which checks the same$/.test(l) && !/^(Adds|Removes) module /.test(l));
}
