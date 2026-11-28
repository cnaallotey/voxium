/**
 * What a source file imports. Runs anywhere (Node, Workers, browsers).
 * parse.ts reads the code, scanner.ts finds what loads a module in it, vue.ts finds the code in single file components.
 */
import { LIMITS, MAX_CODE, parseCode, TOO_LARGE, TOO_MANY, tooHeavy, type Grammar, type Parsed } from "./parse.js";
import { scanPieces, scanTokens, WILD, type Found, type OpaqueKind } from "./scanner.js";
import { Scope, walk } from "./scope.js";
import { blankExcept, styleExpressions, templateExpressions, vueScripts, type TemplateExpression, type VueStyle, type VueTemplate } from "./vue.js";

export interface FoundImport {
  specifier: string;
  /** Line of its first use, counting from 1. */
  line: number;
}

/** Code that loads a module which cannot be told from the code. */
export interface OpaqueImport {
  line: number;
  /** import() or require() of an expression, require used as a value, or import.meta.glob of too much. */
  kind: OpaqueKind;
}

/** One expression that loads every file that fits. expand.ts says which. */
export type ManyImports =
  | { type: "template"; line: number; /** With the unknown parts between them. */ parts: string[]; kind: OpaqueKind }
  | { type: "glob"; line: number; /** Null for one that is not known. */ patterns: Array<string | null> }
  | { type: "context"; line: number; dir: string; recursive: boolean; regex: string };

export interface ImportScan {
  imports: FoundImport[];
  many: ManyImports[];
  opaque: OpaqueImport[];
  /** Why the file could not be read to its end. What it imports is not known then. */
  unparsed?: string;
}

/** Opaque imports of one file that are kept. More would say nothing new. */
export const MAX_OPAQUE = 1000;

export type ScanOptions = Pick<Grammar, "jsx" | "ts">;

/** A name that is complete before a query or a fragment. */
const QUERY = new RegExp(`^([^?#${WILD}]+)[?#].*$`, "s");

function collect(code: string, found: Found[], into: ImportScan, seen: Set<string>, firstLine: number): void {
  let line = firstLine;
  let next = code.indexOf("\n");
  const marked = new Set<string>();
  for (const f of found) {
    for (; next !== -1 && next < f.pos; next = code.indexOf("\n", next + 1)) line++;
    if (f.type === "import") {
      if (seen.has(f.specifier)) continue;
      seen.add(f.specifier);
      into.imports.push({ specifier: f.specifier, line });
    } else if (f.type === "opaque" || (f.type === "template" && !f.specifier.replaceAll(WILD, ""))) {
      const mark = `${f.kind}:${line}`;
      if (!marked.has(mark) && into.opaque.length < MAX_OPAQUE) into.opaque.push({ line, kind: f.kind });
      marked.add(mark);
    } else if (f.type === "template" && QUERY.test(f.specifier)) {
      // Only what is asked of the module is unknown, as in import(`./a.js?${Date.now()}`).
      const specifier = f.specifier.replace(QUERY, "$1");
      if (seen.has(specifier)) continue;
      seen.add(specifier);
      into.imports.push({ specifier, line });
    } else if (f.type === "template") into.many.push({ type: "template", line, parts: f.specifier.split(WILD), kind: f.kind });
    else if (f.type === "glob") into.many.push({ type: "glob", line, patterns: f.patterns.map((p) => (p.includes(WILD) ? null : p)) });
    else if (f.type === "context") into.many.push({ type: "context", line, dir: f.dir, recursive: f.recursive, regex: f.regex });
  }
}

/** Neither compilers nor Node take it for a part of the code. */
const withoutMark = (code: string) => (code.charCodeAt(0) === 0xfeff ? code.slice(1) : code);

function scanCode(code: string, grammar: Grammar): ImportScan {
  const out: ImportScan = { imports: [], many: [], opaque: [] };
  const text = withoutMark(code);
  const { found, unparsed } = scanTokens(text, grammar);
  collect(text, found, out, new Set(), 1);
  return unparsed === undefined ? out : { ...out, unparsed };
}

/** Every module some code imports, once each, in the order they appear, and what cannot be told. */
export function scanImports(code: string, opts: ScanOptions = {}): ImportScan {
  return scanCode(code, opts);
}

