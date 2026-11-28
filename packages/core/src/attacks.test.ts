import { describe, expect, it } from "vitest";
import { buildGraphFromFiles, checkArchitecture, failing, unparsedFiles, type Architecture } from "./index.js";

/** Everything that was once found to get past a check, or to fail one for nothing, as whole projects. */
const ARCH: Architecture = {
  version: 1,
  modules: { ui: { paths: ["src/ui/**"] }, data: { paths: ["src/data/**"] } },
  layers: ["ui", "data"],
  rules: [
    { id: "LAYER01", type: "layers", description: "d", rationale: "r", severity: "block" },
    { id: "DENY01", type: "deny_dependency", from: "data", to: "ui", description: "d", rationale: "r", severity: "block" },
    { id: "OPAQUE01", type: "no_opaque_imports", description: "d", rationale: "r", severity: "block" },
  ],
  exceptions: [],
};

const UI = Object.fromEntries(["secret.ts", "secret.cjs", "Page.ts", "Page.cjs", "index.ts", "a b.ts"].map((f) => [`src/ui/${f}`, ""]));

/** What a check says about a file in src/data. Empty when it passes. */
function problems(name: string, code: string): string[] {
  const graph = buildGraphFromFiles({ ...UI, "src/data/b.ts": "", "src/data/sub/c.ts": "", [`src/data/${name}`]: code });
  return [...failing(checkArchitecture(ARCH, graph)).map((v) => v.id), ...unparsedFiles(graph).map((u) => `${u.file} ${u.reason}`)];
}

const S = "../ui/secret";
/** Regular expressions that become a string around the import when the first of them is taken for a division. */
const PAIR = `/\`/; import('${S}'); /\`/`;

const DIVIDED = [
  // A member that has the name of a keyword.
  ...["class A { class\n x = 1\n y() { function f(){} @ } }", "class A { static class\n x = 1\n y() { function f(){} @ } }", "class A { @d class\n x = 1\n y() { l: {} @ } }"].map((c): [string, string] => ["d.js", c]),
  // Where a type, a case or a label ends.
  ...["(x): void => {}", "function(): void {}", "async (x): Promise<void> => {}", "b ? (c): d => 1 : 0", "async <T>(x): Promise<void> => {}", "async <T>(x): {} => {}", "async <T>(x): A[] => {}", "async <T>(x): x is T => {}", "async <T>(x): 'a' => {}", "function(x): A extends (B) ? (C) : D {}", "async function*(x): A extends (B) ? (C) : D {}", "(x): typeof this.x => {}",
  ].flatMap((c): Array<[string, string]> => [["d.ts", `switch(1 as any) { case ${c}: {} @ }`], ["d.ts", `switch(1 as any) { case ${c}: {} /\`/; default: import('${S}'); /\`/ }`]]),
  ...["interface A {} of", "enum A {} is", "interface A {} as"].map((c): [string, string] => ["d.ts", `${c}: {} @`]),
  ["d.ts", "class A { #p = 1; m(x) { switch(1 as any) { case (x): typeof this.#p => {}: {} @ } } }; new A().m(1)"],
  ["d.ts", "interface I {} @d class A {} @"], ["d.tsx", "switch (1 as any) { case <T,>(x): void => {}: {} @ }"],
  // A type that is called let.
  ...["type A = typeof let\n@", "let x: let\n@", "let x: A | let\n@", "declare function f(): let\n@"].flatMap((c): Array<[string, string]> => ["d.ts", "d.tsx", "d.mts"].map((f) => [f, c])),
  ["d.js", "class A { class<T>() {} @ }"], ["d.ts", "a < b > @"], ["d.ts", "x = a < b > @"],
].map(([file, code]): [string, string] => [file, code.replace("@", PAIR)]);

