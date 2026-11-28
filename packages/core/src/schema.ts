import { MAX_ORG_RULES, ORG_RULE_TYPES, overrideErrors } from "./org.js";
import type { Architecture } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const RULE_TYPES = ["layers", "no_cycles", "deny_dependency", "deny_external", "max_file_lines", "no_opaque_imports", "naming", "placement", "public_api"];
export const NAMING_STYLES = ["kebab", "camel", "pascal", "snake"];
/** Means every module where a rule takes one, so no module may have it as its name. */
export const EVERY_MODULE = "*";
const MAX_GLOB = 512;
const MAX_LIST = 50;
const MAX_ENTRIES = 20;
/** Naming and placement rules each match every file against a glob, so their number bounds the time a check takes. */
export const MAX_FILE_RULES = 30;
const SUFFIX = /^[A-Za-z0-9_-]{1,40}$/;

export function validateArchitecture(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["Architecture must be an object."] };
  const a = input as Partial<Architecture> & Record<string, unknown>;

  if (a.version !== 1) errors.push("version must be 1.");

  const modules = a.modules;
  const moduleNames = new Set<string>();
  if (!modules || typeof modules !== "object") {
    errors.push("modules must be an object.");
  } else {
    for (const [name, def] of Object.entries(modules)) {
      moduleNames.add(name);
      if (name === EVERY_MODULE) errors.push(`"${EVERY_MODULE}" cannot be the name of a module, because rules use it for every module.`);
      if (!def || !Array.isArray(def.paths) || def.paths.length === 0 || def.paths.some((p) => typeof p !== "string")) {
        errors.push(`module "${name}" needs a non empty paths array of strings.`);
      }
    }
  }

  if (!Array.isArray(a.layers)) {
    errors.push("layers must be an array of module names.");
  } else {
    const seen = new Set<string>();
    for (const l of a.layers) {
      if (!moduleNames.has(l)) errors.push(`layer "${l}" is not a defined module.`);
      if (seen.has(l)) errors.push(`layer "${l}" is listed twice.`);
      seen.add(l);
    }
  }

  if (!Array.isArray(a.rules)) {
    errors.push("rules must be an array.");
  } else {
    const ids = new Set<string>();
    const apiModules = new Set<string>();
    const fileRules = a.rules.filter((r) => r && typeof r === "object" && (r.type === "naming" || r.type === "placement")).length;
    if (fileRules > MAX_FILE_RULES) errors.push(`at most ${MAX_FILE_RULES} naming and placement rules are allowed, there are ${fileRules}.`);
    for (const r of a.rules) {
      if (!r || typeof r !== "object") {
        errors.push("each rule must be an object.");
        continue;
      }
      const rule = r as Record<string, unknown>;
      const id = String(rule.id ?? "");
      if (!id) errors.push("every rule needs an id.");
      if (ids.has(id)) errors.push(`rule id "${id}" is duplicated.`);
      ids.add(id);
      if (!RULE_TYPES.includes(String(rule.type))) errors.push(`rule ${id} has unknown type "${String(rule.type)}".`);
      if (rule.severity !== "block" && rule.severity !== "warn") errors.push(`rule ${id} severity must be block or warn.`);
      if (rule.org !== undefined) errors.push(...orgMarkErrors(id, rule));
      if (!rule.rationale || typeof rule.rationale !== "string") errors.push(`rule ${id} needs a rationale.`);
      if (rule.type === "deny_dependency") {
        for (const k of ["from", "to"]) {
          if (!moduleNames.has(String(rule[k]))) errors.push(`rule ${id} references unknown module "${String(rule[k])}".`);
        }
      }
      if (rule.type === "deny_external") {
        if (rule.module !== EVERY_MODULE && !moduleNames.has(String(rule.module))) errors.push(`rule ${id} references unknown module "${String(rule.module)}".`);
        if (!Array.isArray(rule.packages) || rule.packages.length === 0) errors.push(`rule ${id} needs a packages array.`);
        if (rule.except !== undefined) {
          if (rule.module !== EVERY_MODULE) errors.push(`rule ${id} may only have except when its module is "${EVERY_MODULE}".`);
          errors.push(...moduleListErrors(id, "except", rule.except, modules, false));
        }
      }
      if (rule.type === "max_file_lines" && typeof rule.max !== "number") errors.push(`rule ${id} needs a numeric max.`);
      if (rule.type === "naming") {
        if (rule.module !== EVERY_MODULE && !isModule(modules, rule.module)) errors.push(`rule ${id} needs a module that exists, or "${EVERY_MODULE}".`);
        errors.push(...globErrors(id, "files", rule.files));
        if (!NAMING_STYLES.includes(rule.style as string)) errors.push(`rule ${id} style must be one of ${NAMING_STYLES.join(", ")}.`);
        if (rule.ignoreSuffixes !== undefined && (!stringList(rule.ignoreSuffixes, MAX_LIST, false) || !rule.ignoreSuffixes.every((x) => SUFFIX.test(x)))) {
          errors.push(`rule ${id} ignoreSuffixes must be up to ${MAX_LIST} endings of letters, digits, "-" and "_".`);
        } else if (rule.ignoreSuffixes !== undefined && new Set(rule.ignoreSuffixes).size < rule.ignoreSuffixes.length) {
          errors.push(`rule ${id} ignoreSuffixes names an ending twice.`);
        }
      }
      if (rule.type === "placement") {
        errors.push(...globErrors(id, "files", rule.files));
        errors.push(...moduleListErrors(id, "modules", rule.modules, modules, true));
      }
      if (rule.type === "public_api") {
        if (!isModule(modules, rule.module)) errors.push(`rule ${id} needs a module that exists.`);
        else if (apiModules.has(rule.module as string)) errors.push(`rule ${id} is a second public_api rule for its module. List all entries in one.`);
        else apiModules.add(rule.module as string);
        if (!stringList(rule.entries, MAX_ENTRIES, true) || rule.entries.some((g) => !g || g.length > MAX_GLOB)) {
          errors.push(`rule ${id} entries must be 1 to ${MAX_ENTRIES} globs of at most ${MAX_GLOB} characters.`);
        } else if (new Set(rule.entries).size < rule.entries.length) {
          errors.push(`rule ${id} entries names a glob twice.`);
        }
      }
    }
  }

  if (Array.isArray(a.rules)) {
    const marked = a.rules.filter((r) => r && typeof r === "object" && (r as Record<string, unknown>).org !== undefined).length;
    if (marked > MAX_ORG_RULES) errors.push(`at most ${MAX_ORG_RULES} rules can be organization rules, there are ${marked}.`);
  }
  errors.push(...overrideErrors(a.overrides, a.rules));
  if (a.meta !== undefined && (!a.meta || typeof a.meta !== "object" || Array.isArray(a.meta))) errors.push("meta must be an object.");
  else if (a.meta?.orgRules !== undefined) {
    const o = a.meta.orgRules as unknown as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || typeof o.org !== "string" || !o.org || o.org.length > 100 || !Number.isInteger(o.version) || (o.version as number) < 1) {
      errors.push("meta.orgRules must name the organization and the version of its rule set.");
    }
  }

  if (!Array.isArray(a.exceptions)) {
    errors.push("exceptions must be an array (can be empty).");
  } else {
    for (const ex of a.exceptions) errors.push(...exceptionErrors(ex));
  }

  if (a.ignore !== undefined && (!Array.isArray(a.ignore) || a.ignore.some((g) => typeof g !== "string" || !g))) {
    errors.push("ignore must be an array of globs.");
  }

  if (a.aliases !== undefined) errors.push(...aliasErrors(a.aliases));

  return { ok: errors.length === 0, errors };
}

