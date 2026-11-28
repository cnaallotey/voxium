/** Reads code with @babel/parser, in every way that it may be run. */
import { parse, type ParserOptions, type ParserPlugin } from "@babel/parser";

export interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: any;
}

export interface Grammar {
  /** JSX is allowed. */
  jsx?: boolean;
  /** TypeScript. The default. */
  ts?: boolean;
  /** Whether it can only be a module or a script. */
  goal?: "module" | "script";
  /** Declarations only, as in a .d.mts file. */
  dts?: boolean;
}

export interface Parsed {
  /** The program, once for each way to read it. */
  programs: Node[];
  comments: Array<{ start: number; end: number }>;
  /** Why the code could not be read to its end. */
  unparsed?: string;
  /** Where a syntax error was found, when that is why. */
  at?: number;
}

/** Larger files are not code that people write. */
export const MAX_CODE = 1_100_000;
export const TOO_LARGE = "is too large to be read";
export const TOO_MANY = "can be read in too many ways";
export const TOO_DEEP = "is nested too deeply";
/** Reasons that say nothing about whether the code is valid. */
export const LIMITS = new Set([TOO_LARGE, TOO_MANY, TOO_DEEP]);

class TooMuch extends Error {}

/** White space and comments, along with a little of what may be in front of them. */
const GAP = /[^\s/]{0,3}(?:\s|\/\/.*|\/\*[^]*?\*\/)*/y;

/**
 * The code, as a string that can be read only so often. The parser tries several ways to read some code, and tries again
 * within each of them, which can take exponential time. That is the same on every machine, unlike a time limit.
 */
class Text extends String {
  private readonly code: string;
  /** Up to where regular expressions look at it. */
  private visible: string;
  private left: number;
  private last = 0;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.visible = code;
    this.left = code.length * 4 + 300_000; // ordinary code needs less than twice its length
  }

  private spend(n: number): void {
    if ((this.left -= n) < 0) throw new TooMuch();
  }

  override charCodeAt(i: number): number {
    this.visible = this.code;
    this.last = i;
    this.spend(1);
    return this.code.charCodeAt(i);
  }

  override codePointAt(i: number): number | undefined {
    return this.code.codePointAt(i);
  }

  override startsWith(text: string, at?: number): boolean {
    return this.code.startsWith(text, at);
  }

  override slice(from?: number, to?: number): string {
    return this.code.slice(from, to);
  }

  /** The end of a comment, in which the parser then looks for line breaks. Without a limit it looks on to the next one anywhere. */
  override indexOf(text: string, from = 0): number {
    const found = this.code.indexOf(text, from);
    const end = found === -1 ? this.code.length : found;
    this.visible = this.code.slice(0, end);
    this.spend((end - from) >> 2);
    return found;
  }

  /** For a regular expression, which looks behind the next gap. */
  override toString(): string {
    if (this.visible !== this.code) this.spend(1);
    else {
      GAP.lastIndex = this.last;
      GAP.test(this.code);
      this.spend(1 + ((GAP.lastIndex - this.last) >> 2));
    }
    return this.visible;
  }
}

/** Smaller code is quick to read in any case. */
const SMALL = 20_000;
/** What code may weigh, and what its names may cost. Both are many times what they are in any real code. */
const MAX_WEIGHT = 2_000_000;
const MAX_NAMING = 8_000_000;