function grammarOf(path: string): Grammar {
  const ts = /\.[mc]?tsx?$/.test(path);
  const goal = /\.m[jt]s$/.test(path) ? "module" : /\.c[jt]s$/.test(path) ? "script" : undefined;
  return { ts, jsx: !ts || path.endsWith(".tsx"), goal, dts: /\.d\.[mc]ts$/.test(path) };
}

/** Words with which a template that is not read could load a module. */
const LOADS = /\b(?:import|require)\b/;
/** How often a template is parsed in parts, to find the expressions in it that cannot be, and how much of it, beyond the whole. */
const MAX_TRIES = 200;
const MAX_REPARSED = 2;
/** Template code is parsed in parts of about this size, so that what cannot be read in one of them is looked for only there. */
const PART = 100_000;

/** Template expressions as code, and where each came from. */
interface TemplateCode {
  code: string;
  /** Where each expression starts in the code, and in the component. */
  parts: Array<{ from: number; at: number; length: number }>;
}

/** An expression as the code that Vue makes of it. */
function wrap({ kind, text }: TemplateExpression): string {
  if (kind === "slot") return `((${text}) => 0);`;
  if (kind === "for") {
    // As Vue splits it, at the first " in " or " of " that something follows. Only that one can be, as all after it is space.
    const m = /\s(?:in|of)\s/.exec(text);
    const alias = m ? text.slice(0, m.index).trim() : "";
    const source = m ? text.slice(m.index + m[0].length).trim() : "";
    if (m && source) return `((${alias.replace(/^\(([^]*)\)$/, "$1")}) => (${source}\n));`;
  }
  // A handler, or statements.
  if (kind === "on" && !/^\s*(?:async\s*)?(?:\([^)]*?\)|[\w$]+)\s*(?::[^=]+)?=>|^\s*(?:async\s+)?function(?:\s+[\w$]+)?\s*\(|^\s*[\w$]+(?:\s*(?:\.\s*[\w$]+|\[[^\]]+\]))*\s*$/.test(text)) return `() => {${text}\n};`;
  return `(${text}\n);`;
}

function joined(expressions: TemplateExpression[]): TemplateCode {
  let code = "";
  const parts: TemplateCode["parts"] = [];
  for (const e of expressions) {
    const wrapped = wrap(e);
    const inner = wrapped.indexOf(e.text);
    parts.push({ from: code.length + Math.max(0, inner), at: e.at, length: e.text.length });
    code += `${wrapped}\n`;
  }
  return { code, parts };
}

/** Where something found in template code is in the component. */
function inComponent(pos: number, { parts }: TemplateCode): number {
  let lo = 0;
  for (let hi = parts.length - 1; lo < hi; ) {
    const mid = (lo + hi + 1) >> 1;
    if (parts[mid].from <= pos) lo = mid;
    else hi = mid - 1;
  }
  const part = parts[lo];
  return part ? part.at + Math.min(Math.max(0, pos - part.from), part.length) : 0;
}

