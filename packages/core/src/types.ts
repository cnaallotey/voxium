export type Severity = "block" | "warn";

export interface ModuleDef {
  /** Glob patterns relative to the repo root. First matching module wins. */
  paths: string[];
  description?: string;
}

export type Rule =
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
      module: string;
      packages: string[];
      description: string;
      rationale: string;
      severity: Severity;
    }
  | {
      id: string;
      type: "max_file_lines";
      max: number;
      description: string;
      rationale: string;
      severity: Severity;
    };

export interface Exception {
  rule: string;
  /** Glob matched against the violating file. */
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
  meta?: { approvedBy?: string; updated?: string };
}

export interface ImportEdge {
  from: string;
  /** Resolved repo relative file path, when the import is internal. */
  to?: string;
  /** Package name, when the import is external. */
  pkg?: string;
  specifier: string;
}

export interface ProjectGraph {
  root: string;
  files: string[];
  lines: Record<string, number>;
  edges: ImportEdge[];
}

export interface Violation {
  id: string;
  ruleId: string;
  severity: Severity;
  file: string;
  message: string;
  fix: string;
  rationale: string;
  baseline?: boolean;
  excepted?: boolean;
}

export interface CheckResult {
  violations: Violation[];
  expiredExceptions: Exception[];
  stats: { files: number; assigned: number; edges: number; modules: number };
}

export interface InferResult {
  architecture: Architecture;
  confidence: number;
  notes: string[];
  existingViolations: number;
}
