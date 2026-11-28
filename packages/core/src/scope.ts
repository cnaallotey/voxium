/** The names that code declares, as far as they decide what a "require" or "createRequire" in it is. */
import type { Node } from "./parse.js";

/** Stands for an unknown part of a module name. A real name cannot contain it. */
export const WILD = "\0";
const MAX_SPECIFIER = 4096;

/**
 * What a name stands for: something of its own, what createRequire(import.meta.url) returned, what it returned for
 * another file, createRequire, or the module that has it.
 */
export type Kind = "local" | "require" | "elsewhere" | "maker" | "module";

export class Scope {
  private readonly names = new Map<string, Kind>();
  private readonly known = new Map<string, Kind | undefined>();
  /** Where "var" ends up. */
  readonly hoisted: Scope;
  /** The outermost scopes of code that shares its names. */
  siblings: Scope[] = [];

  constructor(readonly parent: Scope | null, hoists: boolean, /** "arguments" are those of a function. */ readonly inFunction: boolean) {
    this.hoisted = hoists || !parent ? this : parent.hoisted;
  }

  declare(name: string, kind: Kind): void {
    // What else it may be does not matter next to something that loads modules. Two of these under one name are opaque where they get it.
    if ((this.names.get(name) ?? "local") === "local") this.names.set(name, kind);
  }

  /** What was looked up is forgotten once more is declared. */
  forget(): void {
    this.known.clear();
  }

  lookup(name: string): Kind | undefined {
    const passed: Scope[] = [];
    let kind: Kind | undefined;
    for (let s: Scope | null = this; s && !kind; s = s.parent) {
      if (s.known.has(name)) {
        kind = s.known.get(name);
        break;
      }
      passed.push(s);
      kind = s.names.get(name);
      for (const other of kind ? [] : s.siblings) if (other.names.get(name) !== "local") kind ??= other.names.get(name);
    }
    for (const s of passed) s.known.set(name, kind);
    return kind;
  }
}

/** A node, and where it is. */
export interface Place {
  node: Node;
  /** The property of the node above that holds it. */
  key: string;
  up: Place | null;
  scope: Scope;
  /** It declares names. */
  binding: boolean;
  /** Nothing of it is left when the code runs. */
  type: boolean;
  /** Within something that is declared to be elsewhere. */
  ambient: boolean;
}

