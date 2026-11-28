/**
 * Agent facing tool logic. Pure functions over an in memory context, so the same code
 * backs the local stdio MCP server (CLI) and the remote MCP server (Cloudflare Workers).
 */
import { assignModules, checkArchitecture, graphNodes, moduleConnections, moduleDependencies, needsConnections, uncheckedPaths, unparsedFiles } from "./check.js";
import { locateCycle } from "./cycles.js";
import { namingProblem, styleName } from "./conventions.js";
import { compileGlobs, matchesGlob } from "./glob.js";
import { buildGraphFromFiles, isSourcePath, type FileMap } from "./graph.js";
import { EVERY_MODULE, exceptionErrors, validateArchitecture } from "./schema.js";
import type { Architecture, Exception, Violation } from "./types.js";

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
    aliases: ctx.arch.aliases ?? {},
  };
}

/** The naming and placement rules a path falls under, and whether it keeps them. */
function conventionsFor(arch: Architecture, filePath: string, mod: string | null) {
  const naming = arch.rules.flatMap((r) =>
    r.type === "naming" && (r.module === EVERY_MODULE || r.module === mod) && matchesGlob(filePath, r.files)
      ? [{ rule: r.id, severity: r.severity, style: styleName(r.style), ...(r.ignoreSuffixes?.length ? { ignoredEndings: r.ignoreSuffixes } : {}), ok: !namingProblem(filePath, r) }]
      : [],
  );
  const placement = arch.rules.flatMap((r) =>
    r.type === "placement" && matchesGlob(filePath, r.files) ? [{ rule: r.id, severity: r.severity, allowedModules: r.modules, ok: mod !== null && r.modules.includes(mod) }] : [],
  );
  return { naming, placement };
}

