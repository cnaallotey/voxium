/**
 * Finds what loads a module in parsed code. Only direct ways to do it are followed. Every other use of what could load a
 * module is opaque, instead of being traced, so there is no way to hand it on unseen.
 */
import { parseCode, type Grammar, type Node, type Parsed } from "./parse.js";
import {
  GLOBALS, isCall, isImportMeta, isMember, isModuleModule, isOwnFile, isWritten, keyOf, memberName, namesOf, plain, textOf, TYPE_CASTS, walk, WILD, type Kind, type Names, type Place,
} from "./scope.js";

export { WILD } from "./scope.js";

export type OpaqueKind = "import" | "require" | "require_value" | "glob" | "url";

export type Found =
  | { type: "import"; pos: number; specifier: string }
  | { type: "opaque"; pos: number; kind: OpaqueKind }
  /** A module name with unknown parts. */
  | { type: "template"; pos: number; specifier: string; kind: OpaqueKind }
  /** import.meta.glob */
  | { type: "glob"; pos: number; patterns: string[] }
  /** require.context */
  | { type: "context"; pos: number; dir: string; recursive: boolean; regex: string };

export interface ScannerResult {
  found: Found[];
  /** Why the code could not be read to its end. */
  unparsed?: string;
  /** Where a syntax error was found, when that is why. */
  at?: number;
}

const MAX_GLOBS = 100;

/**
 * Properties of require that hold data, and load nothing. Every other one whose value is used is opaque: valueOf, bind and
 * the like give require itself, and others load what they are given.
 */
const REQUIRE_DATA = new Set(["length", "name", "toUrl", "config"]); // the last two are those of RequireJS in a browser
/** Those of a CommonJS module object. "parent", "children", "main" and numbers lead to other module objects. */
const MODULE_DATA = new Set(["exports", "id", "filename", "loaded", "paths", "path", "hot", "length", "isPreloading"]);
const LEADS_ON = new Set(["parent", "children", "main"]);
/** Those of a module object by which require finds what a name stands for. Writing them makes it look elsewhere. */
const WHERE = new Set(["filename", "paths", "id", "path"]);
/** Functions that write the properties of the object that they are given first. */
const WRITERS = new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf", "set"]);
/** What node:module has that loads nothing. */
const HARMLESS = new Set([
  "builtinModules", "isBuiltin", "findPackageJSON", "findSourceMap", "SourceMap", "stripTypeScriptTypes", "syncBuiltinESMExports", "constants",
  "enableCompileCache", "getCompileCacheDir", "flushCompileCache", "globalPaths", "wrap", "_nodeModulePaths", "_resolveFilename", "_resolveLookupPaths", "createRequire",
]);

