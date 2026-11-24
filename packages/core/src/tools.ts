/**
 * Agent facing tool logic. Pure functions over an in memory context, so the same code
 * backs the local stdio MCP server (CLI) and the remote MCP server (Cloudflare Workers).
 */
import { assignModules, checkArchitecture } from "./check.js";
import { buildGraphFromFiles, type FileMap } from "./graph.js";
import type { Architecture, Violation } from "./types.js";

export interface ToolContext {
  arch: Architecture;
  files: FileMap;
  baseline: string[];
}

export function getArchitectureSummary(ctx: ToolContext) {
  return {
    layers: ctx.arch.layers,
    note: "Layers are listed top to bottom. A module may import itself or any module listed after it.",
    modules: Object.fromEntries(
      Object.entries(ctx.arch.modules).map(([name, def]) => [name, { paths: def.paths, description: def.description }]),
    ),
    rules: ctx.arch.rules.map((r) => ({
      id: r.id,
      severity: r.severity,
      description: r.description,
      rationale: r.rationale,
    })),
    exceptions: ctx.arch.exceptions.map((e) => ({ rule: e.rule, file: e.file, expires: e.expires })),
    ignore: ctx.arch.ignore ?? [],
  };
}

export function getRulesForPath(ctx: ToolContext, filePath: string) {
  const mod = assignModules(ctx.arch, [filePath]).get(filePath) ?? null;
  if (!mod) {
    return {
      path: filePath,
      module: null,
      note: "This path is not inside any module. Modules that import it are treated as importing everything it leads to, so it cannot be used to get around the rules. Consider whether it belongs in an existing module.",
      modules: Object.keys(ctx.arch.modules),
    };
  }
  const layers = ctx.arch.layers;
  const idx = layers.indexOf(mod);
  const hasLayer = idx !== -1;
  const denied = ctx.arch.rules.filter((r) => r.type === "deny_dependency" && r.from === mod) as Array<{
    to: string;
  }>;
  const deniedTo = new Set(denied.map((d) => d.to));
  const mayImport = hasLayer ? layers.slice(idx).filter((m) => m === mod || !deniedTo.has(m)) : [];
  const mustNotImport = hasLayer
    ? [...new Set([...layers.slice(0, idx), ...deniedTo])]
    : [...deniedTo];
  const bannedPackages = ctx.arch.rules.flatMap((r) =>
    r.type === "deny_external" && r.module === mod ? r.packages : [],
  );
  return {
    path: filePath,
    module: mod,
    layerPosition: hasLayer ? { index: idx + 1, of: layers.length } : null,
    mayImportFromModules: mayImport,
    mustNotImportFromModules: mustNotImport,
    bannedPackages,
    rules: ctx.arch.rules.map((r) => ({ id: r.id, severity: r.severity, description: r.description, rationale: r.rationale })),
  };
}

/** Is an import from one file to a repo path or a package allowed? */
export function checkImport(ctx: ToolContext, fromPath: string, target: string) {
  const isPackage = !target.includes("/") || target.startsWith("@");
  const toPath = isPackage ? undefined : target;
  const files = isPackage ? [fromPath] : [fromPath, target];
  const planned = isPackage ? { from: fromPath, pkg: target, specifier: target } : { from: fromPath, to: toPath, specifier: target };
  // A target outside every module stands for whatever it leads to, so include the existing code around it.
  const project = !isPackage && !assignModules(ctx.arch, [target]).size ? buildGraphFromFiles(ctx.files) : null;
  const projectFiles = project ? [...new Set([...project.files, ...files])] : files;
  const assigned = assignModules(ctx.arch, projectFiles);
  const graph = {
    root: ".",
    files: projectFiles,
    lines: {},
    edges: [planned, ...(project?.edges.filter((e) => !assigned.has(e.from)) ?? [])],
  };
  const res = checkArchitecture(ctx.arch, graph);
  const blocking = res.violations.filter((v) => !v.excepted);
  const modOf = assignModules(ctx.arch, files);
  return {
    allowed: blocking.every((v) => v.severity !== "block"),
    fromModule: modOf.get(fromPath) ?? null,
    toModule: toPath ? (modOf.get(toPath) ?? null) : null,
    problems: blocking.map((v) => ({ rule: v.ruleId, severity: v.severity, message: v.message, fix: v.fix, why: v.rationale })),
  };
}

export interface ChangedFile {
  path: string;
  /** New contents, or null when the file is deleted. */
  content: string | null;
}

/** Check a set of proposed file changes and report only the violations they would introduce. */
export function checkChange(ctx: ToolContext, changes: ChangedFile[]) {
  const before = buildGraphFromFiles(ctx.files);
  const afterFiles: FileMap = { ...ctx.files };
  for (const c of changes) {
    if (c.content === null) delete afterFiles[c.path];
    else afterFiles[c.path] = c.content;
  }
  const after = buildGraphFromFiles(afterFiles);
  const known = new Set(checkArchitecture(ctx.arch, before, { baseline: ctx.baseline }).violations.map((v) => v.id));
  const res = checkArchitecture(ctx.arch, after, { baseline: ctx.baseline });
  const introduced: Violation[] = res.violations.filter((v) => !known.has(v.id) && !v.baseline && !v.excepted);
  return {
    ok: !introduced.some((v) => v.severity === "block"),
    introduced: introduced.map((v) => ({
      rule: v.ruleId,
      severity: v.severity,
      file: v.file,
      message: v.message,
      fix: v.fix,
      why: v.rationale,
    })),
    expiredExceptions: res.expiredExceptions.length,
  };
}

export interface ProposalInput {
  title: string;
  summary: string;
  rationale: string;
  /** Optional concrete suggestion, for example "move shared/format to a new module". */
  suggestedChange?: string;
  requestedBy?: string;
}

/**
 * Agents may suggest architecture changes. They can never approve them.
 * This returns a pending proposal for a Team Leader. Persisting it is up to the host.
 */
export function createProposal(input: ProposalInput, now: Date = new Date()) {
  const slug = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return {
    id: `${now.toISOString().slice(0, 10)}_${slug || "proposal"}`,
    status: "pending_approval" as const,
    requestedBy: input.requestedBy ?? "agent",
    createdAt: now.toISOString(),
    title: input.title,
    summary: input.summary,
    rationale: input.rationale,
    suggestedChange: input.suggestedChange ?? null,
    approvedBy: null,
  };
}