export function getRulesForPath(ctx: ToolContext, filePath: string) {
  const mod = assignModules(ctx.arch, [filePath]).get(filePath) ?? null;
  if (!mod) {
    return {
      path: filePath,
      module: null,
      note: "This path is not inside any module. Modules that import it are treated as importing everything it leads to, so it cannot be used to get around the rules. Consider whether it belongs in an existing module.",
      modules: Object.keys(ctx.arch.modules),
      ...conventionsFor(ctx.arch, filePath, null),
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
  const bannedPackages = [
    ...new Set(ctx.arch.rules.flatMap((r) => (r.type === "deny_external" && (r.module === EVERY_MODULE ? !r.except?.includes(mod) : r.module === mod) ? r.packages : []))),
  ];
  const banned = new Set(mustNotImport);
  // Only the entries of a module may be imported from other modules.
  const entries: Record<string, string[]> = {};
  for (const r of ctx.arch.rules) {
    if (r.type === "public_api" && r.module !== mod && !banned.has(r.module)) entries[r.module] = [...new Set([...(entries[r.module] ?? []), ...r.entries])];
  }
  return {
    path: filePath,
    module: mod,
    layerPosition: hasLayer ? { index: idx + 1, of: layers.length } : null,
    mayImportFromModules: mayImport,
    mustNotImportFromModules: mustNotImport,
    bannedPackages,
    entriesOfModules: entries,
    ...conventionsFor(ctx.arch, filePath, mod),
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
  const project = !isPackage && !assignModules(ctx.arch, [target]).size ? buildGraphFromFiles(ctx.files, { aliases: ctx.arch.aliases }) : null;
  const projectFiles = project ? [...new Set([...project.files, ...files])] : files;
  const assigned = assignModules(ctx.arch, projectFiles);
  const graph = {
    root: ".",
    files: projectFiles,
    lines: {},
    edges: [planned, ...(project?.edges.filter((e) => !assigned.has(e.from)) ?? [])],
    opaque: [],
    unparsed: [],
  };
  const res = checkArchitecture(ctx.arch, graph);
  // Names and places of files are not about the import.
  const aboutFiles = new Set(ctx.arch.rules.filter((r) => r.type === "naming" || r.type === "placement").map((r) => r.id));
  const blocking = res.violations.filter((v) => !v.excepted && !aboutFiles.has(v.ruleId));
  const modOf = assignModules(ctx.arch, files);
  // What the target leads to is not known when one of these is on the way.
  const unread = project?.unparsed.map((u) => u.file) ?? [];
  const onTheWay = uncheckedPaths({ ...graph, files: [fromPath] }, unread, unread);
  const unparsed = project?.unparsed.filter((u) => onTheWay.includes(u.file)) ?? [];
  const api = new Set(ctx.arch.rules.filter((r) => r.type === "public_api").map((r) => r.id));
  const useInstead = blocking.some((v) => api.has(v.ruleId)) ? entryFiles(ctx, blocking.filter((v) => api.has(v.ruleId)).map((v) => v.ruleId)) : [];
  return {
    allowed: !unparsed.length && blocking.every((v) => v.severity !== "block"),
    fromModule: modOf.get(fromPath) ?? null,
    toModule: toPath ? (modOf.get(toPath) ?? null) : null,
    problems: blocking.map((v) => ({ rule: v.ruleId, severity: v.severity, message: v.message, fix: v.fix, why: v.rationale })),
    ...(useInstead.length ? { useInstead } : {}),
    unparsed,
  };
}

/** The files that are entries under these public_api rules, or their globs when no file matches yet. */
function entryFiles(ctx: ToolContext, ruleIds: string[]): string[] {
  const globs = ctx.arch.rules.flatMap((r) => (r.type === "public_api" && ruleIds.includes(r.id) ? r.entries : []));
  const isEntry = compileGlobs(globs);
  const files = Object.keys(ctx.files).filter((f) => isSourcePath(f) && isEntry(f)).sort();
  return files.length ? files.slice(0, 20) : [...new Set(globs)];
}

export interface ChangedFile {
  path: string;
  /** New contents, or null when the file is deleted. */
  content: string | null;
}

/** Check a set of proposed file changes and report only the violations they would introduce. */
export function checkChange(ctx: ToolContext, changes: ChangedFile[]) {
  const graphOf = (files: FileMap, configBefore?: FileMap) => buildGraphFromFiles(files, { aliases: ctx.arch.aliases, configBefore });
  const before = graphOf(ctx.files);
  const afterFiles: FileMap = { ...ctx.files };
  for (const c of changes) {
    if (c.content === null) delete afterFiles[c.path];
    else afterFiles[c.path] = c.content;
  }
  // The config files at hand are what the change starts from, so it can add to what names stand for but not take away.
  const after = graphOf(afterFiles, ctx.files);
  const known = checkArchitecture(ctx.arch, before, { baseline: ctx.baseline }).violations.map((v) => v.id);
  // What was there before is not blamed on the change, and neither is what it leaves of a cycle.
  const baseline = [...ctx.baseline, ...known];
  let res = checkArchitecture(ctx.arch, after, { baseline });
  if (needsConnections(res)) res = checkArchitecture(ctx.arch, after, { baseline, connections: moduleConnections(ctx.arch, before) });
  const introduced: Violation[] = res.violations.filter((v) => !v.baseline && !v.excepted);
  if (introduced.some((v) => res.cycles.has(v.id))) {
    const key = (from: string, to?: string, via?: string) => JSON.stringify([from, to, via ?? null]);
    const old = new Set(moduleDependencies(before, assignModules(ctx.arch, graphNodes(before))).map((d) => key(d.from, d.to, d.via)));
    introduced.forEach((v, n) => {
      const cycle = res.cycles.get(v.id);
      if (cycle) introduced[n] = locateCycle(v, cycle.modules, cycle.imports, (i) => !old.has(key(i.file, i.to, i.via)));
    });
  }
  // What these import is not known, so nothing is certain while there are any.
  const unparsed = unparsedFiles(after, ctx.arch.ignore);
  return {
    ok: !unparsed.length && !introduced.some((v) => v.severity === "block"),
    introduced: introduced.map((v) => ({
      rule: v.ruleId,
      severity: v.severity,
      file: v.file,
      message: v.message,
      fix: v.fix,
      why: v.rationale,
    })),
    unparsed,
    expiredExceptions: res.expiredExceptions.length,
    expiredOverrides: res.expiredOverrides.length,
  };
}

/** What a proposal asks for. Without one of these it is only words for a Team Leader to read. */
export interface ProposalChange {
  /** The whole architecture as it should be. */
  architecture?: Architecture;
  /** One exception to add to the current architecture. */
  exception?: Exception;
  /** Accept as debt exactly the violations on the default branch that the change would make new. */
  acceptDebt?: boolean;
}

export interface ProposalInput {
  title: string;
  summary: string;
  rationale: string;
  /** Optional concrete suggestion, for example "move shared/format to a new module". */
  suggestedChange?: string;
  requestedBy?: string;
  /** A whole architecture, validated like voxium/architecture.json. */
  architecture?: unknown;
  /** One exception to add. */
  exception?: unknown;
  acceptDebt?: boolean;
}

export interface Proposal {
  id: string;
  status: "pending_approval";
  requestedBy: string;
  createdAt: string;
  title: string;
  summary: string;
  rationale: string;
  suggestedChange: string | null;
  change: ProposalChange | null;
  approvedBy: null;
}

/** What a host may take from a proposal file. Its status, author and approver are never among it. */
export type ParsedProposal = Pick<Proposal, "title" | "summary" | "rationale" | "suggestedChange" | "change">;

/** The largest proposal file, in bytes. Hosts read proposals from pull requests, so the limits are for strangers' files too. */
export const MAX_PROPOSAL_BYTES = 64 * 1024;
const MAX_PROPOSAL_DEPTH = 16;
const TEXT_LIMITS = { title: 200, summary: 2000, rationale: 4000, suggestedChange: 2000 } as const;
const EXCEPTION_LIMITS = { rule: 200, file: 1000, owner: 100, reason: TEXT_LIMITS.rationale } as const;

/** How deeply arrays and objects nest in a JSON text, counted without parsing it. */
function jsonDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") max = Math.max(max, ++depth);
    else if (c === "}" || c === "]") depth--;
  }
  return max;
}

/** Text of a field, tidied: a title is one line, the rest keep their line breaks. Nothing invisible stays. */
function field(value: unknown, name: keyof typeof TEXT_LIMITS, errors: string[], required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) errors.push(`${name} is required.`);
    return null;
  }
  if (typeof value !== "string") {
    errors.push(`${name} must be text.`);
    return null;
  }
  const text = (name === "title" ? value.replace(/[\s\p{C}\p{Z}]+/gu, " ") : value.replace(/\r\n?/g, "\n").replace(/[^\P{C}\n]/gu, "")).trim();
  if (!text && required) errors.push(`${name} must not be empty.`);
  if (text.length > TEXT_LIMITS[name]) errors.push(`${name} may have at most ${TEXT_LIMITS[name]} characters.`);
  return text || null;
}