/** Which of some expressions, joined, the code at a position belongs to. */
function partAt(pos: number, { parts }: TemplateCode): number {
  let lo = 0;
  for (let hi = parts.length - 1; lo < hi; ) {
    const mid = (lo + hi + 1) >> 1;
    if (parts[mid].from <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

interface TemplateScan {
  /** The expressions that are read as code. */
  readable: TemplateExpression[];
  opaque: Found[];
  /** The expressions are too many or too much to be read, so what they load is not known. */
  unparsed?: string;
}

const kindOf = (text: string): OpaqueKind => (/\bimport\b/.test(text) ? "import" : "require");

/**
 * The expressions of the templates, and of v-bind() in styles, and opaque reports for templates in another language or in
 * another file, or for expressions with a character reference that is not known, when they mention what loads modules.
 */
function templateCode(content: string, templates: VueTemplate[], styles: VueStyle[]): TemplateScan {
  const opaque: Found[] = [];
  const readable: TemplateExpression[] = [];
  for (const t of templates) {
    // It is compiled from a file that is not read here.
    if (t.src !== undefined) opaque.push({ type: "opaque", pos: t.start, kind: "import" });
    if (!t.html) {
      const text = content.slice(t.start, t.end);
      const m = LOADS.exec(text);
      if (m) opaque.push({ type: "opaque", pos: t.start + m.index, kind: kindOf(m[0]) });
      continue;
    }
    for (const e of templateExpressions(content, t)) {
      if (!e.text.trim()) continue;
      if (!e.unknown) readable.push(e);
      else if (LOADS.test(e.text)) opaque.push({ type: "opaque", pos: e.at, kind: kindOf(e.text) });
    }
  }
  for (const style of styles) {
    const found = styleExpressions(content, style);
    if (!found) return { readable: [], opaque, unparsed: TOO_MANY };
    readable.push(...found.filter((e) => e.text.trim()));
  }
  return { readable: readable.sort((x, y) => x.at - y.at), opaque };
}

/**
 * The expressions that can be read, of some that cannot be read together, which they are found by halves. Those that
 * cannot be are opaque when they mention what loads modules, as Vue reports them as errors. What cannot be told for a limit
 * makes the whole component unparsed. "at" is the one of them that it went wrong in first, when that is known.
 */
function readableOf(candidates: TemplateExpression[], at: number | undefined, grammar: Grammar, budget: { left: number; tries: number }): TemplateScan {
  const opaque: Found[] = [];
  /** Why some expressions cannot be read together, and which of them it went wrong in. Null when that is too much to find out. */
  const read = (list: TemplateExpression[]): { unparsed?: string; at?: number } | null => {
    const code = joined(list);
    if ((budget.left -= code.code.length) < 0 || ++budget.tries > MAX_TRIES) return null;
    const { unparsed, at } = parseCode(code.code, grammar);
    return { unparsed, at: at === undefined ? undefined : partAt(at, code) };
  };
  const readable: TemplateExpression[] = [];
  const tooMany = { readable: [], opaque, unparsed: TOO_MANY };
  // Each list here cannot be read.
  const todo: Array<{ list: TemplateExpression[]; at?: number }> = [{ list: candidates, at }];
  for (let next = todo.pop(); next; next = todo.pop()) {
    const { list, at } = next;
    if (list.length === 1) {
      // Only what is read on its own is known not to be code. A part of a list may only not go together with another.
      const r = read(list);
      if (!r) return tooMany;
      if (r.unparsed === undefined) readable.push(...list);
      else if (LIMITS.has(r.unparsed)) return { readable: [], opaque, unparsed: r.unparsed };
      else if (LOADS.test(list[0].text)) opaque.push({ type: "opaque", pos: list[0].at, kind: kindOf(list[0].text) });
      continue;
    }
    const half = list.length >> 1;
    const [a, b] = [list.slice(0, half), list.slice(half)];
    // What goes wrong in the first half goes wrong in it on its own, as its code is the beginning of that of the list.
    let wrong: { at?: number } | undefined = at !== undefined && at < half ? { at } : undefined;
    if (!wrong) {
      const r = read(a);
      if (!r) return tooMany;
      if (r.unparsed !== undefined && LIMITS.has(r.unparsed)) return { readable: [], opaque, unparsed: r.unparsed };
      if (r.unparsed === undefined) {
        readable.push(...a);
        // Then the other half cannot be read, or the two only not together, which reading them all again finds.
        todo.push({ list: b, at: at === undefined ? undefined : at - half });
        continue;
      }
      wrong = { at: r.at };
    }
    todo.push({ list: a, at: wrong.at });
    const r = read(b);
    if (!r) return tooMany;
    if (r.unparsed !== undefined && LIMITS.has(r.unparsed)) return { readable: [], opaque, unparsed: r.unparsed };
    if (r.unparsed === undefined) readable.push(...b);
    else todo.push({ list: b, at: r.at });
  }
  return { readable: readable.sort((x, y) => x.at - y.at), opaque };
}

/** The same for a file, by the kind of file it is. */
export function scanFile(path: string, content: string): ImportScan {
  if (!path.endsWith(".vue")) return scanCode(content, grammarOf(path));
  const out: ImportScan = { imports: [], many: [], opaque: [] };
  // Each script is limited, and so is the component.
  if (content.length > MAX_CODE) return { ...out, unparsed: TOO_LARGE };
  const { blocks, templates, styles, unparsed } = vueScripts(content);
  let problem = unparsed;
  const grammars = blocks.map((b) => {
    const ts = /^[cm]?tsx?$/.test(b.lang);
    return { ts, jsx: !ts || b.lang.endsWith("x") };
  });
  const grammar = { ts: grammars.some((g) => g.ts), jsx: false };
  const template = templateCode(content, templates, styles);
  problem ??= template.unparsed;
  const found: Found[] = [...template.opaque];
  const pieces: Array<{ code: string; grammar: Grammar; parsed?: Parsed }> = blocks.map((b, i) => ({ code: content.slice(b.start, b.end), grammar: grammars[i] }));
  const codes: TemplateCode[] = [];
  const whole = template.readable.length ? joined(template.readable).code : "";
  // Limits are those of all of it, though it is parsed in parts.
  const heavy = whole.length < PART ? undefined : tooHeavy(whole);
  problem ??= heavy;
  const budget = { left: MAX_REPARSED * whole.length + 100_000, tries: 0 };
  for (let i = 0; i < template.readable.length && !heavy; ) {
    const part: TemplateExpression[] = [];
    for (let size = 0; i < template.readable.length && (size < PART || !part.length); i++) {
      part.push(template.readable[i]);
      size += template.readable[i].text.length + 20;
    }
    const code = joined(part);
    const parsed = parseCode(code.code, grammar);
    if (parsed.unparsed === undefined || LIMITS.has(parsed.unparsed)) {
      pieces.push({ code: code.code, grammar, parsed });
      codes.push(code);
      continue;
    }
    // Some cannot be read. The others are read once more.
    const split = readableOf(part, parsed.at === undefined ? undefined : partAt(parsed.at, code), grammar, budget);
    problem ??= split.unparsed;
    found.push(...split.opaque);
    if (!split.readable.length) continue;
    const rest = joined(split.readable);
    pieces.push({ code: rest.code, grammar });
    codes.push(rest);
  }
  // The scripts and the template share their names.
  const scans = scanPieces(pieces);
  // All that is found, where it is in the component, so that each module is named at its first use.
  for (const [i, b] of blocks.entries()) {
    const scan = scans[i];
    if (b.src !== undefined) found.push({ type: "import", pos: b.start, specifier: b.src });
    if (b.certain) problem ??= b.problem;
    // What only looks like a script need not be valid code. What is too much to read may be.
    if (b.certain || LIMITS.has(scan.unparsed ?? "")) problem ??= scan.unparsed;
    for (const f of scan.found) found.push({ ...f, pos: f.pos + b.start });
  }
  for (const [i, code] of codes.entries()) {
    const scan = scans[blocks.length + i];
    // The expressions that were read once each were read together before.
    if (scan.unparsed !== undefined) problem ??= LIMITS.has(scan.unparsed) ? scan.unparsed : "has a template that cannot be read";
    for (const f of scan.found) found.push({ ...f, pos: inComponent(f.pos, code) });
  }
  collect(content, found.sort((a, b) => a.pos - b.pos), out, new Set(), 1);
  return problem === undefined ? out : { ...out, unparsed: problem };
}

/** Every module some code imports, once each, in the order they appear. */
export function findImports(code: string, opts: ScanOptions = {}): FoundImport[] {
  return scanImports(code, opts).imports;
}

export function extractImports(code: string, opts: ScanOptions = {}): string[] {
  return findImports(code, opts).map((i) => i.specifier);
}

/** The code without its comments and the text of its template literals, at the same positions. Code that cannot be parsed stays as it is. */
export function blankCommentsAndTemplates(code: string, opts: ScanOptions = {}): string {
  const { programs, comments } = parseCode(code, opts);
  const texts: Array<{ start: number; end: number }> = [...comments];
  if (programs.length) walk(programs[0], new Scope(null, true, false), new Map(), ({ node }) => void (node.type === "TemplateElement" && texts.push(node)));
  const parts: string[] = [];
  let done = 0;
  for (const { start, end } of texts.sort((a, b) => a.start - b.start)) {
    parts.push(code.slice(done, start), code.slice(start, end).replace(/[^\n]/g, " "));
    done = end;
  }
  parts.push(code.slice(done));
  return parts.join("");
}

/** The code in a .vue single file component, with everything else blanked so that line numbers stay the same. */
export function extractVueScript(content: string): string {
  return blankExcept(content, vueScripts(content).blocks);
}