/**
 * A rule marked as an organization rule: only types that mean the same in every repo, with an id that says so, and the
 * version of the set it came from. An override can turn such a rule off, so the mark is never taken lightly.
 */
function orgMarkErrors(id: string, rule: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const org = rule.org as Record<string, unknown> | null;
  if (!org || typeof org !== "object" || Array.isArray(org) || Object.keys(org).some((k) => k !== "version") || !Number.isInteger(org.version) || (org.version as number) < 1) {
    errors.push(`rule ${id} org must be { "version": n } with the version of the organization's rule set.`);
  }
  if (!/^ORG-[A-Za-z0-9_-]{1,60}$/.test(id)) errors.push(`rule ${id} is marked as an organization rule, whose ids start with "ORG-".`);
  if (!(ORG_RULE_TYPES as readonly string[]).includes(String(rule.type))) errors.push(`rule ${id} is a ${String(rule.type)} rule, which cannot be an organization rule.`);
  if ((rule.type === "deny_external" || rule.type === "naming") && rule.module !== EVERY_MODULE) errors.push(`rule ${id} is an organization rule, so it applies to every module ("${EVERY_MODULE}").`);
  return errors;
}

const isModule = (modules: unknown, name: unknown): boolean =>
  !!modules && typeof modules === "object" && typeof name === "string" && name !== EVERY_MODULE && Object.hasOwn(modules, name);

