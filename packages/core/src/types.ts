import type { OpaqueImport } from "./imports.js";

export type Severity = "block" | "warn";

export type NamingStyle = "kebab" | "camel" | "pascal" | "snake";

export interface ModuleDef {
  /** Glob patterns relative to the repo root. First matching module wins. */
  paths: string[];
  description?: string;
}

/** Where an organization rule came from: the version of the organization's rule set it was copied from. */
export interface OrgMark {
  version: number;
}

export type Rule = (
  | { id: string; type: "layers"; description: string; rationale: string; severity: Severity }
  | { id: string; type: "no_cycles"; description: string; rationale: string; severity: Severity }
  | {
      id: string;
      type: "deny_dependency";
      from: string;
      to: string;
      description: string;
      rationale: string;
      severity: Severity;
    }
  | {
      id: string;
      type: "deny_external";
      /** A module, or "*" for every module except those in `except`. */
      module: string;
      packages: string[];
      except?: string[];
      description: string;
      rationale: string;
      severity: Severity;
    }
  /** File names matching `files`, in a module or in every file ("*"), are written in one style. */
  | {
      id: string;
      type: "naming";
      module: string;
      files: string;
      style: NamingStyle;
      /** Endings of a name that are left out before its style is judged, such as "_test". */
      ignoreSuffixes?: string[];
      description: string;
      rationale: string;
      severity: Severity;
    }
  /** Files matching `files` belong in one of these modules. */
  | { id: string; type: "placement"; files: string; modules: string[]; description: string; rationale: string; severity: Severity }
  /** Other modules may only import the files of a module that match one of its entries. */
  | { id: string; type: "public_api"; module: string; entries: string[]; description: string; rationale: string; severity: Severity }
  /** Loading a module that cannot be told from the code. */
  | { id: string; type: "no_opaque_imports"; description: string; rationale: string; severity: Severity }
  | {
      id: string;
      type: "max_file_lines";
      max: number;
      description: string;
      rationale: string;
      severity: Severity;
    }
) & {
  /** Set on a rule copied from the organization's rule set. Only such a rule can have an override. */
  org?: OrgMark;
};

/** A repo's approved way out of an organization rule: turned off, or a warning, until it expires. */
export interface Override {
  /** The id of a rule marked org. */
  rule: string;
  action: "disable" | "warn";
  owner: string;
  reason: string;
  /** ISO date, YYYY-MM-DD. An expired override stops applying, so the rule is enforced again, and is reported. */
  expires: string;
}

export interface Exception {
  rule: string;
  /** Glob matched against the violating file. For a cycle: files whose imports do not count towards it. */
  file: string;
  owner: string;
  reason: string;
  /** ISO date, YYYY-MM-DD. Expired exceptions stop applying and are reported. */
  expires: string;
}

export interface Architecture {
  version: 1;
  modules: Record<string, ModuleDef>;
  /** Top to bottom. A module may import itself or any module listed after it. */
  layers: string[];
  rules: Rule[];
  exceptions: Exception[];
  /** Globs for files that are not source, for example committed build output. They are not checked. */
  ignore?: string[];
  /**
   * Module names and what they stand for, as tsconfig paths have them: "@app/*" to ["src/app/*"], repo relative. They add
   * to what the config files of the code say, and come from the base branch, so a change cannot drop them.
   */
  aliases?: Record<string, string[]>;
  /** Overrides of organization rules, approved like any change to the rules. */
  overrides?: Override[];
  meta?: { approvedBy?: string; updated?: string; /** The organization rule set the org rules come from. */ orgRules?: { org: string; version: number } };
}

export interface ImportEdge {
  from: string;
  /** Resolved repo relative file path, when the import is internal. */
  to?: string;
  /** Package name, when the import is external. */
  pkg?: string;
  specifier: string;
  /** Line of the import in the file, counting from 1. */
  line?: number;
}

/** A place where a file loads something that cannot be told from its code. */
export interface OpaqueUse extends OpaqueImport {
  file: string;
}

export interface UnparsedFile {
  file: string;
  /** Goes on from the name of the file, as in "ends inside a string". */
  reason: string;
}

export interface ProjectGraph {
  root: string;
  files: string[];
  lines: Record<string, number>;
  edges: ImportEdge[];
  opaque: OpaqueUse[];
  /**
   * Files that could not be read to their end. They have no edges, so a check is complete only when uncheckedPaths leaves
   * none of them. Config files that cannot be read and could change what code below them imports are here too.
   */
  unparsed: UnparsedFile[];
  /** Relative or alias imports, and names a mapping was meant for, that lead to no file. */
  unresolved?: number;
  /** Aliases the root config files declare, as inferArchitecture proposes them for the architecture. */
  aliases?: Record<string, string[]>;
  /** What config files say that is left out on purpose, such as an extends of a generated file, for whoever sets up the rules. */
  notes?: string[];
}

export interface Violation {
  id: string;
  ruleId: string;
  severity: Severity;
  file: string;
  /** Line of the import that breaks the rule, when it is about one. */
  line?: number;
  message: string;
  fix: string;
  rationale: string;
  /**
   * Another id that accepts this violation when a baseline lists it. A public_api import through a file outside the
   * modules is one violation for the whole module once it reaches more than MAX_REACHED files that are not entries,
   * and one per file below that. Each per-file violation carries the whole-module id, so reaching fewer files never
   * fails.
   */
  acceptedAs?: string;
  baseline?: boolean;
  excepted?: boolean;
}

/** An import between two modules of a cycle. */
export interface CycleImport {
  file: string;
  line?: number;
  to: string;
  /** The file outside every module that it passes through, when it is indirect. */
  via?: string;
  fromMod: string;
  toMod: string;
  /** Goes against the layer order. */
  up: boolean;
  /** Accepted debt under another rule. */
  accepted: boolean;
}

export interface Cycle {
  modules: string[];
  /** The imports that keep the cycle going. */
  imports: CycleImport[];
  /** It lies within an accepted cycle, so it depends on the connections from before the change, which are not known. */
  undecided?: boolean;
}

export interface CheckResult {
  violations: Violation[];
  /** What each violation that is a cycle consists of, by violation id. */
  cycles: Map<string, Cycle>;
  expiredExceptions: Exception[];
  /** Overrides that ran out. Their rules are enforced again, and like expired exceptions they fail a check. */
  expiredOverrides: Override[];
  /** In the files of modules, and in those outside that they lead to. */
  opaque: OpaqueUse[];
  stats: { files: number; assigned: number; edges: number; modules: number; unresolved: number };
}

/** One part of a proposed architecture, with how well the code supports it, for a person to review. */
export interface InferProposal {
  kind: "module" | "layer" | "rule";
  /** The module name for a module or a layer, the rule id for a rule. */
  name: string;
  /** 0 to 1. */
  confidence: number;
  /** Why, in one sentence. */
  evidence: string;
}

export interface InferResult {
  architecture: Architecture;
  confidence: number;
  notes: string[];
  existingViolations: number;
  /** Every module, layer and rule of the architecture, in its order. */
  proposals: InferProposal[];
  /** Frameworks the root package.json depends on, such as "next". */
  frameworks: string[];
}
