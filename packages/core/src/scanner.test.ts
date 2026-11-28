import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_OPAQUE, scanFile, scanImports, type ScanOptions } from "./imports.js";
import { blankCommentsAndTemplates, extractImports } from "./index.js";
import { LIMITS, TOO_DEEP } from "./parse.js";

const JS: ScanOptions = { ts: false, jsx: true };
const TS: ScanOptions = { ts: true };
const TSX: ScanOptions = { ts: true, jsx: true };

/** The modules some code imports, each as "name:line". */
function modules(code: string, opts: ScanOptions = TS): string[] {
  const { imports, unparsed } = scanImports(code, opts);
  expect(unparsed, code).toBeUndefined();
  return imports.map((i) => `${i.specifier}:${i.line}`);
}

/** Every way to read code in which it is valid. */
function everywhere(code: string): void {
  for (const opts of [JS, TS, TSX]) {
    for (const c of [`\n${code}`, /^(?:import |import\W?{|export)/.test(code) ? `if (a) {}\n;${code}` : `\nif (a) { ${code} }`]) expect(modules(c, opts), c).toContain("./a:2");
  }
}

const kinds = (code: string, opts: ScanOptions = TS) => scanImports(code, opts).opaque.map((o) => `${o.kind}:${o.line}`);

describe("imports", () => {
  it.each([
    // What was seen before.
    `import './a'`, `import "./a"`, `import x from './a'`, `import{x}from'./a'`, `import * as x from './a'`, `import x, { y } from './a'`,
    `import x,*as y from './a'`, `import from from './a'`, `import type from './a'`, `import /* ' */ x /* " */ from /* \` */ './a'`,
    `export * from './a'`, `export*from'./a'`, `export * as x from './a'`, `export { x } from './a'`, `export { from } from './a'`,
    `import('./a')`, `await import('./a')`, `const f = () => import("./a");`, `require('./a')`, `x = require( './a' ).y`, `new (require('./a'))()`,
    // String names, and attributes.
    `import { 'a' as b } from './a'`, `export { 'a' as 'b' } from './a'`, `export * as 'a b' from './a'`, `import { "from" as b } from "./a"`,
    `import x from './a' with { type: 'json' }`, `import './a' assert { type: "json" }`, `export { x } from './a' with { type: 'json' }`,
    `import('./a', { with: { type: 'json' } })`, `import('./a',)`, `require('./a',)`, `import(/* webpackChunkName: "x" */ './a')`,
    // Names that are put together.
    "import(`./a`)", "require(`./a`)", `import('./' + 'a')`, "require('.' + `/` + \"a\")", "import(('./a'))", `require((('./' + 'a')))`,
    // Escapes.
    `import '\\x2e/a'`, `import '\\u002e/\\u{61}'`, `import('./\\
a')`, `import x from '.\\/a'`, "require(`\\u002e/a`)", `r\\u0065quire('./a')`, `r\\u{65}quire('./a')`,
    // Within template literals, and as a part of them.
    "`${import('./a')}`", "`a${`b${require('./a')}c`}d`", "x`${() => { return { y: import('./a') } }}`", "`${'}'}${import('./a')}`", "import(`./${'a'}`)", "require(`${'.'}/${`a`}`)", "import('./' + `${'a'}`)",
    // Other ways to call it.
    `require?.('./a')`, `(0, require)('./a')`, `(require)('./a')`, `new require('./a')`, `module.require('./a')`, `module?.require?.('./a')`, `globalThis.require('./a')`, `globalThis['require']('./a')`, `window.require('./a')`, `x.require('./a')`,
    `require.resolve('./a')`, `require['resolve']('./a')`, `require(require.resolve('./a'))`, `import.meta.resolve('./a')`, `import(import.meta.resolve('./a'))`, `import.defer('./a')`, `import.source('./a')`,
    `new Worker(new URL('./a', import.meta.url))`, `new URL("./a", import.meta.url).href`, `new URL('a', import.meta.url)`, `new globalThis.URL('./a', import.meta.url)`, `new URL('./a', (import.meta.url))`,
    // What createRequire made for this file.
    `import { createRequire } from 'm'; const require = createRequire(import.meta.url); require('./a')`, `import { createRequire as make } from 'm'; const load = make(import.meta.url); load('./a')`,
    `import m from 'm'; const load = m.createRequire(import.meta.url); load.resolve('./a')`, `import Module from 'node:module'; const load = Module.createRequire(import.meta.url); load('./a')`, `import * as m from 'module'; m.createRequire(import.meta.url)('./a')`,
    `load('./a'); var load = module.createRequire(import.meta.url)`, `createRequire(import.meta.url)('./a')`, `createRequire(import.meta.filename).resolve('./a')`, `(createRequire)(import.meta.url)('./a')`,
    `const { createRequire: make } = require('m'); const l = make(import.meta.url); l('./a')`, `import { 'createRequire' as make } from 'm'; make(import.meta.url)('./a')`, `const { 'createRequire': make } = await import('m'); make(import.meta.url)('./a')`,
    `const { ['createRequire']: make } = m; make(import.meta.url)('./a')`, `const { createRequire: make = 1 } = m; make(import.meta.url)('./a')`, `const { b: { createRequire: make } } = m; make(import.meta.url)('./a')`, `const [{ createRequire: make }] = m; make(import.meta.url)('./a')`,
    `(({ createRequire: make }) => make(import.meta.url)('./a'))(m)`, `import { \\u0063reateRequire as make } from 'm'; make(import.meta.url)('./a')`, `const load = (0, m.createRequire)(import.meta.url); load('./a')`, `const { createRequire } = require('module'); createRequire(import.meta.url)('./a')`,
    `import { require as load } from 'm'; load('./a')`,
    // A name of its own may be what a bundle wraps, or AMD.
    `define((require) => require('./a'))`, `function f(require) { require('./a') }`,
  ])("are seen in %s", (code) => {
    everywhere(code);
  });

  it.each([
    `import type { A } from './a'`, `export type { A } from './a'`, `export type * from './a'`, `import { type A } from './a'`, `import x = require('./a')`,
    `export import x = require('./a')`, `let x: import('./a').A`, `type T = typeof import('./a')`, `let x: Array<import("./a").A<string>>`,
    `(require as any)('./a')`, `(<any>require)('./a')`, `require<T>('./a')`, `require!('./a')`, `import('./a' as string)`, `import(<any>'./a')`,
    `import('./a' satisfies string)`, `import defer * as x from './a'`,
    `import('./a' as A | B)`, `import('./a' as 'x')`, `import('./a' as \`x\`)`, `import('./a' as A.B<C>['x'])`, `import('./a' as () => string)`, `import('./a' as const)`, `import('./a' as any as string, x)`, `module['require' as any]('./a')`,
    `const load = createRequire(import.meta.url) as any as A; load('./a')`, `const f = ({ createRequire: make }): T => make(import.meta.url!)('./a')`, `const load: A | (() => B) = createRequire(import.meta.url); load('./a')`, `import m = require('module'); m.createRequire(import.meta.url)('./a')`,
    `const load: typeof require = createRequire((import.meta as any).url); load('./a')`, `import.meta.glob<A>('./b'); (import.meta as any).resolve('./a')`, `new URL('./a' as any, import.meta.url as string)`,
    `declare const require: any; require('./a')`, `declare function require(x: string): any; require('./a')`,
    // Type arguments, also nested ones.
    ...["require", "require?.", "require!", "(require)", "module.require", "globalThis.require", "require.resolve", "import.meta.resolve", "createRequire(import.meta.url)", "createRequire<A<B>>(import.meta.url)", "x < require", "x?.require"].flatMap((f) =>
      ["<A<B>>", "<Record<string, A>>", "<A<B>, C>", "<A<B<C>>>", "<(a: A<B>) => C<D>>", "<A[]>", "<{ a: A<B> }>"].map((t) => `${f}${t}('./a')`)),
  ])("are seen in TypeScript in %s", (code) => {
    expect(modules(`\n${code}`)).toContain("./a:2");
  });

  it.each([
    `// import './a'`, `/* import './a' */`, `"import './a'"`, `'require("./a")'`, "`import './a'`", "`${x} require('./a') ${y}`", `x = /import '.a'/`,
    `a.b = { import: './a' }`, `class A { import(x) {} require(y) {} }`, `x = { require(y) { return y } }`, `function require(x) {}`, `typeof require`,
    `require.main === module`, `delete require.cache[x]`, `import.meta.url`, `new URL('./a')`, `new URL('./a', base)`, `new URL('https://a.b/c', import.meta.url)`,
    `new URL('.', import.meta.url)`, `export { x }; from; './a'`, `export const from = './a'`, `x = { from: './a' }`, `require()`,
  ])("are not seen in %s", (code) => {
    for (const opts of [JS, TS, TSX]) expect(modules(code, opts)).toEqual([]);
  });

  it("are not seen in JSX text and attributes", () => {
    for (const opts of [JS, TSX]) {
      expect(modules(`<a b="import './a'">import './a'; require("./a") // {"import './a'"}</a>`, opts)).toEqual([]);
      expect(modules(`<><a/>export * from './a'</>`, opts)).toEqual([]);
    }
  });

  it("are listed once, in order, at the line of their first use", () => {
    const code = "`\n${import('./b')}`;\r\nimport './a'\r\nrequire('./b')\n\u2028import './c'";
    expect(modules(code)).toEqual(["./b:2", "./a:3", "./c:5"]);
    expect(extractImports(code)).toEqual(["./b", "./a", "./c"]);
  });

  it("are found by the kind of file", () => {
    expect(scanFile("a.ts", "x = <T>(y) => y; '</T>'; import './a'").imports).toEqual([{ specifier: "./a", line: 1 }]);
    expect(scanFile("a.tsx", "x = <T>it's</T>; import './a'").imports).toEqual([{ specifier: "./a", line: 1 }]);
    expect(scanFile("a.js", "x = <T>it's</T>; import './a'").imports).toEqual([{ specifier: "./a", line: 1 }]);
    for (const f of ["a.ts", "a.mts", "a.cts"]) expect(scanFile(f, "x = <T>it's</T>; import './a'").unparsed).toBeDefined();
  });
});

describe("imports that cannot be told", () => {
  const made = "createRequire(import.meta.url)";

  it.each([
    // A cast does not end a module name.
    ...["import", "require"].flatMap((f) => ["'' as string || './a'", "'./b' as any && './a'", "'' satisfies string || './a'", "'' as string ?? './a'", "'./b' as any ? './a' : 0", "'./b' as A | B || './a'", "'./b' as A[] || './a'",
      "'./b' as A as B || './a'", "'./b' as any - 1", "'./b' as any * 1", "'./b' as any / 1", "'./b' as any % 1", "'./b' as any ^ 1", "'./b' as any == 1", "'./b' as any !== 1", "'./b' as any in x", "('' as any || './a')", "<any>'' || './a'"].map((a) => [`${f}(${a})`, f])),
    // What createRequire made, unless it is called directly or under a name that it is given directly.
    ...[`const f = () => ${made}; f()('./a')`, `const { a: f } = { a: ${made} }; f('./a')`, `const f = { q: ${made} }.q; f('./a')`, "const f = createRequire.call(null, u); f('./a')", "const f = createRequire.bind(null)(u); f('./a')", "createRequire[x](null, u)('./a')",
      `(f = ${made})('./a')`, `g(f = ${made})`, `[${made}][0]('./a')`, `const [f] = [${made}]; f('./a')`, `q = a[x] = ${made}; a.b('./a')`, `function g() { return ${made} }`, `const f = () => g = ${made}`, `const f = (a): T => g = ${made}`, `export default ${made}`,
      `const f = a ? b : ${made}`, `const f = a || ${made}`, `\`\${${made}}\``, `x = (0, ${made}, 1)`, `new Map([[1, ${made}]])`, `export const load = ${made}`, `export const require = ${made}`, `const load = ${made}; export { load }`, `exports.load = ${made}`, `globalThis.require ??= ${made}`, `a = b = ${made}`,
      `class A { load = ${made} }`, `class A { #load = ${made} }`, `let f; f = ${made}; f('./a')`, `let f; f ||= ${made}`, `first = second = ${made}; first('./a')`, `function f(load = ${made}) {}`, `const { resolve } = ${made}`, `const load = ${made}; f(load)`, `const load = ${made}; const { resolve } = load`,
      `import { createRequire as make } from 'm'; const load = make(import.meta.url); x = load`, `const load = ${made}; load.call(null, './a')`,
      "g({ createRequire })", "module.exports = { createRequire }", "export { createRequire }", "const make = createRequire", "x(m.createRequire)", "const { createRequire: a[0] } = m".replace("const { createRequire: a[0] }", "({ createRequire: a[0] }").concat(")"), "let make; ({ createRequire: make } = m); make(u)('./a')", "({ createRequire: this.make } = m)",
      "export { createRequire as x } from 'm'", "export { 'createRequire' as x } from 'm'", "export { require } from 'm'", "export * from 'module'", "export * as m from 'node:module'", "export { default } from 'module'", "export { Module as x } from 'module'",
      "<m.createRequire/>",
      // The module that it is from.
      "import * as m from 'module'; m[x](u)('./a')", "import m from 'node:module'; f(m)", "const m = await import('module'); m[x]", "const { [x]: y } = require('module')", "const { ...m } = require('module')", "f(require('module'))", "import('module').then((m) => m[x])", "const M = require('module'); new M.Module()",
      "import { register } from 'module'", "import { getBuiltinModule as g } from 'process'; g('module')[x]", "export { getBuiltinModule } from 'node:process'", "import { runMain as r } from 'module'", "import M from 'module'; M._load('./a')", "require('module')._load('./a')", "import M from 'module'; M.prototype.require.call(m, './a')", "import { Module as M } from 'module'; M._extensions['.js'](m, './a')", "let m; m = require('module')",
      // Where it is made for another file, what it loads is somewhere else.
      "createRequire(u)('./a')", "createRequire(import.meta.url.replace('a', 'b'))('./a')", "const r = createRequire(new URL('../b/', import.meta.url)); r('./a')", "createRequire('/b/')", "const __filename = '/b/x.js'; createRequire(__filename)('./a')", "function f(__filename) { createRequire(__filename)('./a') }",
      "__filename = '/b/x.js'; createRequire(__filename)('./a')", "[__filename] = ['/b']; createRequire(__filename)('./a')", "import.meta.url = 'file:///b/'; createRequire(import.meta.url)('./a')", "Object.assign(import.meta, x); createRequire(import.meta.url)('./a')", "createRequire(...x)('./a')", "createRequire()",
      "new createRequire(u)"].map((c) => [c, "require_value"]),
    ["createRequire(import.meta.url)(v)", "require"], ["const load = createRequire(import.meta.url); load(v)", "require"], ["import { createRequire as make } from 'm'; make(import.meta.url)(v)", "require"],
    // require and what leads to one.
    ...["const f = require<any>; f('./a')", "const f = require", "f(require)", "x = { require }", "require.call(null, './a')", "require['cal' + 'l'](null, './a')", "require[x]('./a')", "(a ? require : b)('./a')", "(a || require)('./a')", "export default require", "const { resolve } = require", "[require][0]('./a')", "const f = <T,>(x = require) => x",
      "x ? (b): c => require : 0", "class A { x = a ? (b): c => f(require) : g }", "f(require, x)", "a ? (require, b) : c", "require`./a`", "export = require", "import r = require; r('./a')", "import r = module.require", "require.extensions['.x'](module, './a')", "const { resolve: r } = require", "f(require.resolve)", "async () => (await require)('./a')",
      "const r = module.require", "const { require: r } = module; r('./a')", "const { require } = globalThis", "const m = module; m.require('./b')", "(module || x).require('./a')", "(module.parent || x).require('./a')", "[module][0].require('./a')", "f(module.parent)", "f(require.main)", "(function (m) { m.parent.require('./a') })(module)", "() => module", "Object.values(require.cache)", "({ m: module })", "export default module", "m = module", "function f(m = module) {}", "module[x]('./a')", "module.constructor._load('./a')", "x = module.constructor", "module.__proto__.require", "module.load('./a')", "const p = module.parent", "x.require.call(y, './a')",
      // Ways to get require itself back, which no list of what loads can name in advance.
      "require.valueOf()('./a')", "require['valueOf']()('./a')", "(require as any).valueOf()('./a')", "require.toString.call(require)", "module.valueOf().require('./a')", "module.require.valueOf()(v)", "module.parent.valueOf().require(v)", "require.main.valueOf().require(v)", "module.children.valueOf()[0].require(v)",
      "module.children.forEach((c) => c.require('./a'))", "require.bind(null)('./a')", "require.apply.bind(require)(null, ['./a'])", "x.require.valueOf()('./a')", `const r = ${made}; r.valueOf()('./a')`, `const r = ${made}; r.bind(null)('./a')`, "import r = globalThis.require; r(v)", "with (x) y",
      // The name of the file is not that of the file once it is given another value, even with var.
      "var __filename = __dirname + '/../b/x.js'; createRequire(__filename)('./a')", "var __filename = '/b/x.js'; const load = createRequire(__filename); load('./a')", "for (var __filename of ['/b/x.js']) createRequire(__filename)('./a')", "var { __filename } = x; createRequire(__filename)('./a')",
      "Module.prototype.require.apply(module, ['./a'])", "x.require.bind(y)", "const c = require.cache[x]", "f(require.cache[x].constructor)", "f(process.mainModule.constructor)", "arguments[1]('./a')", "() => arguments", "with (module.parent) require('./a')", "const r = import.meta.require", "require.ensure(['./a'], f)", "<module.require/>"].map((c) => [c, "require_value"]),
    ...["(module as any).require(v)", "module.parent.require('./a')", "require.main.require(v)", "require.main.require('./a')", "module.children[0].require(v)", "module.parent.parent.require('./a')", "require.cache[x].require('./a')", "process.mainModule.require('./a')", "globalThis.require(v)", "import.meta.require(v)", "require<A<B>>(v)",
      "process.getBuiltinModule('fs')", "const { getBuiltinModule: g } = process", "const { mainModule: m } = process; m.require('./a')", "globalThis.process['getBuiltin' + 'Module'](x)", "require.resolve('./a', { paths: [x] })", "import.meta.resolve('./a', x)", "require.resolve(x)", "class A { x = require(v)\n y() {} }", "require.context(x)", "require.context('' || './a')", "require(x, y)", "require(f())", "require(...x)", "require(['./a'])",
      "require(x.resolve('./a'))", "const require = createRequire(import.meta.url); require(f(v))"].map((c) => [c, "require"]),
    ...["import(x ? (b): c => d : './a')", `import('./${"a".repeat(5000)}')`, "import(a ? './a' : './b')", "import(f())", "import(await x)", "import('./a'.trim())", "import(x ?? './a')", "import(x)", "import(`${x}${y}`)", "import(String.raw`./a`)", "import(['./a'])", "import(1 + 2)", "import(function () {})", "import('./a', import(x))"].map((c) => [c, "import"]),
    ...["new URL(x, import.meta.url)", "new URL(...['./a', import.meta.url])", "new URL('./a', ...[import.meta.url])", "new URL('./a', new URL('../b/', import.meta.url))", "new URL('./a', import.meta.url + '/../b/')", `new URL('./a', import.meta.url${" + a".repeat(60)})`, "new URL('./a', import.meta.url.replace('a', 'b'))", "new URL(x ? './a' : './b', import.meta.url)"].map((c) => [c, "url"]),
    ["import.meta.webpackContext('./a')", "glob"],
  ])("are named in %s", (code, kind) => {
    const opts = /<(?:m\.|module\.)/.test(code) || code.includes("<T,>") ? TSX : TS;
    const found = scanImports(`\n${code}`, opts);
    expect(found.unparsed, code).toBeUndefined();
    expect(new Set(found.opaque.map((o) => o.kind)), code).toEqual(new Set([kind]));
    expect(found.opaque[0].line).toBe(2);
  });

  it("are names with an unknown part, which expand.ts looks up", () => {
    expect(scanImports("\nimport(`./x/${y}.ts`)").many).toEqual([{ type: "template", line: 2, parts: ["./x/", ".ts"], kind: "import" }]);
    expect(scanImports("require('./x/' + y)").many).toEqual([{ type: "template", line: 1, parts: ["./x/", ""], kind: "require" }]);
    expect(scanImports("import('./b' as string + '/../a' + x)").many).toEqual([{ type: "template", line: 1, parts: ["./b/../a", ""], kind: "import" }]);
  });

  it.each([
    "class A { require(x) {} import(y) {} static async require(x) {} }; x = { import(y) {}, get require() {} }", "interface A { require?: T; import(x: T): void; require(x: T): void }", "function f(require, module) {}; (require) => 1; require => 1",
    "if (typeof require === 'function') {}; require.resolve.paths; require.resolve.paths(x); require = 1", "class A {\n  n = 1\n  require(id) { return id }\n}; class B { @Inject() require(x) {} }; class C { require<T>(x): T { return x } }", "enum A { require, import }",
    "define([], (require, exports) => {}); x = { load(require, module) {}, m(require): void {} }; class A { load(a, require) {} }; async (require, x) => 1; ({ require }) => 1", "x.then((require) => require)", "function f(require) { require(v); return require }",
    "const { require: needed } = opts; needed(x)", "process.env.require; process.argv.require", "opts.require; x(opts.require); opts.require(y); window.require(v); self.require(v)", "const { require } = opts; require(x)", "try {} catch (require) { require(x) }", "for (const require of x) require(y)",
    "{ let require; require(x) } function f() { var require; require(x) }", "class A { m() { const require = f(); return require(x) } }", "import type { createRequire } from 'module'; let x: typeof require; type A = typeof import('m'); let y: ReturnType<typeof require>",
    // Only looked at, or written to.
    "require.main === module; !module.parent; if (module.parent) {}; require && 1; if (!require) {}; require.cache[x]; delete require.cache[x]; Object.keys(require.cache); for (const k in require.cache) {}; typeof module; storiesOf('a', module); x === module; module && 1; module.exports = x; module.hot.accept(); hot(module)(x); module.id; module.children.length; module.filename; module.paths; module.loaded; module.path; require.length; require.name; module.parent.filename; require.main.filename; require.cache[x].exports; var __filename; for (var i in x) {}",
    "typeof process.getBuiltinModule; process.mainModule.filename; process.mainModule === module; 'x' in require; require instanceof Function; void require; require.config({}); require.toUrl(x)",
    // Names that are followed, or that say nothing.
    "const r = createRequire(import.meta.url)", "export const x = 1\nconst r = createRequire(import.meta.url)", "const { createRequire } = m", "const { createRequire: cr } = m", "import { createRequire as cr, x } from 'm'", "({ createRequire }) => 1", "function f({ createRequire: c }) {}", "for (const r = createRequire(import.meta.url);;) {}",
    "const r: NodeRequire = createRequire(import.meta.url)", "const r: (a: string) => any = createRequire(import.meta.url)", "const r = createRequire<A>(import.meta.url) as any as B", "let x: { createRequire: any } = y; z as any", "vi.mock('m', () => ({ createRequire: () => 1 }))", "createRequire && 1; typeof createRequire",
    "import { builtinModules, isBuiltin } from 'module'; import M from 'node:module'; M.builtinModules; const { builtinModules: b } = require('module'); require('module').isBuiltin(x); const N = require('module'); N.builtinModules", "require('module')", "function createRequire() {} f(createRequire)", "import { type createRequire as c } from 'm'; x(c)", "function f(createRequire) { return createRequire(x) }",
    // Not a loader, though it has the name of one.
    "function f() { return arguments[0] } class A { m() { arguments } }", "function f(module) { const m = module; return m.require }", "for (const module of modules) x = module", "const module = await f(); g = module[x]",
    "new URL(import.meta.url); new URL(x, y); new URL('.', import.meta.url); new URL(import.meta.url, y); new URL('https://a.b', import.meta.url); new URL(...x); new URL('../', import.meta.url); new URL('', import.meta.url)", "new URL(`../`, import.meta.url)",
    "import.meta.glob; import.meta.env[x]; import.meta.hot.accept(x)",
  ])("are not in %s", (code) => {
    const { opaque, unparsed } = scanImports(code);
    expect({ opaque, unparsed }, code).toEqual({ opaque: [], unparsed: undefined });
  });

  it("take __filename for the name of the file only in a script, where no other file can set it", () => {
    const forms = [`const { createRequire: make } = require('m'); const l = make(__filename); l('./a')`, `const { ['createRequire']: make } = m; make(__filename)('./a')`, `(({ createRequire: make }) => make(__filename)('./a'))(m)`,
      `const load = (0, m.createRequire)(__filename); load('./a')`, `const { createRequire } = require('module'); createRequire(__filename)('./a')`, `const m = require('m'); const load = m.createRequire(__filename); load.resolve('./a')`];
    for (const code of forms) {
      for (const file of ["a.cjs", "a.cts"]) expect(scanFile(file, code), `${file} ${code}`).toMatchObject({ imports: expect.arrayContaining([{ specifier: "./a", line: 1 }]), opaque: [] });
      // A module, or code that may be one, has a global __filename, which another module may have set first.
      for (const file of ["a.mjs", "a.mts", "a.js", "a.ts"]) {
        const scan = scanFile(file, code);
        expect(scan.imports.map((i) => i.specifier), `${file} ${code}`).not.toContain("./a");
        expect(scan.opaque, `${file} ${code}`).toEqual([{ line: 1, kind: "require_value" }]);
      }
    }
    expect(scanFile("a.vue", "<script setup>\nimport { createRequire } from 'node:module'\ncreateRequire(__filename)('./a')\n</script>").opaque).toEqual([{ line: 3, kind: "require_value" }]);
    expect(scanFile("a.cjs", "for (const r = createRequire(__filename);;) {}").opaque).toEqual([]);
    // TypeScript compiles a .cts file to CommonJS also when it has import syntax, which only parses as a module.
    for (const code of ["import { createRequire } from 'node:module';\nconst load = createRequire(__filename);\nload('./b');", "import fs = require('fs');\nimport { createRequire } from 'node:module';\ncreateRequire(__filename)('./b');\nexport {}"]) {
      expect(scanFile("a.cts", code), code).toMatchObject({ imports: expect.arrayContaining([{ specifier: "./b", line: 3 }]), opaque: [] });
      expect(scanFile("a.mts", code).opaque, code).toEqual([expect.objectContaining({ kind: "require_value" })]);
    }
    expect(scanFile("a.cts", "import { createRequire } from 'node:module';\nvar __filename = 'x';\ncreateRequire(__filename)('./b')").opaque).not.toEqual([]);
  });

  it("go by the scope of a name", () => {
    expect(scanImports("import { createRequire as c } from 'm'; const r = c(import.meta.url); function f(r) { r('./b'); r(v) } r('./a'); { const c = 1; c(v); f(c) }")).toMatchObject({ imports: [{ specifier: "m" }, { specifier: "./a" }], opaque: [] });
    // A parameter does not see what the body declares, and "var" does not hide what a wrapper brings.
    expect(kinds("function f(x = require(v)) { var require }")).toEqual(["require:1"]);
    expect(kinds("var require; require(v)")).toEqual(["require:1"]);
    expect(kinds("if (x) { var require; } require(v)")).toEqual(["require:1"]);
    // What is evaluated outside.
    for (const c of ["switch (require(v)) { case 1: let require }", "x = { [require(v)](require) {} }", "class A { [require(v)](require) {} }", "class A { m(@d(require(v)) require) {} }", "@d(require(v)) class A { m(require) {} }"]) expect(kinds(c), c).toEqual(["require:1"]);
    expect(kinds("{ function require() {} } require(v)")).toEqual(["require:1"]);
    expect(kinds("declare const require: any; require(v)")).toEqual(["require:1"]);
    expect(kinds("declare global { const require: any } require(v)")).toEqual(["require:1"]);
    // Nothing of these is left when the code runs.
    for (const c of ["import type { require } from 'm'", "import { type require } from 'm'", "interface require {}", "type require = 1", "declare class require {}", "const enum require {}", "namespace require { export type A = 1 }"]) expect(kinds(`${c}; require(v)`), c).toEqual(["require:1"]);
    expect(kinds("const load = createRequire(import.meta.url); { const load = 1; f(load) } load(v)")).toEqual(["require:1"]);
    expect(kinds("if (x) { var load = createRequire(import.meta.url) } load(v)")).toEqual(["require:1"]);
    expect(kinds("var load = createRequire(import.meta.url); var load = x; load(v)")).toEqual(["require:1"]);
    expect(kinds("var m = createRequire(import.meta.url); var m = require('module'); m._load('./a')")).toEqual(["require_value:1"]);
    expect(kinds("var m = require('module'); var m = createRequire(import.meta.url); m('./a')")).toEqual(["require_value:1"]);
    expect(kinds("var r = createRequire(import.meta.url); var r = createRequire(u); r('./a')")).toEqual(["require_value:1"]);
    expect(kinds("import { type module } from 'm'; f(module.constructor)")).toEqual(["require_value:1"]);
  });

  it("take the module names that are known", () => {
    expect(scanImports("createRequire(u)('pg'); const r = createRequire(u); r('react'); r('./a'); module.parent.require('x')")).toMatchObject({ imports: [{ specifier: "pg" }, { specifier: "react" }, { specifier: "x" }] });
    expect(scanImports("x.require('./a'); x.require(v); module.children[0].require('./b')").imports).toEqual([{ specifier: "./a", line: 1 }]);
  });

  it("are more globs than are looked at, and globs with options that say where", () => {
    const many = (code: string) => scanImports(code).many;
    const list = (n: number) => `import.meta.glob([${"'./a',".repeat(n)}])`;
    expect(many(list(100))).toEqual([{ type: "glob", line: 1, patterns: Array(100).fill("./a") }]);
    expect(many(list(101))).toEqual([{ type: "glob", line: 1, patterns: [...Array(100).fill("./a"), null] }]);
    for (const options of ["{ eager: true }", `{ ${" ".repeat(5000)} 'import': 'default' }`, "{ query: { base: 1 } }"]) expect(many(`import.meta.glob('./a', ${options})`), options).toEqual([{ type: "glob", line: 1, patterns: ["./a"] }]);
    for (const options of ["{ base: './b' }", "{ 'base': x }", "{ ['ba' + 'se']: x }", "{ [x]: 1 }", "{ ...x }", "{ __proto__: { base: './b' } }", "x"]) expect(many(`import.meta.glob('./a', ${options})`), options).toEqual([{ type: "glob", line: 1, patterns: ["./a", null] }]);
    expect(many("import.meta.glob<A<B>>('./a'); import.meta.globEager('./b'); (import.meta as any).glob('./c')").map((m) => m.type === "glob" && m.patterns)).toEqual([["./a"], ["./b"], ["./c"]]);
    expect(many("import.meta.glob(['./a'].concat('./b'))")).toEqual([{ type: "glob", line: 1, patterns: [null] }]);
    expect(many("import.meta.glob(['./a', ...x, , './b'])")).toEqual([{ type: "glob", line: 1, patterns: ["./a", null, null, "./b"] }]);
  });

  it("are kept up to a limit for each file", () => {
    expect(kinds("import(a)\n".repeat(MAX_OPAQUE + 10))).toHaveLength(MAX_OPAQUE);
  });

  it("are not those of which only a query is unknown", () => {
    expect(scanImports("import(`./a.js?${Date.now()}`); import('./b.js#' + x)")).toEqual({ imports: [{ specifier: "./a.js", line: 1 }, { specifier: "./b.js", line: 1 }], many: [], opaque: [] });
    expect(scanImports("import(`#a?${x}`)")).toMatchObject({ imports: [], many: [{ type: "template" }] });
  });

  it("do not let a bundle that reuses short names name everything", () => {
    const bundle = Array.from({ length: 500 }, (_, i) => `const a${i}=createRequire(import.meta.url);function b${i}(a${(i + 1) % 500}){a${(i + 1) % 500}(v)}`).join("\n");
    expect(scanImports(`${bundle}\nimport './z'`)).toMatchObject({ imports: [{ specifier: "./z" }], opaque: [] });
  });
});

/** Things with quotes in them that are read as a whole only when the code around them is understood. */
describe("code cannot hide an import", () => {
  const hidden = "\nimport('./a');\n";
  const regex = ["/`/", "/'/", '/"/g', "/[/`]/", "/\\/`/", "/[/*]/", "/[\\]'/]/", "/`/.test(x)", "/(?:`)/v", "/a\\\\/"];

  it.each([
    "", "x = ", "x\n;", "f(", "[", "x ? ", "return ", "typeof ", "x && ", "x => ", "{}\n", "if (x) ", "while (x) ", "for (const y of x) ", "else ", "do ", "x++\n;",
    "function f() {}\n", "class A {}\n", "if (x) {}", "x = {};\n", "label: ", "case 1: ", "`${", "x = y ? z : ", "async () => ", "x = {}\n;[].y, ", "function f(){}",
  ])("after a regular expression behind %j", (before) => {
    const body = (code: string) => (before.startsWith("return") ? `function f() {${code}}` : before.startsWith("case") ? `switch (x) {${code}}` : before === "else " ? `if (x) y; ${code}` : code);
    const close = { "f(": ")", "[": "]", "x ? ": ": y", "`${": "}`", "do ": ";while (x)" }[before] ?? "";
    for (const r of regex) {
      // Alone and as a pair that would swallow the middle.
      for (const end of ["", `;x = ${r}`]) {
        const code = body(`${before}${r}${close};${hidden}${end}`);
        for (const opts of [JS, TS, TSX]) expect(scanImports(code, opts), code).toMatchObject({ imports: [{ specifier: "./a" }] });
      }
    }
  });

  it.each([
    "a / ", "1 / ", "f() / ", "x[0] / ", "x++ / ", "this / ", "`a` / ", "'a' / ", "/r/ / ", "(x) / ", "({}) / ", "x.return / ", "x.if(y) / ", "x.typeof / ",
    "x = {} / ", "x = class {} / ", "x = function () {} / ", "x = y\n/ ", "x?.of / ", "super.x / ", "async / ", "of / ", "get / ", "a[''] / ",
  ])("after a division of %j", (before) => {
    const code = (quote: string) => `${before}1 + "/${quote}";${hidden}"${quote}"; 1 / 2`;
    for (const opts of [JS, TS, TSX]) for (const q of ["`", "'", "/*", "//"]) expect(scanImports(code(q), opts), code(q)).toMatchObject({ imports: [{ specifier: "./a" }] });
  });

  it("after a division of a private name", () => {
    for (const opts of [JS, TS, TSX]) expect(scanImports(`class A { #x; m(y) { #x in y / 1 + "/\`";${hidden}"\`"; 1 / 2 } }`, opts)).toMatchObject({ imports: [{ specifier: "./a" }] });
  });

  it.each([
    // The types around them decide.
    "function f(): void { let a = b\n/1+\"'`\"; import('./a'); let z = c\n/1+\"'`\" }",
    "function f(): Promise<void> { a\n/1+\"'`\"; import('./a'); c\n/1+\"'`\" }",
    "class A { m(): void { a\n/1+\"'`\"; import('./a'); c\n/1+\"'`\" } }",
    "x = { m(): Map<A, B> { a\n/1+\"'`\"; import('./a'); c\n/1+\"'`\" } }",
    "[1] as const /1+\"/`\"; import('./a'); \"`\"",
    "x = y as any / 1 + \"/`\"; import('./a'); \"`\"",
    "x = <any>/`/; import('./a'); /`/",
    "x = <any>{ f: function () {} /1+\"/`\", g: import('./a'), h: \"`\" }",
    "let x: void\n{ a\n/1+\"'`\"; import('./a'); c\n/1+\"'`\" }",
    "declare function f(): T\nx = a as {} /1+\"/`\"; import('./a'); \"`\"",
    "interface I {} abstract class Q {}/`/; import('./a'); /`/",
    "enum E {}\n/`/; import('./a'); /`/",
    "interface I {} !function () {}/1+\"/`\"; import('./a'); \"`\"",
    "@dec export class Q {}/`/; import('./a'); /`/",
    "type A = B\n/`/.test(x); import('./a'); /`/.test(x)",
    "x!\n/1+'`'; import('./a'); '`'",
    // Where a ":" ends a case, belongs to a label or starts a type.
    ...["(x): void => {}", "function (): void {}", "async (x): Promise<void> => {}", "b ? (c): d => 1 : 0", "(x): asserts x is T => {}", "<T>(x: T): T => x", "(x): (A extends B ? C : D) => {}", "(x): async => {}", "(x): A extends B ? C : D => {}", "async <T>(x): Promise<void> => {}", "async <T,>(x: T): x is T => {}", "function(x): A extends (B) ? (C) : D {}", "async function*(): A {}"].flatMap((c) => [
      `switch (1 as any) { case ${c}: {} /\`/; default: import('./a'); /\`/ }`, `switch (1 as any) { case ${c}: function f(): 'a' {} /\`/; import('./a'); /\`/ }`]),
    ...["interface A {} of", "interface A {} as", "interface A {} satisfies", "enum A {} is", "namespace A {} implements", "declare global {} of", "declare module 'm' {} as"].map((l) => `${l}: {} /\`/; import('./a'); /\`/`),
    "declare function f(): A\n as: x = a as {} /1+'/*'; import('./a'); '*/'", 
    ...["class A { readonly class\n x = 1\n", "class A { class<T>() {}", "class A { *class<T>() {}", "x = { class<T>() {},", "x = { async class<T>() {},", "x = { *class<T>() {},", "class A { x: void\nclass\n", "class A { x: B<C>\nclass\n", "class A { accessor in\n class\n", "class A { x\n in\n class\n"].flatMap((c) => [`${c} y() { function f() {} /\`/; import('./a'); /\`/ } }`, `${c} y() { l: {} /\`/; import('./a'); /\`/ } }`]),
    ...["class A { *class<T>()", "class A { async *class<T>()", "x = { *class<T>()"].map((c) => `${c} { l: {} /\`/; import('./a'); /\`/ } }`),
    "class A { x = a\n in /`/.exec(import('./a')); y = '`' }", "class A { x = a\n instanceof /`/.exec(import('./a')); y = '`' }",
    "class A { x = void class { y = 1\n z() { a: {} /`/; import('./a'); /`/ } } }",
    "x! / 1 + \"/`\"; import('./a'); \"`\"",
  ])("in TypeScript: %s", (code) => {
    expect(modules(code).map((m) => m.split(":")[0])).toEqual(["./a"]);
  });

  it.each([
    "var let = 1; let / 1 + \"/`\"; require('./a'); \"`\"",
    "a['']\nimport './a'", "a[``]\nexport { x } from './a'",
    "async function f() { await\n/`/; import('./a'); await /`/ }", "var await = 1; await / 1 + \"/`\"; require('./a'); \"`\"",
    "function* g() { yield /`/; import('./a'); yield\n/`/ }", "var yield_ = yield / 1 + \"/`\"; require('./a'); \"`\"",
    "async function f() { await\nfunction () {} /1+\"/`\"; import('./a'); \"`\" }",
    "x = () => {}\n/`/.test(y); import('./a'); /`/", "x = { f() { a\n/1+'`'; import('./a'); b\n/1+'`' } }",
    "for (const x of /`/.exec(y)) import('./a'); /`/", "for (of of /`/) import('./a'); /`/",
    "#!/usr/bin/env `node\nimport './a'; '`'", "\uFEFF#!/usr/bin/env `node\nimport './a'; '`'",
    "x = y <!-- z\nimport('./a')", "x = y <!--z; import('./a')",
    ...["", "static ", "@dec ", "a = 1\n ", "#p = (a)\n function\n ", "typeof\n ", "else\n ", "in\n "].flatMap((c) => [`class A { ${c}class\n x = 1\n y() { function f() {} /\`/; import('./a'); /\`/ } }`, `class A { ${c}class\n x = 1\n y() { l: {} /\`/; import('./a'); /\`/ } }`]),
    "class A { class\n static\n { function f() {} /`/; import('./a'); /`/ } }", "x = { class() { function f() {} /`/; import('./a'); /`/ } }",
    // Braces behind these are either a block or an object.
    "async function f() { await { a: {} /1+\"/`\", b: import('./a'), c: \"`\" } }", "var await\nawait\n{ a: {} /`/; import('./a'); /`/ }", "function* f() { yield { a: {} /1+\"/`\", b: import('./a'), c: \"`\" } }", "async function f() { for await (const x of y) /`/.test(x), import('./a'); /`/ }",
    "switch (x) { case {}/1: import('./a'); default: /`/ }", "x ? {} / 1 : /`/; import('./a'); /`/",
  ])("in JavaScript: %s", (code) => {
    expect(modules(code, JS).map((m) => m.split(":")[0])).toEqual(["./a"]);
  });

  it("behind a line break of any kind in a comment", () => {
    for (const br of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
      expect(modules(`// x${br}import './a'`).map((m) => m.split(":")[0])).toEqual(["./a"]);
      expect(modules(`x = '\\${br}'; import './a'`).map((m) => m.split(":")[0])).toEqual(["./a"]);
      expect(modules(`x = a;${br}/\`/.test(y); import './a'; y = b;${br}/\`/`).map((m) => m.split(":")[0])).toEqual(["./a"]);
    }
  });

  it.each([
    "<a>it's</a>", "<a>`</a>", "<a>/* </a>", "<a>// x</a>", "<a>\"</a>", "<a b='`'/>", "<a b=\"it's /*\"/>", "<a b={'}'} c={`}`}>'</a>", "<a>{/* ` */}</a>", "<a>{// '\n}</a>",
    "<></>", "<>'<b/>`</>", "<a.b>'</a.b>", "<a-b:c>'</a-b:c>", "<a b=<c>'</c>>`</a>", "<a {...b}>'</a>", "<a // '\n>`</a>", "<a>{<b>'</b>}`</a>", "<a>{x ? <b>'</b> : <c>`</c>}</a>",
    "x ? <a>'</a> : <b>`</b>", "<a>(</a>", "<a>[</a>", "<a>&lt;'</a>", "x && <a>'</a>", "(<a>'</a>)", "() => <a>'</a>",
  ])("after JSX: %s", (jsx) => {
    for (const opts of [JS, TSX]) {
      for (const code of [`x = ${jsx};${hidden}`, `x = ${jsx};${hidden};y = ${jsx}`, `f(${jsx}); import('./a')`, `x = <p>{${jsx}}{import('./a')}</p>`, `x = <p b={${jsx}} c={import('./a')}/>`]) {
        expect(scanImports(code, opts), code).toMatchObject({ imports: [{ specifier: "./a" }] });
      }
    }
  });

  it("after type arguments that look like JSX", () => {
    for (const t of ["a?.<string[]>(x)", "a?.<A<B>>(x)", "a?.<A|B>(x)", "a?.<typeof x>(x)", "a?.<keyof B>(x)", "a?.<A.B>(x)", "<T,>(a: T) => a", "<T extends U>(a: T) => a", "<const T,>(a: T) => a", "<T = U>(a: T) => a", "async <T,>(a: T) => a", "<A<T> b={1}/>", "f<T>('x')", "new F<T>(`x`)"]) {
      expect(modules(`x = ${t};${hidden}; '</A></T>'`, TSX).map((m) => m.split(":")[0]), t).toContain("./a");
    }
  });
});

describe("code that cannot be read to its end", () => {
  it.each([
    ["import './a'; '", "a string"], ["'\n'", "a string"], ["`", "a template literal"], ["/* ", "a comment"], ["x = /a", "a regular expression"],
  ])("is reported: %j", (code, where) => {
    expect(scanImports(code)).toMatchObject({ imports: [], unparsed: `ends inside ${where}` });
  });

  it.each(["x = <a>", "x = <a", "x = <a b='", "x = <a>{", "x = <a></b", "x = <a>{/* }</a>"] )("is reported in JSX: %j", (code) => {
    expect(scanImports(code, JS).unparsed).toMatch(/^(ends inside (JSX|a comment|a string)|cannot be parsed at line 1)$/);
  });

  it.each([
    "`${", "`${`}`", "import './a'; if (x) { f(", "}) import './a'", "\\u0069mport('./a')", "import './a'; x = a b", "import(...x)", "import()", "import '\\56/a'", "class A { #a; #a }; import './a'", "let a, a; import './a'", "x\n<!--y`\nimport './a'\n//`", "a\n--> `\nimport './a'\n//`", "x = <T>'</T>;", "a\n/`/; import './a'; b\n/`/",
  ])("is all that is not valid: %j", (code) => {
    const { imports, unparsed } = scanImports(code);
    expect({ imports, unparsed }).toEqual({ imports: [], unparsed: expect.stringMatching(/^(cannot be parsed at line \d+|ends inside a template literal|ends inside a string)$/) });
  });

  it("says nothing of what is in it", () => {
    for (const code of ["let secret; let secret", "secret = <secret>", "class A { #secret; #secret }", "export { secret }; export { secret }"]) expect(scanImports(code, JS).unparsed ?? "").not.toContain("secret");
  });

  it("is the same in every language that tools allow", () => {
    const read = (file: string, code: string) => scanFile(file, `${code}\nimport('./a')`);
    for (const code of ["@a.b() class A { @c() d; constructor(@e() f) {} }", "@(a[0]) class A {}", "export @a class A {}", "@a export class A {}", "class A { @a ['b']() {} }", "class A { accessor a = 1 }", "using x = y", "await using x = y", "return", "await x", "export { notThere }", "import a from 'b' with { c: 'd' }", "import a from 'b' assert { c: 'd' }",
      "import defer * as a from 'b'", "import source a from 'b'", "export a from 'b'", "new.target", "a ??= b; c?.d; 1_000n; /a/v", "super.x", "#!/x", "\ufeff#!/x `"]) {
      for (const file of ["a.js", "a.ts", "a.tsx", "a.mjs"]) expect(read(file, code), `${file} ${code}`).not.toHaveProperty("unparsed");
    }
    for (const code of ["with (a) b", "x = 010", "var await, yield, let, static", "delete a", "'\\07'", "arguments = eval"]) {
      for (const file of ["a.js", "a.cjs"]) expect(read(file, `${code};`), `${file} ${code}`).toMatchObject({ imports: [{ specifier: "./a" }] });
      expect(read("a.mjs", `${code};`).unparsed, code).toBeDefined();
    }
    for (const file of ["a.js", "a.mjs", "a.cjs"]) expect(read(file, "x = '<!-- -->'; // -->")).toMatchObject({ imports: [{ specifier: "./a" }] });
    const flow = "type A = {| b: ?string |};\nfunction f(a: ?A): %checks { return !!a }\nx = (y: any);";
    expect(read("a.js", `// @flow\n${flow}`)).toMatchObject({ imports: [{ specifier: "./a" }] });
    expect(read("a.js", flow).unparsed).toBeDefined();
    expect(scanFile("a.d.mts", "export declare const x: string;\nconst y: import('./a').A;\nexport {};")).toMatchObject({ imports: [{ specifier: "./a" }] });
  });

  it("may be read in several ways, all of which count", () => {
    for (const file of ["a.js", "a.ts", "a.tsx", "a.cjs", "a.cts", "a.mjs", "a.mts"]) {
      // A comment for a script, and an operator for a module.
      for (const code of ["let x = y <!-- z\nimport('./a')", "let x = y <!--z; import('./a')", "import './b'; let x = y <!-- z\nimport('./a')"]) expect(scanFile(file, code).imports, `${file} ${code}`).toContainEqual({ specifier: "./a", line: expect.any(Number) });
      // Only a comment would make it valid, and not for every tool.
      for (const code of ["let x = 1 <!-- `\nimport('./a')\n// `", "x = 1\n/*\n*/ --> `\nimport('./a')\n// `", "x = y\n--> z; import('./a')"]) expect(scanFile(file, code).unparsed, `${file} ${code}`).toMatch(/^(has an HTML comment|cannot be parsed at line \d|ends inside a template literal)$/);
    }
    // "await" is a name for a script.
    for (const file of ["a.js", "a.ts", "a.cjs"]) {
      expect(scanFile(file, "await / 1; import('./a'); / 2")).toMatchObject({ unparsed: expect.any(String) });
      expect(scanFile(file, "var b; await /1; import('./a'); b/ + 2")).toMatchObject({ imports: [{ specifier: "./a" }] });
      expect(scanFile(file, "var b; await /1; b/ + import('./a')")).toMatchObject({ imports: [{ specifier: "./a" }] });
    }
    // Once for each way to read it, though reported once.
    expect(scanImports("await x; import(y); import(`./z/${w}`); import.meta; new URL('./u', import.meta.url)")).toMatchObject({ opaque: [{ kind: "import" }], many: [{ type: "template" }], imports: [{ specifier: "./u" }] });
    expect(scanImports("await (x); import(y); import(`./z/${w}`)")).toMatchObject({ opaque: [{ kind: "import" }], many: [{ type: "template" }] });
    // As a module "await / 1; ... /g" is a regular expression around the import, as a script there is none.
    const divided = 'globalThis.await = 1;\nx = await / 1; require("..\\x2fui\\x2fsecret.cjs"); y = 2 /g';
    for (const file of ["a.js", "a.ts", "a.cjs"]) expect(scanFile(file, divided).imports, file).toEqual([{ specifier: "../ui/secret.cjs", line: 2 }]);
  });
});

describe("cost of reading hostile code", () => {
  /** Larger files are not read at all. */
  const LIMIT = 1_100_000;
  const fill = (s: string, size: number) => s.repeat(Math.ceil(size / s.length)).slice(0, size);
  /** CPU time of this thread only, so that the collector and the compiler working beside it on a busy machine do not count. */
  const time = (code: string, opts: ScanOptions) => {
    const start = process.threadCpuUsage();
    const scan = scanImports(code, opts);
    const { user, system } = process.threadCpuUsage(start);
    return { ms: (user + system) / 1000, scan };
  };
  /** Valid code of the same size, each function with a name of its own. */
  const ordinary = Array.from({ length: 20_000 }, (_, i) => `export function f${i}(a, b) { return a.map((x) => x + \`\${b}\`); }\n`).join("").slice(0, LIMIT - 1000).replace(/[^\n]*$/, "");
  /**
   * On a machine that is busy with other things a second is not much, so there ordinary code of the same size, read right
   * then, sets the limit. Three times that leaves room for noise, and exponential or quadratic cost is far beyond it.
   */
  const quick = (code: string, opts: ScanOptions) => {
    const { ms, scan } = time(code, opts);
    if (ms > 1500) {
      const read = time(ordinary, TS);
      expect(read.scan.unparsed).toBeUndefined();
      const ordinaryMs = Math.min(read.ms, time(ordinary, TS).ms);
      expect(Math.min(ms, time(code, opts).ms)).toBeLessThan(Math.max(1500, 3 * ordinaryMs));
    }
    return scan;
  };

  const KINDS = ['"', "'", "`", "<", "${", "`${", "/", "//\n", "/*", "/**/", "</", "/[", "a<b>/[", "<a>", '<a b="', "<!--", "\\", "a=b=", "x=createRequire;", "require(", "import('a'+", "x ? a : ", "()=>{}/`/\n",
    "(", "[", "{", "{}", "a=>", "(a)=>", "(a=", "(a=(", "a?(b):", "a?(b)=>", "a?(b", "async(", "async<", "<T>(", "<T,>(", "a<b,", "a<(", "f<", "a as A<", "let x:(", "let x:A<", "A extends ", "type A<T=", "x=<T>(a:A)=>", "<a b={", "<a>{", "{a:", "if(a)", "function f(){", "class A{a=", "new ", "module.parent.", "a.", "@d ",
    // Flat repeats of what may have type arguments.
    "f<T>(x);", "a<b>(c);", "a < b > (c);", "x = f<T>(y);", "a?.<T>(x);", "await (x);", "new A<T>(x);"];

  it("stays small for 4 MB of anything", () => {
    for (const s of KINDS) for (const opts of [JS, TS, TSX]) expect(quick(fill(s, 4_000_000), opts).unparsed).toBe("is too large to be read");
  });

  it.each(KINDS)("stays small for all that is read of %j", (s) => {
    for (const opts of [JS, TS, TSX]) quick(fill(s, LIMIT), opts);
  });

  it.each<[string, string, ScanOptions]>([
    ["nested parentheses in type arguments", `${"a<(b=".repeat(40)}x`, TS], ["nested generic arrow functions", "<T>(x=<U>(y=".repeat(30), TS], ["the same in TSX", "<T,>(x=<U,>(y=".repeat(30), TSX], ["nested arrow functions in conditionals", `${`a?(b,c=>${"x?(y):".repeat(40)}`}z)`, TS],
    ["nested conditionals", "x ? ([y".repeat(60), TS], ["nested async arrow functions", "async (a=async <T>(b=".repeat(40), TS], ["nested elements", "<a>{x?<b>:".repeat(40), TSX], ["elements in arrow functions", "x=<a b={y=>".repeat(40), TSX], ["parameters", "(a=(".repeat(25), TS],
    ["a long comment in what is tried often", `${"async (a=".repeat(30)}/*${"a".repeat(1_000_000)}*/x`, TSX], ["a long gap in what is tried often", `${"x<T>(".repeat(30)}${" ".repeat(1_000_000)};`, TS], ["comments on one line", fill("/*#__PURE__*/f();", LIMIT), JS],
    ["names in nested blocks", "{".repeat(600) + "var a;".repeat(150_000) + "}".repeat(600), JS], ["more names in nested blocks", `${"{".repeat(1000)}var ${"a,".repeat(400_000)}a${"}".repeat(1000)}`, TS], ["names in nested loops", `${"for(;;)".repeat(1000)}{var ${"a,".repeat(400_000)}a}`, JS],
    ["uses in nested blocks", "{".repeat(900) + "require;".repeat(120_000) + "}".repeat(900), JS], ["uses in nested conditionals", `${"x?require:".repeat(1200)}y;${fill("x?require:y;", 900_000)}`, JS], ["a chain of uses", `require${"||require".repeat(2000)};${fill("f(require);", 900_000)}`, JS], ["a chain of modules", `module${".parent".repeat(160_000)}`, JS],
    ["many names for what was made", Array.from({ length: 20_000 }, (_, i) => `const a${i}=createRequire(import.meta.url);a${i}(v);`).join(""), JS], ["new URL within another", `x=${"new URL(a,".repeat(800)}b${")".repeat(800)}`, JS],
  ])("stays small for %s", (_, code, opts) => {
    quick(code, opts);
  });

  it.each(["(", "[", "{", "<a>", "x={a:", "f(() => {", "`${", "a?", "!", "a=>", "if(a)", "else "])("is refused for what is nested too deeply: %j", (s) => {
    expect(quick(s.repeat(100_000), JS).unparsed).toMatch(/^(is nested too deeply|cannot be parsed at line 1)$/);
  });

  describe("nesting", () => {
    const nested = (open: string, close: string, n: number) => `x = ${open.repeat(n)}${open === "<a>" ? "" : "1"}${close.repeat(n)};\nrequire('./s')`;
    const CONSTRUCTS: Array<[string, string, ScanOptions]> = [
      ["(", ")", TS], ["[", "]", TS], ["{a:", "}", TS], ["f(", ")", TS], ["f(() => {", "})", TS], ["`${", "}`", TS], ["a ? b : ", "", TS], ["'a' + ", "", TS], ["!", "", TS], ["x => ", "", TS],
      ["async () => ", "", TS], ["function f() {", "}", TS], ["a = ", "", TS], ["<a>", "</a>", TSX], ["<a>{", "}</a>", TSX], ["<a b={", "}/>", TSX], ["a[", "]", TS], ["((", "))", TS], ["[(", ")]", TS], ["(<any>", ")", TS], ["await ", "", TS], ["new ", "", JS],
      ["typeof ", "", TS], ["class A { m() {", "} }", TS], ["{ if (a) {", "} }", TS], ["a?.[", "]", TS], ["{a:[", "]}", TS], ["(a, ", ")", TS], ["a ? (", ") : 1", TS], ["x satisfies ", "", TS],
      ["async (a) => ", "", TS], ["<T>(x: T) => ", "", TS], ["() => () => ", "", TS], ["function* g() { yield ", "}", TS], ["(function () { return ", "})", TS], ["async function f() { await ", "}", TS],
      ["a ?? ", "", TS], ["{a:`${", "}`}", TS], ["x`${", "}`", TS], ["<a>{() => ", "}</a>", TSX], ["a ? b : (", ")", TS],
    ];
    /** The scanner as it ships, bundled once, so that a process of its own can load it cold. */
    let bundle = "";
    const product = (): string => {
      if (!bundle) {
        bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "voxium-cold-")), "imports.cjs");
        buildSync({ entryPoints: [path.join(import.meta.dirname, "imports.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" });
      }
      return bundle;
    };
    afterAll(() => {
      if (bundle) fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
    });
    /**
     * What the scanner, cold in a process of its own, makes of some code with a share of its stack in use: "deep" when it
     * runs out of it. It goes through scanImports with all its grammars, as the product does. The stack is filled with
     * frames of one size, which are never optimized, so that the share is one of the bytes of the stack, not only of the frames.
     */
    const coldWith = (code: string, opts: ScanOptions | { file: string }, share: number): string => {
      const scan = "file" in opts ? `scanFile(${JSON.stringify(opts.file)}, code)` : `scanImports(code, ${JSON.stringify(opts)})`;
      const child = `const { scanFile, scanImports } = require(${JSON.stringify(product())}); const code = require("fs").readFileSync(0, "utf8"); let least = 0;
        function fill(n, f) { least = n; return n <= 0 ? f() : fill(n - 1, f); }
        %NeverOptimizeFunction(fill);
        try { fill(1e9, () => 0) } catch {}
        let out = "ok";
        try { const scan = fill(Math.floor((1e9 - least) * ${share}), () => ${scan}); if (scan.unparsed === ${JSON.stringify(TOO_DEEP)}) out = "deep" } catch (e) { out = e instanceof RangeError ? "deep" : "error" }
        process.stdout.write(out)`;
      return execFileSync(process.execPath, ["--allow-natives-syntax", "-e", child], { input: code, encoding: "utf8", timeout: 60_000 });
    };
    /** Runs f with only part of the stack left, as when the parser is called from deep down in a framework. */
    const withLessStack = <T,>(share: number, f: () => T): T => {
      let capacity = 0;
      const probe = (n: number): number => (capacity = n, probe(n + 1) + 1);
      try {
        probe(0);
      } catch {
        // as deep as it goes
      }
      const use = (n: number): T => (n <= 0 ? f() : [use(n - 1)][0]);
      return use(Math.floor(capacity * share));
    };

    it("is refused the same way, cold or warm, past where a cold parser runs out of stack", () => {
      // The depths at which the parser ran out of stack when cold, or only when warm, in the attack.
      const deep: Array<[string, string, number]> = [["(", ")", 400], ["(", ")", 600], ["'a' + ", "", 5000], ["[", "]", 450], ["f(", ")", 450], ["a ? b : ", "", 4500]];
      const verdicts = () => [...deep.map(([o, c, n]) => scanImports(nested(o, c, n), TS).unparsed), scanImports(`${"if (a) b; else ".repeat(3200)}c;\nrequire('./s')`, TS).unparsed];
      const first = verdicts();
      for (let i = 0; i < 200; i++) scanImports(`x = ${"(".repeat(i % 50)}1${")".repeat(i % 50)}; f(g(h(1)))`, TS);
      for (let i = 0; i < 3; i++) expect(verdicts()).toEqual(first);
      expect(new Set(first)).toEqual(new Set(["is nested too deeply"]));
    });

    /** Statements, which nest without an expression around them. */
    const statements = (open: string, close: string, n: number) => `${open.repeat(n)}x;${close.repeat(n)}\nrequire('./s')`;
    const STATEMENTS: Array<[string, string, ScanOptions]> = [
      ["if (a) ", "", TS], ["if (a) ", "", JS], ["if (a) ", "", TSX], ["if (a) b; else ", "", TS], ["if (a) b; else if (a) ", "", TS], ["if (a) {", "}", TS], ["while (a) ", "", TS], ["for (;;) ", "", TS],
      ["for (a of b) ", "", TS], ["for (a in b) ", "", TS], ["do ", " while (a)", TS], ["{ ", "}", TS], ["try { ", "} finally {}", TS], ["switch (a) { case 1: ", "}", TS],
    ];
    const all: Array<[string, string, ScanOptions, typeof nested]> = [...CONSTRUCTS.map(([o, c, opts]) => [o, c, opts, nested] as [string, string, ScanOptions, typeof nested]), ...STATEMENTS.map(([o, c, opts]) => [o, c, opts, statements] as [string, string, ScanOptions, typeof nested])];

    it.each(all)("is read up to the limit with more than a third of the stack in use, cold or warm: %j %j", (open, close, opts, nested) => {
      let lo = 1;
      let hi = 20_000;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (LIMITS.has(scanImports(nested(open, close, mid), opts).unparsed ?? "")) hi = mid;
        else lo = mid;
      }
      expect(LIMITS.has(scanImports(nested(open, close, hi), opts).unparsed ?? ""), `${open} x${hi}`).toBe(true);
      // A parser that has read nothing yet needs the most stack. With more than a third of the stack in use it still reads what is accepted.
      expect(coldWith(nested(open, close, lo), opts, 0.4), `${open} x${lo}, cold`).not.toBe("deep");
      // And so does a warm one, here.
      const below = withLessStack(1 / 3, () => scanImports(nested(open, close, lo), opts));
      expect(below.unparsed ?? "", `${open} x${lo}`).toMatch(/^(?:|cannot be parsed.*)$/);
      if (below.unparsed === undefined) expect(below.imports).toEqual([{ specifier: "./s", line: 2 }]);
    });

    it("reads a chain of statements in a component the same way cold as warm, at the deepest that is accepted", () => {
      const component = (n: number) => `<template><p/></template>\n<script setup lang="ts">\n${"if (a) ".repeat(n)}x;\nrequire('./s')\n</script>\n`;
      let n = 1;
      while (scanFile("c.vue", component(n * 2)).unparsed === undefined) n *= 2;
      for (let step = n >> 1; step; step >>= 1) if (scanFile("c.vue", component(n + step)).unparsed === undefined) n += step;
      expect(scanFile("c.vue", component(n + 1)).unparsed).toBe(TOO_DEEP);
      expect(coldWith(component(n), { file: "c.vue" }, 0), `x${n}`).toBe("ok");
      expect(coldWith(component(n), { file: "c.vue" }, 0.4), `x${n}`).toBe("ok");
    });
  });

  it("does not get in the way of code that is nested as deeply as any is", () => {
    const deep: Array<[string, string, number]> = [["(", ")", 60], ["[", "]", 60], ["`${", "}`", 60], ["{", "}", 60], ["<a>", "</a>", 60], ["f({a:", "})", 50], ["f(() => {", "})", 50], ["if (a) b; else ", ";", 400], ["a ? b : ", "", 400], ["'a' + ", "", 1000]];
    for (const [open, close, depth] of deep) {
      const code = `${open.repeat(depth)}${open === "<a>" ? "" : "1"}${close.repeat(depth)}\n;import './a'`;
      expect(scanImports(code, JS), open).toMatchObject({ imports: [{ specifier: "./a" }] });
    }
    // Things that are tried in more than one way, as deep as people write them.
    for (const [open, close] of [["f<T>((a: A) => ", ")"], ["async <T,>(a: A): Promise<B> => (", ")"], ["a ? (b: A) => c : (", ")"], ["a ? (b) : (", ")"], ["(a: A = ", ") => 1"], ["x => <a b={", "}/>"]]) {
      const code = `x = ${open.repeat(8)}1${close.repeat(8)}\n;import './a'`;
      expect(scanImports(code, TSX), open).toMatchObject({ imports: [{ specifier: "./a" }] });
    }
  });

  it("does not get in the way of generated code", () => {
    for (const s of ["export const a = [1,2,3,4,5,6,7,8];\n".replace("a", "a"), "'a',\n", "{\"a\":{\"b\":[1,{\"c\":null}]}},", "var a=function(b,c){for(var d=0;d<b.length;d++){if(c){d=b[d]}else{c=d+1}}return c};"]) {
      const code = s.startsWith("export") ? Array.from({ length: 25_000 }, (_, i) => s.replace("a", `a${i}`)).join("") : s.startsWith("var") ? fill(s, 900_000).replace(/[^;]*$/, "") + "" : `x = [${s.repeat(Math.floor(900_000 / s.length))}]`;
      expect(scanImports(`${s.startsWith("var") ? s.repeat(Math.floor(900_000 / s.length)) : code}\n;import './a'`, JS)).toMatchObject({ imports: [{ specifier: "./a" }] });
    }
  });
});