const isRelative = (name: string) => /^(?:\.|[@~#]\/|\/)/.test(name);
const isBase = (n: Node) => isMember(n) && isImportMeta(plain(n.object)) && memberName(n) === "url";

interface Use {
  /** "other" hands the value on. */
  how: "call" | "member" | "init" | "assigned" | "nothing" | "other";
  at: Place;
}

/** What becomes of a value. "nothing" when it is only looked at, or written to. */
function useOf(place: Place): Use {
  let direct = true;
  for (let p = place; ; p = p.up!) {
    const { up, key } = p;
    if (!up) return { how: "other", at: p };
    const { node } = up;
    const use = (how: Use["how"], needsDirect = false): Use => ({ how: needsDirect && !direct ? "other" : how, at: up });
    if (TYPE_CASTS.has(node.type)) continue;
    switch (node.type) {
      case "SequenceExpression":
        if (node.expressions.at(-1) !== p.node) return use("other");
        continue;
      case "LogicalExpression":
        if (node.operator === "&&" && key === "left") return use("nothing");
        direct = false;
        continue;
      case "ConditionalExpression":
        if (key === "test") return use("nothing");
        direct = false;
        continue;
      case "UnaryExpression": case "BinaryExpression": case "UpdateExpression": case "ExpressionStatement":
        return use("nothing");
      case "IfStatement": case "WhileStatement": case "DoWhileStatement": case "ForStatement":
        return use(key === "body" ? "other" : "nothing");
      case "CallExpression": case "OptionalCallExpression": case "NewExpression":
        return use(key === "callee" ? "call" : "other", true);
      case "MemberExpression": case "OptionalMemberExpression": case "JSXMemberExpression":
        return use(key === "object" ? "member" : "other", true);
      case "VariableDeclarator":
        return use("init", true);
      case "AssignmentExpression":
        return key === "left" ? use(/^(?:\|\||&&|\?\?)=$/.test(node.operator) ? "other" : "nothing") : use("assigned", true);
      case "AssignmentPattern":
        return isWritten(p) || p.binding ? use("nothing") : use("assigned", true);
      case "ObjectProperty": case "ArrayPattern": case "RestElement": case "ForInStatement": case "ForOfStatement":
        return use(isWritten(p) ? "nothing" : "other");
      default:
        return use("other");
    }
  }
}

/** Whether an identifier stands for a value. Otherwise it is a name in itself, or it declares one. */
function isReference({ node, key, up, binding, type }: Place): boolean {
  if (type || binding || !up) return false;
  const parent = up.node;
  if (node.type === "JSXIdentifier") return key === "object" || (key === "name" && parent.type === "JSXOpeningElement" && !/^[a-z]/.test(node.name));
  switch (key) {
    case "property": return parent.computed === true;
    case "key": return parent.computed === true;
    case "id": case "label": case "meta": case "imported": case "exported": return false;
    case "local": return parent.type === "ExportSpecifier" && !up.up!.node.source;
    case "right": return parent.type !== "TSQualifiedName";
    case "name": return false;
    default: return true;
  }
}

class Scanner {
  readonly found: Found[] = [];
  /** Uses of a "require" property that are dealt with, and others. */
  private readonly done = new Set<Node>();
  private readonly others: Place[] = [];

  constructor(private readonly code: string, private readonly names: Names) {}

  scan(places: Place[]): Found[] {
    for (const place of places) this.visit(place);
    for (const place of this.others) if (!this.done.has(place.node)) this.otherRequire(place);
    return this.found.sort((a, b) => a.pos - b.pos);
  }

  private opaque({ node }: { node: Node }, kind: OpaqueKind = "require_value"): void {
    this.found.push({ type: "opaque", pos: node.start, kind });
  }

  private imported(node: Node | null | undefined, specifier: string = node?.value): void {
    if (node && specifier) this.found.push({ type: "import", pos: node.start, specifier });
  }

  private visit(place: Place): void {
    const { node } = place;
    switch (node.type) {
      case "ImportDeclaration": case "ExportNamedDeclaration": case "ExportAllDeclaration": case "DeclareExportDeclaration": case "DeclareExportAllDeclaration":
        this.imported(node.source);
        if (node.source && !/^type/.test(node.importKind ?? node.exportKind ?? "")) this.namesFrom(place);
        break;
      case "TSExternalModuleReference":
        this.imported(node.expression);
        break;
      case "TSImportType":
        this.imported(node.argument.type === "TSLiteralType" ? node.argument.literal : node.argument);
        break;
      case "TSQualifiedName":
        if (!place.type && (node.right.name === "require" || node.right.name === "createRequire")) this.opaque(place);
        break;
      case "ImportExpression":
        this.load(place, "import", node.source);
        if (isModuleModule(textOf(node.source))) this.moduleModule(place.up?.node.type === "AwaitExpression" ? place.up : place);
        break;
      case "CallExpression": case "OptionalCallExpression": case "NewExpression":
        this.call(place);
        break;
      case "Identifier": case "JSXIdentifier":
        if (isReference(place)) this.identifier(place);
        break;
      case "MemberExpression": case "OptionalMemberExpression": case "JSXMemberExpression":
        this.member(place);
        break;
      case "ObjectProperty":
        if (place.up?.node.type === "ObjectPattern") this.patternKey(place);
        break;
      case "WithStatement":
        this.opaque(place); // any name in it may be something else
    }
  }

  /** The names of an import, or of an export from another module. */
  private namesFrom({ node }: Place): void {
    const fromModule = isModuleModule(node.source.value);
    if (node.type === "ExportAllDeclaration" && fromModule) this.opaque({ node });
    for (const s of node.specifiers ?? []) {
      if (/^type/.test(s.importKind ?? s.exportKind ?? "")) continue;
      const spec = s.type === "ImportSpecifier" ? s.imported : s.type === "ExportSpecifier" ? s.local : null;
      const name: string | null = spec ? (spec.name ?? spec.value) : null;
      if (name === "getBuiltinModule") this.opaque({ node: s });
      else if (node.type === "ImportDeclaration") {
        if (fromModule && name !== null && !HARMLESS.has(name) && name !== "Module" && name !== "default") this.opaque({ node: s });
      } else if (name === "createRequire" || name === "require" || (fromModule && !(name !== null && HARMLESS.has(name)))) this.opaque({ node: s });
    }
  }

  private identifier(place: Place): void {
    const { node, scope } = place;
    if (!this.names.special.has(node.name)) return;
    const kind = scope.lookup(node.name);
    if (kind === "require" || kind === "elsewhere") this.require(place, kind);
    else if (kind === "maker" || (!kind && node.name === "createRequire")) this.maker(place);
    else if (kind === "module") this.moduleModule(place);
    else if (node.name === "require") this.require(place, kind ?? "require");
    else if (kind) return;
    else if (node.name === "module") this.moduleObject(place, true);
    else if (node.name === "arguments" && !scope.inFunction) this.opaque(place);
    else if (node.name === "globalThis" || node.name === "global") {
      const use = useOf(place);
      if (use.how === "init" && use.at.node.id.type === "ObjectPattern" && use.at.node.id.properties.some((p: Node) => p.type === "ObjectProperty" && keyOf(p.key, p.computed) === "require")) this.opaque(place);
    }
  }

  private member(place: Place): void {
    if (place.type) return;
    const { node, scope } = place;
    switch (memberName(node)) {
      case "createRequire":
        return this.maker(place);
      case "getBuiltinModule":
        if (useOf(place).how !== "nothing") this.opaque(place, "require");
        return;
      case "mainModule":
        return this.moduleObject(place, false);
      case "require": {
        const object = plain(node.object);
        const isGlobal = object.type === "Identifier" && (object.name === "globalThis" || object.name === "global") && !scope.lookup(object.name);
        if (isGlobal || isImportMeta(object)) this.require(place, "require");
        else this.others.push(place);
      }
    }
  }

  /** "require" of an object that is not known. */
  private otherRequire(place: Place): void {
    const use = useOf(place);
    if (use.how === "call") this.load(use.at, "require", use.at.node.arguments[0], "local");
    else if (use.how === "member") {
      const name = memberName(use.at.node);
      if ((name === null || !(REQUIRE_DATA.has(name) || name === "resolve" || name === "cache" || name === "main")) && useOf(use.at).how !== "nothing") this.opaque(place);
    }
  }

  /** In a pattern, names by which createRequire and the like are got at. */
  private patternKey({ node, scope }: Place): void {
    const key = keyOf(node.key, node.computed);
    const target = node.value.type === "AssignmentPattern" ? node.value.left : node.value;
    if (key === "getBuiltinModule" || key === "mainModule") this.opaque({ node }, "require");
    if (key !== "createRequire") return;
    const kind = target.type === "Identifier" ? scope.lookup(target.name) : "local";
    if (kind !== "maker" && !(kind === undefined && target.name === "createRequire")) this.opaque({ node });
  }

  /** "require", or what createRequire made. */
  private require(place: Place, kind: Kind): void {
    const use = useOf(place);
    // A name of its own loads nothing, as far as is known. A module that it names may all the same be one, as in what bundles wrap.
    const own = kind === "local";
    if (use.how === "call") this.load(use.at, "require", use.at.node.arguments[0], kind);
    else if (use.how === "member") {
      const name = memberName(use.at.node);
      this.done.add(use.at.node);
      if (name === "resolve") this.resolve(use.at, kind);
      else if (name === "context") {
        const call = useOf(use.at);
        if (call.how === "call") this.context(call.at);
        else if (call.how !== "nothing" && !own) this.opaque(place);
      } else if (own) return;
      else if (name === "main") this.moduleObject(use.at, false);
      else if (name === "cache") {
        const entry = useOf(use.at);
        if (entry.how === "member") this.moduleObject(entry.at, false);
        else if (entry.how !== "nothing" && !onlyNames(entry.at)) this.opaque(place);
      } else if ((name === null || !REQUIRE_DATA.has(name)) && useOf(use.at).how !== "nothing") this.opaque(place);
    } else if (use.how !== "nothing" && !own) this.opaque(place);
  }

  private resolve(place: Place, kind: Kind): void {
    const use = useOf(place);
    if (use.how === "call") {
      const args: Node[] = use.at.node.arguments;
      if (args.length < 2) this.load(use.at, "require", args[0], kind);
      else if (kind !== "local") this.opaque(use.at, "require"); // it may look elsewhere
    } else if (kind !== "local" && use.how !== "nothing" && !(use.how === "member" && memberName(use.at.node) === "paths")) this.opaque(place);
  }

  private maker(place: Place): void {
    const use = useOf(place);
    if (use.how === "nothing") return;
    const args: Node[] | undefined = use.how === "call" ? use.at.node.arguments : undefined;
    if (!args?.length) return this.opaque(place);
    const kind = isOwnFile(args[0], place.scope, this.names) ? "require" : "elsewhere";
    if (kind === "elsewhere") this.opaque(place);
    const made = useOf(use.at);
    if (made.how !== "init") return this.require(use.at, kind);
    const { id } = made.at.node;
    const bound = id.type === "Identifier" && place.scope.lookup(id.name) === kind;
    const exported = made.at.up?.up?.node.type === "ExportNamedDeclaration";
    if ((!bound || exported) && kind === "require") this.opaque(place);
  }

  /** The module "module", or the Module class in it. */
  private moduleModule(place: Place): void {
    for (let at = place; ; ) {
      const use = useOf(at);
      if (use.how === "nothing") return;
      if (use.how === "member") {
        const name = memberName(use.at.node);
        this.done.add(use.at.node);
        // What it has that loads nothing may still be put in the place of what loads, as with _resolveFilename.
        if (name !== null && HARMLESS.has(name)) return isWritten(use.at) ? this.opaque(place) : undefined;
        if (name !== "Module" && name !== "default") {
          if (name === null || useOf(use.at).how !== "nothing") this.opaque(place);
          return;
        }
        at = use.at;
      } else {
        const id: Node | undefined = use.how === "init" ? use.at.node.id : undefined;
        const known = id?.type === "Identifier" ? place.scope.lookup(id.name) === "module" && at === place
          : id?.type === "ObjectPattern" && id.properties.every((p: Node) => p.type === "ObjectProperty" && HARMLESS.has(keyOf(p.key, p.computed) ?? ""));
        if (!known) this.opaque(place);
        return;
      }
    }
  }

  /** A CommonJS module: the one the code is, or another that it leads to. */
  private moduleObject(place: Place, own: boolean): void {
    for (let at = place; ; own = false) {
      const use = useOf(at);
      if (use.how === "nothing") return;
      // Any of its ways to load something could be used from there. Other functions are given the module for other things, as in hot(module).
      if (use.how !== "member") return own && isGiven(at, use.at) && !writes(at, use.at) ? undefined : this.opaque(place);
      const name = memberName(use.at.node);
      if (name === "require") {
        this.done.add(use.at.node);
        if (own) return this.require(use.at, "require");
        const call = useOf(use.at);
        if (call.how === "nothing") return;
        this.opaque(place, call.how === "call" ? "require" : "require_value");
        if (call.how === "call") this.load(call.at, "require", call.at.node.arguments[0], "elsewhere");
        return;
      }
      if (name !== null && MODULE_DATA.has(name)) {
        // Where require looks is decided by these.
        if (WHERE.has(name) && (isWritten(use.at) || (name === "paths" && changes(use.at)))) this.opaque(place);
        return;
      }
      if (name === null ? !own : LEADS_ON.has(name) || /^\d+$/.test(name)) {
        at = use.at;
        continue;
      }
      // load, _compile, constructor, valueOf and the like, or a name that is not known.
      if (name === null || useOf(use.at).how !== "nothing") this.opaque(place);
      return;
    }
  }

  /** A call that loads what its argument names. */
  private load(place: Place, kind: "import" | "require", arg: Node | undefined, from: Kind = "require"): void {
    if (!arg) return;
    const own = from === "local";
    const name = arg.type === "SpreadElement" ? WILD : textOf(arg);
    if (!name.includes(WILD)) {
      if (from === "elsewhere" && isRelative(name)) return; // reported where it was made
      this.imported(arg, name);
      if (kind === "require" && !own && isModuleModule(name)) this.moduleModule(place);
    } else if (own || this.isResolved(arg, place)) return;
    else if (from !== "elsewhere" && name.replaceAll(WILD, "")) this.found.push({ type: "template", pos: place.node.start, specifier: name, kind });
    else this.opaque(place, kind);
  }

  /** Whether an argument is require.resolve() or import.meta.resolve() of a name, which is seen on its own. */
  private isResolved(arg: Node, { scope }: Place): boolean {
    const call = plain(arg);
    if (!isCall(call) || call.arguments.length !== 1 || textOf(call.arguments[0]).includes(WILD)) return false;
    const callee = plain(call.callee);
    if (!isMember(callee) || memberName(callee) !== "resolve") return false;
    const object = plain(callee.object);
    return isImportMeta(object) || (object.type === "Identifier" && (scope.lookup(object.name) ?? object.name) === "require");
  }

  private call(place: Place): void {
    const { node } = place;
    const callee = plain(node.callee);
    if (node.type === "NewExpression" && (isMember(callee) ? memberName(callee) : callee.name) === "URL") return this.url(place);
    if (!isMember(callee) || !isImportMeta(plain(callee.object))) return;
    switch (memberName(callee)) {
      case "resolve":
        if (node.arguments.length < 2) this.load(place, "require", node.arguments[0]);
        else this.opaque(place, "require");
        break;
      case "glob": case "globEager":
        this.glob(place);
        break;
      case "webpackContext":
        this.opaque(place, "glob");
    }
  }

  private glob({ node }: Place): void {
    const [first, options] = node.arguments as Array<Node | undefined>;
    if (!first) return;
    const list = plain(first);
    const entries: Array<Node | null> = list.type === "ArrayExpression" ? list.elements : [first];
    const patterns = entries.slice(0, MAX_GLOBS).map((e) => (e && e.type !== "SpreadElement" ? textOf(e) : WILD));
    if (entries.length > MAX_GLOBS || (options && mayMove(plain(options)))) patterns.push(WILD);
    this.found.push({ type: "glob", pos: first.start, patterns });
  }

  private context(place: Place): void {
    const [dir, recursive, regex] = (place.node.arguments as Node[]).map(plain);
    const name = dir ? textOf(dir) : ".";
    if (name.includes(WILD)) return this.opaque(place, "require");
    const pattern = regex?.type === "RegExpLiteral" ? this.code.slice(regex.start, regex.end) : "";
    this.found.push({ type: "context", pos: place.node.start, dir: name || ".", recursive: !(recursive?.type === "BooleanLiteral" && !recursive.value), regex: pattern });
  }

  /** new URL("a", import.meta.url) is relative to the file, whether it starts with a dot or not. */
  private url(place: Place): void {
    const args: Node[] = place.node.arguments;
    const spread = args.slice(0, 2).some((a) => a.type === "SpreadElement");
    if (spread || args.length < 2 || !isBase(plain(args[1]))) {
      if (args.some((a, i) => (a.type === "SpreadElement" || i > 0) && mentionsBase(a))) this.opaque(place, "url");
      return;
    }
    const text = textOf(args[0]).replace(/^[\x01-\x20]+/, ""); // as a URL does
    if (text && !text.replaceAll(WILD, "")) return this.opaque(place, "url");
    if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(text)) return;
    const path = text.replace(/[?#].*$/s, "");
    if (/(?:^|[/\\])\.{0,2}$/.test(path)) return; // a folder
    const specifier = path.startsWith(".") || path.startsWith(WILD) ? path : `./${path}`;
    if (path.includes(WILD)) this.found.push({ type: "template", pos: place.node.start, specifier, kind: "url" });
    else this.imported(args[0], specifier);
  }
}

const MEMBERS = new Set(["require", "createRequire", "getBuiltinModule", "mainModule"]);
const LOADS = new Set([
  "ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "DeclareExportDeclaration", "DeclareExportAllDeclaration", "TSExternalModuleReference", "TSImportType",
  "TSQualifiedName", "ImportExpression", "CallExpression", "OptionalCallExpression", "NewExpression", "WithStatement",
]);

/** Whether a node can load something, given the names that may. */
function matters({ node, up }: Place, names: Set<string>): boolean {
  if (node.type === "Identifier" || node.type === "JSXIdentifier") return names.has(node.name);
  if (isMember(node)) return node.computed === true || MEMBERS.has(node.property.name);
  return node.type === "ObjectProperty" ? up?.node.type === "ObjectPattern" : LOADS.has(node.type);
}

/** Whether a value is given to a function, though not to one that is right there. */
const isGiven = (at: Place, { node }: Place) => isCall(node) && node.arguments.includes(at.node) && !/Function/.test(plain(node.callee).type);

/** Whether a function that writes properties is given the value to write them to, as in Object.assign(module, x). */
function writes(at: Place, { node }: Place): boolean {
  const callee = plain(node.callee);
  const object = isMember(callee) ? plain(callee.object) : null;
  return node.arguments[0] === at.node && object?.type === "Identifier" && /^(?:Object|Reflect)$/.test(object.name) && WRITERS.has(memberName(callee) ?? "");
}

/**
 * Whether an array may be changed, or handed on to where it may be. Only its length is safe to read. Every method of
 * an array, an element that it does not have, iterating over it and logging it run code that anyone can put into
 * Array.prototype, and that code is given the array itself, as forEach and map also give it to their callback.
 */
function changes(at: Place): boolean {
  const use = useOf(at);
  const { node } = use.at;
  if (use.how === "call") return false;
  // An operator that makes a string or a number of it, or instanceof, which gives it to a function.
  if (use.how === "nothing") return node.type === "BinaryExpression" ? !/^[!=]==$/.test(node.operator) : node.type === "UnaryExpression" && /^[-+~]$/.test(node.operator);
  return !(use.how === "member" && memberName(node) === "length" && !isWritten(use.at));
}

/** Whether only the names of properties are used, as in Object.keys(x). */
function onlyNames({ node }: Place): boolean {
  if (node.type === "ForInStatement") return true;
  const callee = isCall(node) ? plain(node.callee) : null;
  return !!callee && isMember(callee) && callee.object.name === "Object" && /^(?:keys|hasOwn)$/.test(memberName(callee) ?? "");
}

/** Whether the options of import.meta.glob may change where it looks. */
function mayMove(options: Node): boolean {
  return options.type !== "ObjectExpression" || options.properties.some((p: Node) => p.type === "SpreadElement" || [null, "base", "__proto__"].includes(keyOf(p.key, p.computed)));
}

/** Whether import.meta.url is a part of an expression, as far as an ordinary one goes. */
function mentionsBase(node: Node): boolean {
  const todo = [node];
  for (let left = 50; todo.length && left > 0; left--) {
    const n = todo.pop()!;
    if (isBase(n)) return true;
    for (const key of ["argument", "arguments", "callee", "object", "left", "right", "expression", "expressions", "elements", "consequent", "alternate", "test"]) {
      for (const child of [n[key]].flat()) if (child?.type) todo.push(child);
    }
  }
  return todo.length > 0;
}

/** Everything in some pieces of code that loads a module. They have their names in common, as the scripts of a component do. */
export function scanPieces(pieces: Array<{ code: string; grammar: Grammar; /** When it was parsed before. */ parsed?: Parsed }>): ScannerResult[] {
  const parsed = pieces.map(({ code, grammar, parsed }) => parsed ?? parseCode(code, grammar));
  const results: ScannerResult[] = parsed.map(({ unparsed, at }) => (unparsed === undefined ? { found: [] } : { found: [], unparsed, ...(at === undefined ? {} : { at }) }));
  const ways = Math.max(0, ...parsed.map((p) => p.programs.length));
  const seen = results.map(() => new Set<string>());
  for (let way = 0; way < ways; way++) {
    const readable = parsed.flatMap((p, piece) => (p.programs.length ? [{ piece, program: p.programs[way] ?? p.programs[0], places: [] as Place[] }] : []));
    const names = namesOf(readable.map((r) => r.program), (place, i) => void (matters(place, GLOBALS) && readable[i].places.push(place)), readable.map((r) => pieces[r.piece].grammar.goal === "script"));
    for (const [i, { piece, program, places }] of readable.entries()) {
      // Names that the code gave to something that matters can be used before that.
      const given = new Set([...names.special].filter((n) => !GLOBALS.has(n)));
      if (given.size) walk(program, names.roots[i], names.scopes, (place) => void (given.has(place.node.name) && matters(place, given) && places.push(place)));
      for (const f of new Scanner(pieces[piece].code, names).scan(places)) {
        const id = ways > 1 ? JSON.stringify(f) : "";
        if (ways === 1 || !seen[piece].has(id)) results[piece].found.push(f);
        seen[piece].add(id);
      }
    }
  }
  if (ways > 1) for (const r of results) r.found.sort((a, b) => a.pos - b.pos);
  return results;
}

/** Everything in the code that loads a module. */
export function scanTokens(code: string, grammar: Grammar = {}): ScannerResult {
  return scanPieces([{ code, grammar }])[0];
}