const TYPE_KEYS = new Set(["typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeParameters", "superTypeArguments", "implements", "predicate", "variance"]);
const TYPE_NODES = new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSDeclareFunction", "TSDeclareMethod", "TSIndexSignature", "TypeAlias", "OpaqueType", "InterfaceDeclaration"]);
const isType = (n: Node) => TYPE_NODES.has(n.type) || n.type.startsWith("Declare");
const PATTERN_KEYS: Record<string, string> = { ObjectPattern: "properties", ObjectProperty: "value", ArrayPattern: "elements", AssignmentPattern: "left", RestElement: "argument", TSParameterProperty: "parameter" };

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
const BLOCKS = new Set(["BlockStatement", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement", "CatchClause", "ClassDeclaration", "ClassExpression"]);

const isFunction = (n: Node) => FUNCTIONS.has(n.type);

function scopeIn(node: Node, up: Place | null, scope: Scope): Scope {
  if (isFunction(node)) return new Scope(scope, false, scope.inFunction || node.type !== "ArrowFunctionExpression");
  if (node.type === "StaticBlock" || node.type === "TSModuleBlock") return new Scope(scope, true, scope.inFunction);
  // Parameters do not see what is declared in the body.
  if (BLOCKS.has(node.type)) return new Scope(scope, !!up && isFunction(up.node), scope.inFunction);
  return scope;
}

/** Visits every node once. Scopes are made on the first visit and stay the same on the next. */
export function walk(program: Node, root: Scope, scopes: Map<Node, Scope>, visit: (place: Place, inner: Scope) => void): void {
  const todo: Place[] = [{ node: program, key: "program", up: null, scope: root, binding: false, type: false, ambient: false }];
  for (let place = todo.pop(); place; place = todo.pop()) {
    const { node, up } = place;
    let inner = scopes.get(node);
    if (!inner) {
      inner = scopeIn(node, up, place.scope);
      if (inner !== place.scope) scopes.set(node, inner);
    }
    visit(place, inner);
    const type = place.type || isType(node);
    const ambient = place.ambient || node.declare === true || node.global === true;
    for (const key in node) {
      if (key === "loc" || key === "extra") continue;
      const value: unknown = node[key];
      if (!value || typeof value !== "object") continue;
      const binding =
        node.type === "VariableDeclarator" ? key === "id"
        : key === "params" ? isFunction(node)
        : node.type === "CatchClause" ? key === "param"
        : place.binding && PATTERN_KEYS[node.type] === key;
      const typed = type || TYPE_KEYS.has(key);
      // These are evaluated outside of what they belong to.
      const outside = key === "discriminant" || key === "decorators" || (key === "key" && isFunction(node));
      const scope = !outside ? inner : place.binding && key === "decorators" ? (place.scope.parent ?? place.scope) : place.scope;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (typeof child?.type !== "string") continue;
        // A decorator of a parameter is no part of its pattern.
        todo.push({ node: child, key, up: place, scope, binding: binding && child.type !== "Decorator", type: typed, ambient });
      }
    }
  }
}

/** Without what makes no difference to a value: types, and what is evaluated first. */
export function plain(node: Node): Node {
  for (let n = node; ; ) {
    if (TYPE_CASTS.has(n.type) || n.type === "ParenthesizedExpression") n = n.expression;
    else if (n.type === "SequenceExpression") n = n.expressions.at(-1);
    else return n;
  }
}

export const TYPE_CASTS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion", "TSNonNullExpression", "TSInstantiationExpression", "TypeCastExpression", "ParenthesizedExpression"]);

/** The text that an expression stands for, with a WILD for each part that is not known. */
export function textOf(node: Node): string {
  let text = "";
  let cooked = "";
  for (const todo: Array<Node | string> = [node]; todo.length; ) {
    const next = todo.pop()!;
    if (typeof next === "string") cooked = next;
    else {
      const n = plain(next);
      if (n.type === "StringLiteral") cooked = n.value;
      else if (n.type === "BinaryExpression" && n.operator === "+") {
        todo.push(n.right, n.left);
        continue;
      } else if (n.type === "TemplateLiteral") {
        for (let i = n.quasis.length - 1; i >= 0; i--) {
          if (i < n.expressions.length) todo.push(n.expressions[i]);
          todo.push(n.quasis[i].value.cooked ?? WILD);
        }
        continue;
      } else cooked = WILD;
    }
    if (text.length + cooked.length > MAX_SPECIFIER) return WILD;
    text += cooked;
  }
  return text;
}

/** The name of a property, "#name" when it is private, or null when it is not known. */
export function keyOf(key: Node, computed: boolean): string | null {
  if (key.type === "PrivateName") return `#${key.id.name}`;
  if (!computed && (key.type === "Identifier" || key.type === "JSXIdentifier")) return key.name;
  const n = plain(key);
  if (n.type === "NumericLiteral") return String(n.value);
  const text = textOf(n);
  return text.includes(WILD) ? null : text;
}

export const isMember = (n: Node) => n.type === "MemberExpression" || n.type === "OptionalMemberExpression" || n.type === "JSXMemberExpression";
export const isCall = (n: Node) => n.type === "CallExpression" || n.type === "OptionalCallExpression" || n.type === "NewExpression";
export const memberName = (n: Node) => keyOf(n.property, n.computed === true);

/** The names in a pattern, each with the property that it is the value of. */
function namesIn(pattern: Node): Array<{ name: string; key: string | null }> {
  const out: Array<{ name: string; key: string | null }> = [];
  for (const todo: Array<{ node: Node | null; key: string | null }> = [{ node: pattern, key: null }]; todo.length; ) {
    const { node, key } = todo.pop()!;
    if (!node) continue;
    if (node.type === "Identifier") out.push({ name: node.name, key });
    else if (node.type === "ObjectPattern") for (const p of node.properties) todo.push(p.type === "ObjectProperty" ? { node: p.value, key: keyOf(p.key, p.computed) } : { node: p, key: null });
    else if (node.type === "ArrayPattern") for (const e of node.elements) todo.push({ node: e, key: null });
    else if (node.type === "AssignmentPattern") todo.push({ node: node.left, key });
    else if (node.type === "RestElement") todo.push({ node: node.argument, key: null });
    else if (node.type === "TSParameterProperty") todo.push({ node: node.parameter, key: null });
  }
  return out;
}

/** Whether something is put there, instead of read. */
export function isWritten(place: Place): boolean {
  for (let p = place; p.up; p = p.up) {
    const { type } = p.up.node;
    if (type === "AssignmentExpression" || type === "ForInStatement" || type === "ForOfStatement") return p.key === "left";
    if (type === "UpdateExpression" || (type === "UnaryExpression" && p.up.node.operator === "delete")) return true;
    const inPattern = type === "ObjectProperty" ? p.key === "value" && p.up.up?.node.type === "ObjectPattern" : type === "AssignmentPattern" ? p.key === "left" : /^(?:Object|Array)Pattern$|^RestElement$/.test(type);
    if (!inPattern && !TYPE_CASTS.has(type)) return false;
  }
  return false;
}

export const isModuleModule = (name: unknown) => name === "module" || name === "node:module";
export const isImportMeta = (n: Node) => n.type === "MetaProperty" && n.meta.name === "import";
const FILE_NAMES = new Set(["url", "filename"]);
/** A wrapper has these as parameters, which "var" does not hide. */
const WRAPPED = new Set(["require", "module", "__filename"]);

/** Names that may stand for something that loads modules without being declared. */
export const GLOBALS = new Set(["require", "createRequire", "module", "arguments", "global", "globalThis"]);

/** What the names of some code stand for. */
export interface Names {
  scopes: Map<Node, Scope>;
  roots: Scope[];
  /** Names that stand for more than something of their own anywhere. */
  special: Set<string>;
  /** The code may have changed what its own file is called. */
  moved: boolean;
  /**
   * The code is read as a script, which Node runs as CommonJS with __filename as a parameter of its own, or it is in a
   * .cjs or .cts file, which is CommonJS also when TypeScript has to compile its import syntax. In a module __filename
   * is a global, which any other module can set.
   */
  script: boolean;
}

/**
 * Declares every name, and visits every node on the way. The programs run as one, as the scripts of a component do, though
 * a name of its own hides something only in its own program.
 */
export function namesOf(programs: Node[], visit: (place: Place, program: number) => void, commonJs: boolean[] = []): Names {
  const scopes = new Map<Node, Scope>();
  const roots = programs.map(() => new Scope(null, true, false));
  for (const r of roots) r.siblings = roots.filter((o) => o !== r);
  const special = new Set(GLOBALS);
  const names: Names = { scopes, roots, special, moved: false, script: programs.length > 0 && programs.every((p, i) => p.sourceType === "script" || commonJs[i]) };
  const values: Array<{ target: Scope; name: string; init: Node; scope: Scope }> = [];

  const add = (scope: Scope, name: string, kind: Kind) => {
    scope.declare(name, kind);
    if (kind !== "local") special.add(name);
  };
  const declare = (scope: Scope, pattern: Node) => {
    for (const { name, key } of namesIn(pattern)) add(scope, name, key === "createRequire" ? "maker" : "local");
  };
  const written = (target: Node) => {
    if (namesIn(target).some((n) => n.name === "__filename")) names.moved = true;
  };
  for (const [i, program] of programs.entries()) {
    const root = roots[i];
    walk(program, root, scopes, (place, inner) => {
      const { node, scope, up } = place;
      visit(place, i);
      if (place.type || place.ambient || node.declare === true) return;
      if (isFunction(node)) {
        for (const p of node.params) declare(inner, p);
        if (node.id && node.body) (node.type === "FunctionDeclaration" ? scope : inner).declare(node.id.name, "local");
      }
      switch (node.type) {
        case "ClassDeclaration":
          if (node.id) scope.declare(node.id.name, "local");
          break;
        case "ClassExpression":
          if (node.id) inner.declare(node.id.name, "local");
          break;
        case "CatchClause":
          if (node.param) declare(inner, node.param);
          break;
        case "VariableDeclarator": {
          const isVar = up!.node.kind === "var";
          const target = isVar ? scope.hoisted : scope;
          if (isVar && target === root) {
            // Declared once more, a parameter of the wrapper keeps its value. Given one, it has another, which for the name of the file matters.
            const given = !!node.init || /^For(?:In|Of)Statement$/.test(up!.up?.node.type ?? "");
            for (const { name, key } of namesIn(node.id)) if (key === "createRequire" || !WRAPPED.has(name) || (given && name === "__filename")) add(root, name, key === "createRequire" ? "maker" : "local");
          } else declare(target, node.id);
          if (node.init && node.id.type === "Identifier") values.push({ target, name: node.id.name, init: node.init, scope });
          break;
        }
        case "ImportDeclaration":
          if (node.importKind === "type" || node.importKind === "typeof") break;
          for (const s of node.specifiers) {
            if (s.importKind === "type" || s.importKind === "typeof") continue;
            const name: string = s.type === "ImportSpecifier" ? (s.imported.name ?? s.imported.value) : s.type === "ImportDefaultSpecifier" ? "default" : "*";
            const whole = isModuleModule(node.source.value) && (name === "default" || name === "*" || name === "Module");
            add(scope, s.local.name, name === "createRequire" ? "maker" : whole ? "module" : name === "require" || s.local.name === "require" ? "require" : "local");
          }
          break;
        case "TSImportEqualsDeclaration":
          if (node.moduleReference.type === "TSExternalModuleReference" && isModuleModule(node.moduleReference.expression.value)) add(scope, node.id.name, "module");
          break;
        case "AssignmentExpression": case "ForInStatement": case "ForOfStatement":
          written(node.left);
          break;
        case "MetaProperty": {
          let p = place;
          while (p.up && TYPE_CASTS.has(p.up.node.type)) p = p.up;
          const name = p.up && isMember(p.up.node) && p.key === "object" ? memberName(p.up.node) : null;
          if (isImportMeta(node) && (name === null || (FILE_NAMES.has(name) && isWritten(p.up!)))) names.moved = true;
        }
      }
    });
  }
  // Makers are all known by now, and what they make is never one.
  const made = values.map(({ init, scope }) => madeBy(init, scope, names));
  for (const [i, { target, name }] of values.entries()) if (made[i]) add(target, name, made[i]);
  for (const s of [...roots, ...scopes.values()]) s.forget();
  return names;
}

/** What a value is, when it is directly made by createRequire or is the module that has it. */
function madeBy(init: Node, scope: Scope, names: Names): Kind | null {
  const value = plain(init);
  const call = value.type === "AwaitExpression" ? plain(value.argument) : value;
  if (call.type === "ImportExpression") return value !== call && isModuleModule(textOf(call.source)) ? "module" : null;
  if (value !== call || !isCall(call) || !call.arguments.length) return null;
  const callee = plain(call.callee);
  if (callee.type === "Identifier") {
    if (!names.special.has(callee.name)) return null;
    const kind = scope.lookup(callee.name);
    if (kind === "maker" || (!kind && callee.name === "createRequire")) return isOwnFile(call.arguments[0], scope, names) ? "require" : "elsewhere";
    return !kind && callee.name === "require" && isModuleModule(textOf(call.arguments[0])) ? "module" : null;
  }
  return isMember(callee) && memberName(callee) === "createRequire" ? (isOwnFile(call.arguments[0], scope, names) ? "require" : "elsewhere") : null;
}

/** Whether a value is the name of the file that the code is in. */
export function isOwnFile(arg: Node, scope: Scope, names: Names): boolean {
  const n = plain(arg);
  if (names.moved) return false;
  if (n.type === "Identifier") return n.name === "__filename" && names.script && !scope.lookup("__filename");
  return isMember(n) && isImportMeta(plain(n.object)) && FILE_NAMES.has(memberName(n) ?? "");
}