function stringList(value: unknown, max: number, required: boolean): value is string[] {
  return Array.isArray(value) && value.length <= max && (!required || value.length > 0) && value.every((x) => typeof x === "string");
}

function globErrors(id: string, key: string, value: unknown): string[] {
  return typeof value === "string" && value && value.length <= MAX_GLOB ? [] : [`rule ${id} ${key} must be a glob of at most ${MAX_GLOB} characters.`];
}

/** Up to MAX_LIST module names, each once, so that one rule cannot fill the description of a change to the rules. */
function moduleListErrors(id: string, key: string, value: unknown, modules: unknown, required: boolean): string[] {
  if (!stringList(value, MAX_LIST, required)) return [`rule ${id} ${key} must be ${required ? "a non empty" : "an"} array of at most ${MAX_LIST} module names.`];
  if (new Set(value).size < value.length) return [`rule ${id} ${key} names a module twice.`];
  return value.filter((m) => !isModule(modules, m)).slice(0, 5).map((m) => `rule ${id} references unknown module ${JSON.stringify(m.slice(0, 80))} in ${key}.`);
}

/** What is wrong with one exception, in the words validateArchitecture uses. */
export function exceptionErrors(ex: unknown): string[] {
  const errors: string[] = [];
  const e = (ex && typeof ex === "object" ? ex : null) as Record<string, unknown> | null;
  for (const k of ["rule", "file", "owner", "reason", "expires"] as const) {
    if (!e || typeof e[k] !== "string" || !e[k]) errors.push(`every exception needs "${k}".`);
  }
  if (e && typeof e.expires === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) {
    errors.push(`exception expires must be YYYY-MM-DD, got "${e.expires}".`);
  }
  return errors;
}

export const MAX_ALIASES = 1000;
/** As many as tsconfig paths may have for one pattern, so that init can write any of those. */
export const MAX_ALIAS_TARGETS = 50;

const stars = (s: string) => s.split("*").length - 1;

/** A module name with at most one "*", which is not a relative or absolute path. */
export function aliasNameOk(name: string): boolean {
  return !!name && stars(name) <= 1 && !name.startsWith(".") && !name.startsWith("/");
}

/** A repo relative path, with a "*" only when the name of its alias has one. */
export function aliasTargetOk(name: string, t: unknown): boolean {
  return typeof t === "string" && !!t && !t.startsWith("/") && !t.includes("\\") && !/^[a-z]:/i.test(t) && !t.split("/").includes("..") && stars(t) <= stars(name);
}

/** Aliases are names to repo relative paths, with at most one "*" each, which a target has only when its name has one. */
function aliasErrors(aliases: unknown): string[] {
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) return ["aliases must be an object of names to arrays of paths."];
  const entries = Object.entries(aliases);
  if (entries.length > MAX_ALIASES) return [`aliases may have at most ${MAX_ALIASES} names.`];
  const errors: string[] = [];
  for (const [name, targets] of entries) {
    const label = JSON.stringify(name.slice(0, 80));
    if (!aliasNameOk(name)) errors.push(`alias ${label} must be a module name with at most one "*".`);
    if (!Array.isArray(targets) || !targets.length || targets.length > MAX_ALIAS_TARGETS) {
      errors.push(`alias ${label} needs 1 to ${MAX_ALIAS_TARGETS} paths.`);
      continue;
    }
    if (targets.some((t) => !aliasTargetOk(name, t))) errors.push(`alias ${label} has a path that is not inside the repo or has a "*" its name does not have.`);
  }
  return errors;
}