/**
 * An exception as a proposal may carry it. Its fields go into voxium/architecture.json, the agent rules and the pull
 * request, so they are one line with nothing invisible, within limits. Null when it is not one.
 */
function cleanException(value: unknown, label: string, errors: string[]): Exception | null {
  const problems = exceptionErrors(value);
  if (problems.length) {
    errors.push(...problems.map((e) => `${label}: ${e}`));
    return null;
  }
  const ex = value as Exception;
  const cleaned = Object.fromEntries(
    (Object.keys(EXCEPTION_LIMITS) as Array<keyof typeof EXCEPTION_LIMITS>).map((k) => [k, ex[k].replace(/\p{Cf}/gu, "").replace(/[\s\p{C}\p{Z}]+/gu, " ").trim()]),
  ) as Record<keyof typeof EXCEPTION_LIMITS, string>;
  const before = errors.length;
  for (const [k, max] of Object.entries(EXCEPTION_LIMITS) as Array<[keyof typeof EXCEPTION_LIMITS, number]>) {
    if (!cleaned[k]) errors.push(`${label}: "${k}" must not be empty.`);
    else if (cleaned[k].length > max) errors.push(`${label}: "${k}" may have at most ${max} characters.`);
  }
  return errors.length === before ? { ...cleaned, expires: ex.expires } : null;
}