/** Why code takes too long to parse, though the parser reads it only once. Also for code that is parsed in parts. */
export function tooHeavy(code: string): string | undefined {
  if (code.length > MAX_CODE) return TOO_LARGE;
  if (code.length < SMALL) return undefined;
  let weight = code.length;
  let naming = 0;
  let depth = 0;
  let loops = 0; // which nest without braces
  const around: number[] = [];
  for (const [token] of code.matchAll(/[{},.`@<]|\bvar\b|\bfor\b/g)) {
    // Each of these can take the place of several other characters.
    if (token === "<") weight += 8; // type arguments are tried in several ways
    else if (token === "`" || token === "@") weight += 4;
    else if (token === ".") weight += 2;
    else if (token === "for") loops++;
    else if (token === "{") {
      weight += 4;
      around.push(depth);
      depth += 1 + loops;
      loops = 0;
    } else if (token === "}") {
      depth = around.pop() ?? 0;
      loops = 0;
    } else naming += depth + loops; // a name is taken down for every block around it
  }
  return weight > MAX_WEIGHT ? TOO_LARGE : naming > MAX_NAMING ? TOO_DEEP : undefined;
}

/**
 * How deep code is nested, by about the stack the parser needs for it. The parser is recursive, and runs out of stack at a
 * depth that depends on how warm it is, so the code that is read must stay well below the least of that, also with a third
 * of the stack in use. With these costs a cold parser on Node's default stack reads every kind of nesting as deep as is
 * accepted (150 parentheses or template literals, 123 calls in TypeScript, 422 conditionals, 565 if statements) with 40% of
 * the stack in use, measured through scanImports in a fresh process. Whatever is deeper is refused the same way every time, instead of only when the stack happens to run out.
 */
export const MAX_NESTING = 6800;
/** What one more level costs, where it is not NESTED. Chains of these the parser reads with little stack. */
const LIGHT: Record<string, number> = {
  UnaryExpression: 6, UpdateExpression: 6, BinaryExpression: 5, LogicalExpression: 5, ConditionalExpression: 16, IfStatement: 12, AssignmentExpression: 11, AwaitExpression: 7, YieldExpression: 20,
  JSXElement: 3, JSXFragment: 3, JSXExpressionContainer: 45, TSTypeAssertion: 10, TSAsExpression: 10, TSSatisfiesExpression: 10, TSNonNullExpression: 4, ObjectProperty: 12, ObjectExpression: 45, ExpressionStatement: 10, BlockStatement: 20, FunctionExpression: 40,
  FunctionDeclaration: 16, ObjectMethod: 16, ClassMethod: 16, ClassBody: 0, Program: 0, VariableDeclaration: 5, VariableDeclarator: 5, ReturnStatement: 10, TemplateElement: 0, ArrowFunctionExpression: 42, TemplateLiteral: 45,
};
/** An async or generic arrow function is read twice, first as something else. */
const ASYNC_ARROW = 55;
const NESTED = 55;
const CONSEQUENT = 20;
/** Each parenthesis around an expression, which leaves no node of its own. */
const PARENTHESIS = 45;
/** Chains that the parser reads in a loop: a.b().c, and x`y`. */
const LOOPED = new Set(["callee", "object", "tag"]);
const CHAINS = new Set(["CallExpression", "OptionalCallExpression", "MemberExpression", "OptionalMemberExpression", "JSXMemberExpression", "TaggedTemplateExpression"]);
const LEAVES = new Set(["Identifier", "StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral", "BigIntLiteral", "RegExpLiteral", "JSXText", "JSXIdentifier", "ThisExpression", "Super", "PrivateName"]);
const isLeaf = (type: string) => LEAVES.has(type) || (type.startsWith("TS") && type.endsWith("Keyword") && /^TS\w+Keyword$/.test(type));

/** Whether some code is nested more deeply than MAX_NESTING. Cold or warm, the same code gets the same answer. */
function tooDeep(program: Node, code: string): boolean {
  const nodes: Node[] = [program];
  const depths: number[] = [0];
  for (let node = nodes.pop(); node; node = nodes.pop()) {
    const depth = depths.pop()!;
    const chain = CHAINS.has(node.type);
    for (const key in node) {
      if (key === "loc" || key === "extra" || key === "comments" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      const value: unknown = node[key];
      if (!value || typeof value !== "object") continue;
      for (const child of (Array.isArray(value) ? value : [value]) as Node[]) {
        if (typeof child?.type !== "string") continue;
        const looped = chain && LOOPED.has(key);
        let cost = looped || isLeaf(child.type) ? 0 : child.type === "ArrowFunctionExpression" && (child.async || child.typeParameters) ? ASYNC_ARROW : (LIGHT[child.type] ?? NESTED);
        // What follows "?" may be the parameters of an arrow function, which TypeScript tries first.
        if (key === "consequent" && node.type === "ConditionalExpression") cost += CONSEQUENT;
        const parenStart: number | undefined = child.extra?.parenthesized ? child.extra.parenStart : undefined;
        // Comments in between may have more, which only adds to it.
        if (parenStart !== undefined) for (let i = parenStart; i < child.start; i++) if (code.charCodeAt(i) === 40) cost += PARENTHESIS;
        if (depth + cost > MAX_NESTING) return true;
        nodes.push(child);
        depths.push(depth + cost);
      }
    }
  }
  return false;
}

const COMMON: ParserPlugin[] = [
  "deprecatedImportAssert", "deferredImportEvaluation", "sourcePhaseImports", "decoratorAutoAccessors", "explicitResourceManagement", "exportDefaultFrom",
];

const LENIENT: ParserOptions = {
  allowReturnOutsideFunction: true, allowSuperOutsideMethod: true, allowNewTargetOutsideFunction: true, allowUndeclaredExports: true,
  createImportExpressions: true, attachComment: false,
};

type Attempt = { file: Node } | { error: unknown };

function attempt(code: string, plugins: ParserPlugin[], options: ParserOptions): Attempt {
  try {
    const file = parse(new Text(code) as unknown as string, { ...LENIENT, ...options, plugins }) as Node;
    // It puts some errors off.
    return file.errors?.length ? { error: file.errors[0] } : { file };
  } catch (error) {
    return { error };
  }
}

const ENDS: Record<string, string> = {
  UnterminatedString: "a string", UnterminatedTemplate: "a template literal", UnterminatedComment: "a comment", UnterminatedRegExp: "a regular expression", UnterminatedJsxContent: "JSX",
};

/** Says nothing of what is in the code, because it is stored. */
function reason(error: unknown): string {
  if (error instanceof TooMuch) return TOO_MANY;
  if (error instanceof RangeError) return TOO_DEEP;
  const { reasonCode, loc } = error as { reasonCode?: string; loc?: { line: number } };
  const end = ENDS[reasonCode ?? ""];
  return end ? `ends inside ${end}` : loc ? `cannot be parsed at line ${loc.line}` : "cannot be parsed";
}

const isLimit = (a: Attempt) => "error" in a && (a.error instanceof TooMuch || a.error instanceof RangeError);

const MODULE: ParserOptions = { sourceType: "module", allowAwaitOutsideFunction: true };
const SCRIPT: ParserOptions = { sourceType: "script" };
/** A script in which import and export may be all the same, as compilers allow it. */
const LOOSE_SCRIPT: ParserOptions = { sourceType: "script", allowImportExportEverywhere: true };

const HTML_COMMENT = /<!--|-->/;
const FLOW = /@(?:no)?flow\b/;
const MODULE_SYNTAX = /^(?:Import|Export)/;

/** The ways to run code that parse. A script may have other comments than a module, and "await" as a name. */
function asAny(code: string, plugins: ParserPlugin[], goal: Grammar["goal"]): Attempt[] {
  const html = HTML_COMMENT.test(code);
  const first = attempt(code, plugins, goal === "script" ? SCRIPT : MODULE);
  if (isLimit(first)) return [first];
  if (!("file" in first)) return goal === "module" ? [first] : [first, attempt(code, plugins, goal === "script" ? MODULE : SCRIPT)];
  const awaits = goal !== "module" && /\bawait\b/.test(code) && !first.file.program.body.some((n: Node) => MODULE_SYNTAX.test(n.type));
  return html || awaits ? [first, attempt(code, plugins, goal === "script" ? MODULE : LOOSE_SCRIPT)] : [first];
}

const hasHtmlComment = (code: string, file: Node) => file.comments.some((c: Node) => /^(?:<!|--)/.test(code.slice(c.start, c.start + 2)));

/** The code in every way that it may be run, or why that is not known. */
export function parseCode(code: string, { ts = true, jsx = false, goal, dts = false }: Grammar = {}): Parsed {
  const none = { programs: [], comments: [] };
  const heavy = tooHeavy(code);
  if (heavy) return { ...none, unparsed: heavy };
  const language: ParserPlugin[] = [...(ts ? [["typescript", { dts }] as ParserPlugin] : []), ...(jsx ? ["jsx" as const] : []), ...COMMON];
  const decorators = /@/.test(code) ? (["decorators-legacy", "decorators"] as const) : (["decorators-legacy"] as const);
  let tries: Attempt[] = [];
  for (const d of decorators) {
    tries = asAny(code, [...language, d], goal);
    if (tries.some((t) => "file" in t || isLimit(t))) break;
  }
  if (!ts && FLOW.test(code)) tries.push(...asAny(code, ["flow", ...language, "decorators-legacy"], goal));

  const limit = tries.find(isLimit);
  if (limit && "error" in limit) return { ...none, unparsed: reason(limit.error) };
  const files = tries.flatMap((t) => ("file" in t ? [t.file] : []));
  if (!files.length) {
    const { error } = tries[0] as { error: unknown };
    const at = (error as { loc?: { index?: unknown } }).loc?.index;
    return { ...none, unparsed: reason(error), ...(typeof at === "number" ? { at } : {}) };
  }
  if (files.some((f) => tooDeep(f.program, code))) return { ...none, unparsed: TOO_DEEP };
  // Nobody writes these any more, and not every compiler knows them, so where they decide they are no way to read code.
  if (files.every((f) => f.program.sourceType === "script" && hasHtmlComment(code, f))) return { ...none, unparsed: "has an HTML comment" };
  return { programs: files.map((f) => f.program), comments: files[0].comments };
}