describe("blanking", () => {
  it("keeps positions", () => {
    const code = "a /* b\n` */ + `c\n${d + 'e'}f`; /`/ // g\n'// h'";
    const blank = blankCommentsAndTemplates(code);
    expect(blank).toBe("a     \n     + ` \n${d + 'e'} `; /`/     \n'// h'");
    expect(blank).toHaveLength(code.length);
  });
});

/** Compared with the TypeScript compiler: no module it sees may be missed. */
describe("real code", () => {
  const ROOT = path.resolve(import.meta.dirname, "../../..");

  function sourceFile(file: string, code: string): ts.SourceFile | null {
    const isTs = /\.[mc]?tsx?$/.test(file);
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : isTs ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, kind);
    return (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length ? null : sf;
  }

  /** Static imports and literal import() and require(), by the line of their first use. */
  function expected(sf: ts.SourceFile, code: string): Map<string, number> {
    const out = new Map<string, number>();
    const add = (e: ts.Node | undefined) => {
      if (!e || !ts.isStringLiteralLike(e) || !e.text) return;
      const line = code.slice(0, e.getStart(sf)).split("\n").length;
      out.set(e.text, Math.min(line, out.get(e.text) ?? line));
    };
    const todo: ts.Node[] = [sf];
    while (todo.length) {
      const n = todo.pop()!;
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) add(n.moduleSpecifier);
      else if (ts.isExternalModuleReference(n)) add(n.expression);
      else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) add(n.argument.literal);
      else if (ts.isCallExpression(n)) {
        const { expression: f } = n;
        if (f.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(f) && f.text === "require")) add(n.arguments[0]);
      }
      ts.forEachChild(n, (c) => void todo.push(c));
    }
    return out;
  }

  function compare(files: string[]): { compared: number; problems: string[] } {
    let compared = 0;
    const problems: string[] = [];
    for (const file of files) {
      const code = fs.readFileSync(path.join(ROOT, file), "utf8");
      const sf = sourceFile(file, code);
      if (!sf) continue;
      compared++;
      const { imports, unparsed } = scanFile(file, code);
      if (unparsed) problems.push(`${file} ${unparsed}`);
      const found = new Map(imports.map((i) => [i.specifier, i.line]));
      for (const [name, line] of expected(sf, code)) {
        // What is not a module name for TypeScript, such as require.resolve, may come first.
        if (!found.has(name) || found.get(name)! > line) problems.push(`${file}:${line} ${name}, found ${found.get(name)}`);
      }
    }
    return { compared, problems };
  }

  it("of this project is read completely", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        if (e.isDirectory()) walk(`${dir}/${e.name}`);
        else if (/\.(?:[mc]?[jt]s|[jt]sx)$/.test(e.name)) files.push(`${dir}/${e.name}`);
      }
    };
    walk("packages");
    const { compared, problems } = compare(files);
    expect(problems).toEqual([]);
    expect(compared).toBeGreaterThan(80);
  });

  it("that the main entry needs is without Node, and has one dependency", () => {
    const needed = new Set(["index.ts"]);
    const packages = new Set<string>();
    for (const file of needed) {
      for (const { specifier } of scanFile(file, fs.readFileSync(path.join(import.meta.dirname, file), "utf8")).imports) {
        if (specifier.startsWith("./")) needed.add(specifier.slice(2).replace(/\.js$/, ".ts"));
        else packages.add(specifier);
      }
    }
    expect([...packages]).toEqual(["@babel/parser"]);
    expect(needed.size).toBeGreaterThan(10);
    expect(needed).not.toContain("node.ts");
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8")).dependencies)).toEqual(["@babel/parser"]);
  });

  it("of other people is read completely", () => {
    const listed = fs.readFileSync(path.join(import.meta.dirname, "scanner.corpus.txt"), "utf8").trim().split("\n");
    const files = listed.map((f) => `node_modules/${f}`).filter((f) => fs.existsSync(path.join(ROOT, f)));
    const { compared, problems } = compare(files);
    expect(problems).toEqual([]);
    expect(compared).toBeGreaterThanOrEqual(300);
  });
});
