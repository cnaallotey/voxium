import { EVERY_MODULE, validateArchitecture } from "./schema.js";
import type { Architecture, Override, Rule } from "./types.js";

/** Rule ids of an organization start with this, so that they cannot be taken for a repo's own. */
export const ORG_PREFIX = "ORG-";
/**
 * At most this many organization rules in a set or in an architecture, and overrides in one. Every change to them is
 * named on a line of its own that is never cut from the description of a change, so their number is bounded.
 */
export const MAX_ORG_RULES = 20;
export const MAX_OVERRIDES = 15;
/** Text of an organization rule goes into the agent rules of every repo, so it is kept short. */
const MAX_DESCRIPTION = 500;
const MAX_RATIONALE = 2000;
const ORG_ID = /^ORG-[A-Za-z0-9_-]{1,60}$/;
/** Of an override, as of an exception: one line, nothing invisible. */
const TEXT = { owner: 100, reason: 2000 } as const;

/** Rule types that mean the same in every repo, because they name no module of their own. */
export const ORG_RULE_TYPES = ["deny_external", "max_file_lines", "no_cycles", "no_opaque_imports", "naming", "placement"] as const;

export interface OrgRuleSet {
  version: number;
  rules: Rule[];
}

/** Text that is one line without invisible or direction changing characters. */
const oneLine = (s: unknown, max: number): s is string => typeof s === "string" && s.trim() !== "" && s.length <= max && !/[\p{C}\u2028\u2029]/u.test(s);

/**
 * What is wrong with the rules of an organization's rule set. They are checked as a repo would have them, with every
 * module they name, and held to what makes sense in every repo: layers and deny_dependency are refused, since module
 * names differ from repo to repo, and so are naming and deny_external rules for one module.
 */
export function orgRuleErrors(rules: unknown): string[] {
  if (!Array.isArray(rules)) return ["The rules must be a list."];
  if (rules.length > MAX_ORG_RULES) return [`A rule set may have at most ${MAX_ORG_RULES} rules.`];
  const errors: string[] = [];
  const modules = new Set<string>();
  for (const r of rules as Array<Record<string, unknown>>) {
    if (!r || typeof r !== "object") return ["Each rule must be an object."];
    const id = String(r.id ?? "");
    const label = JSON.stringify(id.slice(0, 80));
    if (!ORG_ID.test(id)) errors.push(`Rule ${label}: an organization rule id starts with "${ORG_PREFIX}" and has up to 60 letters, digits, "-" and "_" after it.`);
    if (!(ORG_RULE_TYPES as readonly string[]).includes(String(r.type))) errors.push(`Rule ${label}: ${String(r.type).slice(0, 40)} rules cannot be organization rules. Only ${ORG_RULE_TYPES.join(", ")}.`);
    if ((r.type === "deny_external" || r.type === "naming") && r.module !== EVERY_MODULE) errors.push(`Rule ${label}: an organization ${r.type} rule applies to every module ("${EVERY_MODULE}").`);
    if (!oneLine(r.description, MAX_DESCRIPTION)) errors.push(`Rule ${label}: the description must be one line of at most ${MAX_DESCRIPTION} characters.`);
    if (!oneLine(r.rationale, MAX_RATIONALE)) errors.push(`Rule ${label}: the rationale must be one line of at most ${MAX_RATIONALE} characters.`);
    if (r.org !== undefined) errors.push(`Rule ${label}: "org" is set when a repo takes the rule, not in the set.`);
    for (const m of [...(Array.isArray(r.modules) ? r.modules : []), ...(Array.isArray(r.except) ? r.except : [])]) if (typeof m === "string") modules.add(m);
  }
  if (errors.length) return errors;
  // The rest as a repo checks it, with the modules the rules name, so that nothing a repo would refuse gets in.
  const probe: Architecture = { version: 1, modules: Object.fromEntries([...modules].map((m) => [m, { paths: [`${m}/**`] }])), layers: [], rules: rules as Rule[], exceptions: [] };
  const v = validateArchitecture(probe);
  return v.ok ? [] : v.errors;
}

