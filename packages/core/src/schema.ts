import type { Architecture } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const RULE_TYPES = ["layers", "no_cycles", "deny_dependency", "deny_external", "max_file_lines"];

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
      if (!rule.rationale || typeof rule.rationale !== "string") errors.push(`rule ${id} needs a rationale.`);
      if (rule.type === "deny_dependency") {
        for (const k of ["from", "to"]) {
          if (!moduleNames.has(String(rule[k]))) errors.push(`rule ${id} references unknown module "${String(rule[k])}".`);
        }
      }
      if (rule.type === "deny_external") {
        if (!moduleNames.has(String(rule.module))) errors.push(`rule ${id} references unknown module "${String(rule.module)}".`);
        if (!Array.isArray(rule.packages) || rule.packages.length === 0) errors.push(`rule ${id} needs a packages array.`);
      }
      if (rule.type === "max_file_lines" && typeof rule.max !== "number") errors.push(`rule ${id} needs a numeric max.`);
    }
  }

  if (!Array.isArray(a.exceptions)) {
    errors.push("exceptions must be an array (can be empty).");
  } else {
    for (const ex of a.exceptions) {
      for (const k of ["rule", "file", "owner", "reason", "expires"] as const) {
        if (!ex || typeof ex[k] !== "string" || !ex[k]) errors.push(`every exception needs "${k}".`);
      }
      if (ex && typeof ex.expires === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(ex.expires)) {
        errors.push(`exception expires must be YYYY-MM-DD, got "${ex.expires}".`);
      }
    }
  }

  if (a.ignore !== undefined && (!Array.isArray(a.ignore) || a.ignore.some((g) => typeof g !== "string" || !g))) {
    errors.push("ignore must be an array of globs.");
  }

  return { ok: errors.length === 0, errors };
}