const HIDDEN: Array<[string, string]> = [
  ...DIVIDED,
  ["d.js", "class A { class\n x\n y() { require(v) } }"], ["d.ts", "switch(1) { case (x): void => {}: { require(v) } }"], ["d.ts", "switch(1) { case async <T>(x): void => {}: { import(v) } /`/; default: import(v); /`/ }"],
  // After keyof and the like, "{" is a type.
  ...["const f = function(y): y is {}\n{} / 1; @; 1 / 2", "const f = function(): keyof {}\n{} / 1; @; 1 / 2", "const a = b as keyof\n{} / 1; @; 1 / 2", "const a = b satisfies keyof\n{} / 1; @; 1 / 2", "let x: A | readonly {}[]\n{} /1; @; 1 / 2", "type F = new () => keyof {}\n{} /1; @; 1 / 2"].flatMap((c): Array<[string, string]> =>
    [`import('${S}.ts')`, "import('..\\x2fui\\x2fsecret.ts')"].map((i) => ["d.ts", c.replace("@", i)])),
  // Type arguments and casts.
  ["d.tsx", `a?.<A.B>(x); import('${S}'); // </A>`],
  ...["import('' as string || '@')", "import('./b' as any && '@')", "import('./b' as string + '/../@')", "require('' satisfies string || '@')", "require<A<B>>('@')", "require<Record<string, A>>('@')", "require<A<B>, C>('@')", "createRequire(x)<A<B>>('@')", "require<A<typeof require<B>>>('@')", "import.meta.glob<A<B>>('../ui/*.ts')"].map((c): [string, string] => ["d.ts", c.replace("@", S)]),
  ["d.ts", "x ? (b): c => require : 0"], ["d.ts", "(module as any).require(v)"], ["d.cjs", "module.parent.require(v)"],
  // createRequire in another guise.
  ...["import { 'createRequire' as cr } from 'node:module'; cr(import.meta.url)('@')", "const { 'createRequire': cr } = await import('module'); cr(u)('@')", "const { ['createRequire']: cr } = m; cr(u)('@')", "const r = () => createRequire(import.meta.url); r()('@')", "const { a: r } = { a: createRequire(import.meta.url) }; r('@')",
    "const r = { q: createRequire(import.meta.url) }.q; r('@')", "const r = createRequire.call(null, import.meta.url); r('@')", "const cr = createRequire; const r = cr(u); r('@')", "const { require: r } = module; r('@')", "createRequire(import.meta.url.replace('data','ui'))('./secret.cjs')", "const r = createRequire(new URL('../ui/', import.meta.url)); r('./secret.cjs')",
    "const r = createRequire(new URL('../', import.meta.url)); r('./ui/secret.cjs')", "export { 'createRequire' as x } from 'module'; import * as me from './d.mjs'; me.x(import.meta.url)('@')", "export { createRequire as x } from 'module'", "import * as m from 'module'; m['create' + 'Require'](import.meta.url)('@')", "process.getBuiltinModule('module').createRequire(u)('@')"].map((c): [string, string] => ["d.mjs", c.replace("@", S)]),
  ...["require(require.resolve('./secret.cjs', { paths: [__dirname + '/../ui'] }))", "module.parent.require('./s3.cjs')", "require.main.require('./s3.cjs')", "process.mainModule.require('./s3.cjs')", "arguments[1]('@')", "module.constructor._load('@', module)", "const p = module.constructor.prototype; p.require.apply(module, ['@'])", "const m = module; m.require.apply(m, ['@'])", "const m = module; m.require('@')",
    "require.cache[k].require('./s')", "with (process.mainModule) require('./s')"].map((c): [string, string] => ["d.cjs", c.replace("@", S)]),
  // Comments that only scripts have.
  ...["d.ts", "d.tsx", "d.mts", "d.cts", "d.js", "d.cjs", "d.mjs"].flatMap((f): Array<[string, string]> => [[f, `let x = 1 <!-- \`\nimport('${S}.ts')\n// \``], [f, `/*\n*/ --> \`\nimport('${S}')\n// \``], [f, `x = a\n--> \`\nimport('${S}')\n// \``]]),
  // Names with an unknown part that leave their folder.
  ...["import(`../${x}/../ui/Page`)", "import('../' + x + '/../ui/Page')", "import(`../${x}/./Page`)", "import(`../${x}//Page`)", "require(`../${x}/`)", "import(`../.${x}`)", "import(`./..${x}`)", "import(`../..${x}`)", "import(`./${'../ui/secret.ts'}`)", "import(`../%75i/${x}.ts`)", "import(`./..\\\\ui\\\\${x}.ts`)"].map((c): [string, string] => ["d.ts", c]),
  ...["import.meta.glob('../*/../ui/*.ts')", "import.meta.glob('../*/./*.ts')", "import.meta.glob('../*//Page.ts')", "import.meta.glob(['../ui/**/*.ts','!../ui**'])", "require.context('../ui', false, /\\/Page$/)", "new URL('../ui/Page.ts', import.meta.url as string)", "new URL('../ui/Page.ts#x', import.meta.url)", "new URL(' \\t../ui/Page.ts', import.meta.url)", "new URL(...['../ui/Page.ts', import.meta.url])", "new URL(`../ui/${x}.ts`, import.meta.url)"].map((c): [string, string] => ["d.ts", c]),
  // Names that a URL makes something else of.
  ...["import '../%75i/secret.ts'", "import './%2e%2e/ui/secret.ts'", "import './..\\\\ui\\\\secret.ts'", "new URL('../ui/%50age.ts', import.meta.url)", "import '../u\\ti/secret.ts'", "import '../ui/secret.ts?x'", "import '../ui/secret.ts#x'", "import '../ui/secret.ts '", "import '../ui/a%20b.ts'", "export * from '../%75%69/secret.ts?%'",
    "import 'file:///app/src/ui/secret.ts'", "import('/app/src/ui/secret.ts')", "require('/app/src/ui/secret')", "import('C:\\\\app\\\\x')", "import '/src/ui/secret'", "import 'data:text/javascript,import(\"file:///x\")'"].map((c): [string, string] => ["d.mjs", c]),
  // Components.
  ...["<!doctype <!-- >\n<script>@</script>\n<!-- -->", "<template><a/></template <!-- >\n<script>@</script>\n<!-- -->", "<script setup>\n</script <!-- >\n<script>@</script>\n<!-- -->", "<docs>\n</docs <!-- >\n<script>@</script>\n<!-- -->", "{{ '<!--' }}\n<script>@</script>\n<!-- -->", "<script / >\n<script>@; `x`</script>", "<?x <!-- ?>\n<script>@</script>\n<!-- -->", "</x <!-- >\n<script>@</script>\n<!-- -->",
    "<script src='&#46&#46/ui/Page'></script>", "<script src='&#46&#46/ui/secret'></script>", "<script src='./b' src='../ui/secret'></script>"].map((c): [string, string] => ["d.vue", c.replace("@", `import s from '${S}'`)]),
  ...['lang="&#116;s"', 'setup lang="&#116;s"', 'lang="t&#115;x"', 'lang="mts"', 'lang="js" lang="ts"', 'lang="ts" lang="js"'].map((a): [string, string] => ["d.vue", `<script ${a}>switch(1 as any) { case (x): void => {}: {} /\`/; default: import('${S}'); /\`/ }</script>`]),
  ["d.vue", `<script lang="&#116;sx">x = <a>it's</a>; import '${S}'</script>`],
  ...["const s = r('../ui/secret.cjs')", "const s = cr(import.meta.url)(v)", "f(r)"].map((c): [string, string] => ["d.vue", `<script>\nimport { createRequire as cr } from 'node:module'\nconst r = cr(import.meta.url)\n</script>\n<script setup>\n${c}\n</script>`]),
  ["d.vue", "<script setup>\nconst s = r('../ui/secret.cjs')\n</script>\n<script>\nimport { createRequire } from 'node:module'\nconst r = createRequire(import.meta.url)\n</script>"],
  // Templates are compiled into the module of the component.
  ...["<template><button @click=\"import('../ui/secret')\">x</button><div>{{ import('../ui/other') }}</div></template>", "<script setup>const x = 1</script>\n<template><div>{{ import('../ui/secret') }}</div></template>",
    "<script setup>\nimport { createRequire } from 'node:module'\nconst r = createRequire(import.meta.url)\n</script>\n<template><p>{{ r('../ui/secret.cjs') }}</p></template>", "<template><p @click=\"imp&#111;rt('../ui/secret')\"/></template>",
    "<template lang=\"pug\">\nbutton(@click=\"import('../ui/secret')\")</template>", `<script>${"x;".repeat(300_000)}</script>`.repeat(2)].map((c): [string, string] => ["d.vue", c]),
  // A name of the one script hides nothing in the other.
  ["d.vue", "<script>function require() {}</script>\n<script setup>require(v)</script>"],
  // What gives require back as it is, or a module object.
  ...["require.valueOf()('../ui/secret.cjs')", "module.valueOf().require(n)", "module.require.valueOf()(v)", "module.parent.valueOf().require(v)", "require.main.valueOf().require(v)", "module.children.valueOf()[0].require(v)", "require['valueOf']()(v)", "require.bind(null)('../ui/secret')",
    "var __filename = __dirname + '/../ui/x.js'; const { createRequire } = require('node:module'); createRequire(__filename)('./secret.cjs')", "var __filename = __dirname + '/../ui/x.js'; const { createRequire } = require('node:module'); const load = createRequire(__filename); load('./secret.cjs')",
    'globalThis.await = 1;\nx = await / 1; require("..\\x2fui\\x2fsecret.cjs"); y = 2 /g'].map((c): [string, string] => ["x.cjs", c]),
  ["x.js", 'globalThis.await = 1;\nx = await / 1; require("..\\x2fui\\x2fsecret.cjs"); y = 2 /g'], ["x.ts", "(require as any).valueOf()('./x')"],
  ["x.mjs", "import { createRequire } from 'node:module'; const r = createRequire(import.meta.url); r.valueOf()('../ui/secret.cjs')"],
  // What it has that loads nothing, put in the place of what loads, and what decides where require looks.
  ...["const M = require('module'); const orig = M._resolveFilename; M._resolveFilename = function (r, ...a) { return orig.call(this, r === './b.cjs' ? '../ui/secret.cjs' : r, ...a); }; require('./b.cjs');",
    "const wrap = require('node:module').wrap; require('node:module').wrap = (s) => wrap(\"require('../ui/secret.cjs');\" + s); require('./b.cjs')", "const M = require('module'); M._resolveLookupPaths = () => [__dirname + '/../ui']; require('secret.cjs')",
    "require('module')._nodeModulePaths = () => [__dirname + '/../ui']; require('./b.cjs')", "const { Module } = require('module'); delete Module._resolveFilename", "require('module').Module.wrap ??= (s) => s",
    "module.filename = __dirname + '/../ui/x.js'; require('./secret.cjs')", "module.paths.unshift(__dirname + '/../ui'); require('secret.cjs')", "module.paths = [__dirname + '/../ui']; require('secret.cjs')", "module.paths[0] = __dirname + '/../ui'; require('secret.cjs')",
    "require.main.paths.push(__dirname + '/../ui'); require('secret.cjs')", "Object.assign(module, { filename: __dirname + '/../ui/x.js' }); require('./secret.cjs')", "Reflect.set(module, 'filename', __dirname + '/../ui/x.js'); require('./secret.cjs')",
    "module.id = ''; process.chdir(__dirname + '/../ui'); require('./secret.cjs')", "delete module.filename; require('./secret.cjs')", "const p = module.paths; p.push(__dirname + '/../ui'); require('secret.cjs')", "require.cache[k].paths.push(x)", "module.parent.filename = x",
    // Callbacks are given the array, and so is what anyone may put into Array.prototype, or give instanceof.
    "module.paths.forEach((p, i, arr) => { if (i === 0) arr.unshift(__dirname + '/../ui') }); require('secret.cjs')", "module.paths.map((p, i, arr) => i === 0 && arr.unshift(__dirname + '/../ui')); require('secret.cjs')",
    "module.paths.reduce((a, p, i, arr) => arr.unshift(__dirname + '/../ui'), 0); require('secret.cjs')", "module.paths.some(function () { arguments[2].unshift(__dirname + '/../ui') }); require('secret.cjs')", "module.paths.find(f); require('secret.cjs')",
    "Array.prototype.join = function () { this.unshift(__dirname + '/../ui'); return '' }; module.paths.join(); require('secret.cjs')", "Array.prototype.includes = function () { this.unshift(__dirname + '/../ui') }; require.main.paths.includes(x); require('secret.cjs')",
    "Array.prototype[require('util').inspect.custom] = function () { this.unshift(__dirname + '/../ui'); return '' }; console.log(module.paths); require('secret.cjs')",
    "const it = Array.prototype[Symbol.iterator]; Array.prototype[Symbol.iterator] = function () { this.unshift(__dirname + '/../ui'); return it.call(this) }; for (const d of module.paths) {}; require('secret.cjs')", "f([...module.paths]); require('secret.cjs')",
    "Object.defineProperty(Array.prototype, '9', { get() { this.unshift(__dirname + '/../ui') } }); module.paths[9]; require('secret.cjs')", "Array.prototype.toString = function () { this.unshift(__dirname + '/../ui') }; '' + module.paths; require('secret.cjs')",
    "x = `${module.paths}`; require('secret.cjs')", "+module.paths; require('secret.cjs')", "module.paths instanceof { [Symbol.hasInstance]: (a) => a.unshift(__dirname + '/../ui') }; require('secret.cjs')"].map((c): [string, string] => ["m.cjs", c]),
  ["m.mjs", "import Module from 'node:module'; Module._resolveFilename = () => 1; import { createRequire } from 'node:module'; createRequire(import.meta.url)('./b.cjs')"],
  ["m.mts", "import * as M from 'node:module'; M.default._resolveFilename = () => 1"],
  // In a module __filename is a global, which another module may have set.
  ["g.mjs", "globalThis.__filename = new URL('../ui/', import.meta.url).pathname + 'x.js'; import { createRequire } from 'node:module'; createRequire(__filename)('./secret.cjs');"],
  ["g.mjs", "import './b.ts'; import { createRequire } from 'node:module'; const load = createRequire(__filename); load('./secret.cjs')"],
  ["g.js", "import './b.ts'; import { createRequire } from 'node:module'; const load = createRequire(__filename); load('./secret.cjs')"], ["g.ts", "const { createRequire } = require('node:module'); createRequire(__filename)('./secret.cjs')"],
  // Code of a component outside its template: a template in another file, and v-bind() in a style.
  ...["<template src=\"./t.html\"></template>", "<template src='./t.html'/>", "<template src=\"./t.html\"><p/></template>", "{{ x }}\n<template src=\"./t.html\"/>",
    "<script setup>const a = 1</script><template><div class=\"a\"/></template><style>.a { color: v-bind(\"import('..\\x2fui\\x2fsecret')\"); }</style>", "<script>export default {}</script><style lang=\"scss\">.a { color: v-bind(import('../ui/secret')); }</style>",
    "<style>.a { color: v-bind('import(`../ui/secret`)') }</style>", "<style>/* x */ .a { color: v-bi/**/nd(import('../ui/secret')) }</style>", "<style>.a { b: v-bind(\"require('../ui/secret.cjs')\"); /* ) */ }</style>", "<style>/* v-bind(import('../ui/secret')) */</style>",
    "<script setup>import { createRequire } from 'node:module'; const r = createRequire(import.meta.url)</script><style>.a { color: v-bind('r(\"../ui/secret.cjs\")') }</style>"].map((c): [string, string] => ["d.vue", c]),
  // Expressions of a template that are too deep or too many to tell, which are not only looked through for words that load.
  ["d.vue", `<script setup>import { createRequire } from 'node:module'; const r = createRequire(import.meta.url)</script><template><p>{{ r(${"(".repeat(300)}'../ui/secret.cjs'${")".repeat(300)}) }}</p></template>`],
  ["d.vue", `<script setup>import { createRequire } from 'node:module'; const r = createRequire(import.meta.url)</script><template>${"<p>{{ ( }}</p><p>{{ a }}</p>\n".repeat(300)}<p>{{ r('../ui/secret.cjs') }}</p></template>`],
  // An element that ends before v-pre is taken for its end.
  ...["<template><pre v-pre></pre>{{ import('../ui/secret') }}</template>", "<template><div v-pre><div></div>{{ import('../ui/secret') }}</div></template>", "<template><img v-pre>{{ import('../ui/secret') }}</template>",
    "<template><p v-pre/>{{ import('../ui/secret') }}</template>", "<template><pre v-pre>{{ import('../ui/other') }}</PRE >{{ import('../ui/secret') }}</template>",
    // Only v-pre in lower case is text for Vue.
    "<template><div V-PRE>{{ import('..\\x2fui\\x2fsecret') }}</div></template>", "<template><div v-Pre>{{ import('../ui/secret') }}</div></template>"].map((c): [string, string] => ["d.vue", c]),
  // Files that are not read at all.
  ["d.ts", `${"{".repeat(100_000)}import '${S}'`], ["d.ts", `x = \`${"a".repeat(1_300_000)}\`; import '${S}'`], ["d.ts", `${"a<(b=".repeat(60)}x; import '${S}'`],
];