function changeOf(input: { architecture?: unknown; exception?: unknown; acceptDebt?: unknown }, errors: string[]): ProposalChange | null {
  const change: ProposalChange = {};
  if (input.architecture !== undefined && input.architecture !== null) {
    const v = validateArchitecture(input.architecture);
    if (v.ok) {
      // A whole architecture brings its own exceptions, which are written out just like a single one.
      const arch = input.architecture as Architecture;
      const exceptions = arch.exceptions.map((ex, i) => cleanException(ex, `architecture: exception ${i + 1}`, errors));
      if (exceptions.every((ex) => ex !== null)) change.architecture = { ...arch, exceptions: exceptions as Exception[] };
    } else errors.push(...v.errors.map((e) => `architecture: ${e}`));
  }
  if (input.exception !== undefined && input.exception !== null) {
    const ex = cleanException(input.exception, "exception", errors);
    if (ex) change.exception = ex;
  }
  if (input.architecture && input.exception) errors.push("A proposal changes the whole architecture or adds one exception, not both.");
  if (input.acceptDebt !== undefined && typeof input.acceptDebt !== "boolean") errors.push("acceptDebt must be true or false.");
  if (input.acceptDebt === true) change.acceptDebt = true;
  return Object.keys(change).length ? change : null;
}

function proposalErrors(input: Record<string, unknown>, errors: string[]): ParsedProposal {
  const [title, summary, rationale] = (["title", "summary", "rationale"] as const).map((k) => field(input[k], k, errors, true) ?? "");
  return { title, summary, rationale, suggestedChange: field(input.suggestedChange, "suggestedChange", errors, false), change: changeOf(input, errors) };
}

/**
 * Agents may suggest architecture changes. They can never approve them.
 * This returns a pending proposal for a Team Leader, or throws when the input is not one. Persisting it is up to the host.
 */
export function createProposal(input: ProposalInput, now: Date = new Date()): Proposal {
  const errors: string[] = [];
  const parsed = proposalErrors(input as unknown as Record<string, unknown>, errors);
  if (errors.length) throw new Error(`The proposal is not valid: ${errors.join(" ")}`);
  const slug = parsed.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const proposal: Proposal = {
    id: `${now.toISOString().slice(0, 10)}_${slug || "proposal"}`,
    status: "pending_approval",
    requestedBy: input.requestedBy ?? "agent",
    createdAt: now.toISOString(),
    ...parsed,
    approvedBy: null,
  };
  const problem = proposalTextProblem(`${JSON.stringify(proposal, null, 2)}\n`);
  if (problem) throw new Error(`The proposal is not valid: ${problem}`);
  return proposal;
}

function proposalTextProblem(text: string): string | null {
  if (new TextEncoder().encode(text).length > MAX_PROPOSAL_BYTES) return `it is larger than ${MAX_PROPOSAL_BYTES / 1024} KB.`;
  if (jsonDepth(text) > MAX_PROPOSAL_DEPTH) return `it nests more than ${MAX_PROPOSAL_DEPTH} levels deep.`;
  return null;
}

/** Read a proposal file, as a host does with one from a pull request. Anything that is not a valid proposal is an error. */
export function parseProposal(text: string): { ok: true; proposal: ParsedProposal } | { ok: false; error: string } {
  const problem = typeof text === "string" ? proposalTextProblem(text) : "it is not text.";
  if (problem) return { ok: false, error: `The proposal is not valid: ${problem}` };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "The proposal is not valid JSON." };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "The proposal must be a JSON object." };
  const raw = data as Record<string, unknown>;
  const change = raw.change ?? null;
  const errors: string[] = [];
  if (change !== null && (typeof change !== "object" || Array.isArray(change))) errors.push("change must be an object.");
  const known = ["architecture", "exception", "acceptDebt"];
  const extra = change && typeof change === "object" ? Object.keys(change).filter((k) => !known.includes(k)) : [];
  if (extra.length) errors.push(`change has unknown fields: ${extra.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}.`);
  const proposal = proposalErrors({ ...raw, architecture: undefined, exception: undefined, acceptDebt: undefined, ...(change && typeof change === "object" ? change : {}) }, errors);
  return errors.length ? { ok: false, error: `The proposal is not valid: ${errors.join(" ")}` } : { ok: true, proposal };
}