/** What is wrong with the overrides of an architecture, given its rules. */
export function overrideErrors(overrides: unknown, rules: unknown): string[] {
  if (overrides === undefined) return [];
  if (!Array.isArray(overrides)) return ["overrides must be an array."];
  if (overrides.length > MAX_OVERRIDES) return [`at most ${MAX_OVERRIDES} overrides are allowed.`];
  const list = Array.isArray(rules) ? (rules as Array<Record<string, unknown>>) : [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const o of overrides as Array<Record<string, unknown>>) {
    if (!o || typeof o !== "object") {
      errors.push("each override must be an object.");
      continue;
    }
    const rule = typeof o.rule === "string" ? o.rule : "";
    const label = JSON.stringify(rule.slice(0, 80));
    const target = list.find((r) => r && r.id === rule);
    if (!target) errors.push(`override of ${label}: there is no such rule.`);
    else if (!target.org) errors.push(`override of ${label}: only an organization rule can have an override. Change a rule of this repository instead.`);
    if (seen.has(rule)) errors.push(`override of ${label}: a rule can have one override.`);
    seen.add(rule);
    if (o.action !== "disable" && o.action !== "warn") errors.push(`override of ${label}: action must be disable or warn.`);
    for (const [k, max] of Object.entries(TEXT)) if (!oneLine(o[k], max)) errors.push(`override of ${label}: "${k}" must be one line of at most ${max} characters.`);
    if (typeof o.expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.expires)) errors.push(`override of ${label}: expires must be YYYY-MM-DD.`);
    const extra = Object.keys(o).filter((k) => !["rule", "action", "owner", "reason", "expires"].includes(k));
    if (extra.length) errors.push(`override of ${label}: unknown field ${JSON.stringify(extra[0].slice(0, 40))}.`);
  }
  return errors;
}

/** The rules as they apply on a day: an active override turns its rule off or makes it a warning. Expired ones do nothing. */
export function effectiveRules(arch: Architecture, today: string): { rules: Rule[]; expired: Override[] } {
  const active = new Map<string, Override>();
  const expired: Override[] = [];
  for (const o of arch.overrides ?? []) (o.expires < today ? expired.push(o) : active.set(o.rule, o));
  if (!active.size) return { rules: arch.rules, expired };
  const rules: Rule[] = [];
  for (const r of arch.rules) {
    const o = r.org ? active.get(r.id) : undefined;
    if (!o) rules.push(r);
    else if (o.action === "warn") rules.push({ ...r, severity: "warn" });
  }
  return { rules, expired };
}

export interface OrgApplied {
  arch: Architecture;
  /** Why the set cannot be applied to this repo. Nothing was changed when there are any. */
  conflicts: string[];
}

/** An organization rule as this repo takes it: marked with the version, and leaving out of `except` modules the repo does not have. */
function asTaken(r: Rule, version: number, arch: Architecture): Rule {
  const taken = { ...r, org: { version } } as Rule;
  if (taken.type === "deny_external" && taken.except) {
    const except = taken.except.filter((m) => Object.hasOwn(arch.modules, m));
    if (except.length) taken.except = except;
    else delete taken.except;
  }
  return taken;
}

/** Whether a rule of a repo is what the set's version of it gives, so that an edit to it can be named. */
export function matchesOrgRule(r: Rule, set: OrgRuleSet, arch: Architecture): boolean {
  const own = set.rules.find((x) => x.id === r.id);
  return !!own && JSON.stringify(asTaken(own, set.version, arch)) === JSON.stringify(r);
}

/**
 * The architecture with an organization's rule set in it: its rules replace the organization rules there were, in their
 * place, new ones are added at the end, and those the set no longer has are removed with their overrides. The repo's own
 * rules, layers, exceptions, the overrides of rules that stay, ids and the order of keys stay as they are. Applying the
 * same set again changes nothing. Refused, with nothing changed, when a rule of the repo has the id of one of the set or
 * a placement rule names a module the repo does not have. Enforcement reads only the repo's file, so the CLI and CI need
 * nothing else.
 */
export function applyOrgRules(arch: Architecture, set: OrgRuleSet, org: string): OrgApplied {
  const conflicts = [...orgRuleErrors(set.rules)];
  if (!Number.isInteger(set.version) || set.version < 1) conflicts.push("The version of a rule set is a whole number from 1.");
  for (const r of set.rules) {
    const own = arch.rules.find((x) => x.id === r.id);
    if (own && !own.org) conflicts.push(`Rule ${r.id} of this repository has the id of an organization rule. Rename it first.`);
    if (r.type === "placement") {
      const missing = r.modules.filter((m) => !Object.hasOwn(arch.modules, m));
      if (missing.length) conflicts.push(`Rule ${r.id} wants files in ${missing.join(", ")}, which this repository does not have.`);
    }
  }
  if (conflicts.length) return { arch, conflicts };

  const incoming = new Map(set.rules.map((r) => [r.id, asTaken(r, set.version, arch)]));
  const rules: Rule[] = [];
  for (const r of arch.rules) {
    if (!r.org) rules.push(r);
    else if (incoming.has(r.id)) {
      rules.push(incoming.get(r.id)!);
      incoming.delete(r.id);
    }
  }
  rules.push(...incoming.values());
  const kept = new Set(rules.filter((r) => r.org).map((r) => r.id));
  const out: Architecture = { ...arch, rules };
  if (arch.overrides) {
    const overrides = arch.overrides.filter((o) => kept.has(o.rule));
    if (overrides.length) out.overrides = overrides;
    else delete out.overrides;
  }
  out.meta = { ...(arch.meta ?? {}), orgRules: { org, version: set.version } };
  const v = validateArchitecture(out);
  return v.ok ? { arch: out, conflicts: [] } : { arch, conflicts: v.errors };
}