const HONEST: Array<[string, string]> = [
  ...["a?.<string[]>(x);", "a?.<A<B>>(x);", "a?.<A|B>(x);", "a?.<typeof x>(x);", "a?.<keyof B>(x);"].map((c): [string, string] => ["d.tsx", c]),
  ["d.ts", "class A {\n  n = 1\n  require(id) { return id }\n}"], ["d.ts", "class A { @Inject() require(x) {} }"], ["d.js", "define(['a'], (require, exports) => { exports.x = 1 })"], ["d.js", "x = { load(require, module) {} }"],
  ["d.ts", "enum A { require, import }"], ["d.ts", "process.env.require; process.argv.require"], ["d.ts", "const { require: needed } = opts; needed(x)"], ["d.ts", "x.then((require) => require)"],
  ["d.vue", "<docs>\n```vue\n<script>\nimport x from '../ui/secret'\n</script>\n```\n</docs>\n<script>import a from './b'</script>"],
  ["d.vue", "<script>\nimport { createRequire as cr } from 'node:module'\nconst r = cr(import.meta.url)\n</script>\n<script setup lang='ts'>\nconst s: A<B> = r('./b')\n</script>"],
  ["d.mjs", "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst b = require('./b');\nimport('node:fs'); import(`./sub/${b}.ts`); import './sub/c.ts?raw'; import logo from '/logo.svg'; import 'https://x.y/z.js'"],
  ["d.cjs", "#!/usr/bin/env node\n'use strict';\nif (require.main === module) main();\nconst b = require('./b'), p = require('pkg/package.json');\nmodule.exports = { b };\ndelete require.cache[require.resolve('./b')];"],
  // Reading what decides where require looks, and calling what node:module has.
  ["d.cjs", "g(module.paths.length, require.main.paths?.length, module.filename, typeof module.paths, module.paths === x, !module.paths); h(module.id); if (module.paths) {}"],
  ["d.cjs", "const M = require('module'); const r = M._resolveFilename('./b', module); M._nodeModulePaths(__dirname); const { _resolveFilename } = M; if (M.wrap) {}; M.globalPaths.forEach(f)"],
  ["d.cjs", "const { createRequire } = require('node:module'); createRequire(__filename)('./b')"],
  // What Vue shows as text, and styles that bind what the component has.
  ["d.vue", "<template><pre v-pre>{{ import('../ui/secret') }} <p :a=\"require('../ui/secret.cjs')\"></p></pre><code v-pre :x=\"import('../ui/secret')\">{{ a }}</code></template>"],
  ["d.vue", "<script setup>const color = 'red'; const theme = { a: 1 }</script><template><p/></template><style scoped>.a { color: v-bind(color); b: v-bind('theme.a'); c: v-bind(\"theme['a']\") }</style>"],
  ["d.js", "(function (root, factory) { if (typeof define === 'function' && define.amd) define(['b'], factory); else if (typeof module === 'object' && module.exports) module.exports = factory(require('b')); else root.x = factory(root.b); })(this, function (b) { return b; });"],
];

describe("a check", () => {
  it.each(HIDDEN)("does not pass %s with %j", (name, code) => {
    expect(problems(name, code)).not.toEqual([]);
  });

  it.each(HONEST)("passes %s with %j", (name, code) => {
    expect(problems(name, code)).toEqual([]);
  });

  it("names the import where it can be told", () => {
    for (const [name, code] of [["d.tsx", `a?.<A.B>(x); import('${S}'); // </A>`], ["d.ts", "import(`./${'../ui/secret.ts'}`)"], ["d.mjs", "import '../%75i/secret.ts'"], ["d.mjs", "import './..\\\\ui\\\\secret.ts'"], ["d.mjs", "import '../ui/secret.ts?x'"], ["d.mjs", "import '/src/ui/secret'"], ["d.vue", `<script lang="&#116;s">import '${S}'</script>`]]) {
      expect(problems(name, code), code).toContain(`LAYER01:src/data/${name}->src/ui/secret.ts`);
    }
    for (const [name, code] of DIVIDED) if (name === "d.js" || code.includes("switch")) expect(problems(name, code).join(), code).toMatch(/secret|cannot be parsed/);
  });
});
