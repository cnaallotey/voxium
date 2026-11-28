import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_TARGETS } from "./expand.js";
import { MAX_OPAQUE } from "./imports.js";
import {
  buildGraphFromFiles, checkArchitecture, describeRuleChanges, expandSymlinks, failing, inferArchitecture, uncheckedPaths, unparsedFiles, validateArchitecture, type Architecture, type FileMap, type Rule,
} from "./index.js";
import { buildGraph, buildGraphBefore } from "./node.js";
import { checkChange, checkImport } from "./tools.js";

const RULE: Rule = { id: "OPAQUE01", type: "no_opaque_imports", description: "d", rationale: "r", severity: "block" };

const arch = (over: Partial<Architecture> = {}): Architecture => ({
  version: 1,
  modules: { ui: { paths: ["src/ui/**"] }, data: { paths: ["src/data/**"] } },
  layers: ["ui", "data"],
  rules: [{ id: "LAYER01", type: "layers", description: "d", rationale: "r", severity: "block" }, RULE],
  exceptions: [],
  ...over,
});

/** The files that code in src/ui/main.ts leads to. */
function targets(code: string, files: FileMap | string[], from = "src/ui/main.ts"): string[] {
  const others = Array.isArray(files) ? Object.fromEntries(files.map((f) => [f, ""])) : files;
  const graph = buildGraphFromFiles({ ...others, [from]: code });
  expect(graph.unparsed).toEqual([]);
  return graph.edges.filter((e) => e.from === from).map((e) => e.to ?? `package ${e.pkg}`).concat(graph.opaque.map((o) => `${o.kind}:${o.line}`));
}

const TREE = ["src/data/a.ts", "src/data/b.js", "src/data/deep/c.ts", "src/data/deep/index.ts", "src/ui/d.ts", "src/ui/e.vue", "src/ui/sub/f.tsx"];

describe("imports of many files", () => {
  it.each<[string, string[]]>([
    ["import(`./${x}`)", ["src/ui/d.ts", "src/ui/e.vue", "src/ui/sub/f.tsx"]],
    ["import(`../data/${x}.ts`)", ["src/data/a.ts", "src/data/deep/c.ts", "src/data/deep/index.ts"]],
    ["import(`../data/${x}.js`)", ["src/data/a.ts", "src/data/b.js", "src/data/deep/c.ts", "src/data/deep/index.ts"]],
    ["require('../data/' + x)", ["src/data/a.ts", "src/data/b.js", "src/data/deep/c.ts", "src/data/deep/index.ts"]],
    ["import(`@/data/d${x}`)", ["src/data/deep/c.ts", "src/data/deep/index.ts"]],
    ["import(`../${x}/${y}/c`)", ["src/data/deep/c.ts"]],
    ["import(`./nothing/${x}`)", []],
    ["import(`pg/${x}`)", ["package pg"]],
    ["import(`@a/b/${x}`)", ["package @a/b"]],
    ["import(`p${x}`)", ["import:1"]],
    ["import(`${x}/a`)", ["import:1"]],
    ["require(`/${x}`)", ["require:1"]],
    ["import.meta.glob('./*.ts')", ["src/ui/d.ts"]],
    ["import.meta.glob('./**/*.ts*', { eager: true })", ["src/ui/d.ts", "src/ui/sub/f.tsx"]],
    ["import.meta.glob(['../data/*', '!../data/b.js'])", ["src/data/a.ts"]],
    ["import.meta.glob('/src/data/{a,b}.{ts,js}')", ["src/data/a.ts", "src/data/b.js"]],
    ["import.meta.glob('./{e.vue,{sub/{f,g}.tsx,x}}')", ["src/ui/e.vue", "src/ui/sub/f.tsx"]],
    ["import.meta.glob('./{d}.ts')", ["src/ui/d.ts"]],
    ["import.meta.glob('./{d.ts,{e}.vue}')", ["glob:1"]],
    ["import.meta.glob('./@(d.ts|sub/f.tsx)')", ["glob:1"]],
    ["import.meta.glob('./@(d|e).*')", ["src/ui/d.ts", "src/ui/e.vue"]],
    ["import.meta.glob('./{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}')", ["glob:1"]],
    ["import.meta.glob('@/data/deep/*')", ["src/data/deep/c.ts", "src/data/deep/index.ts"]],
    ["import.meta.glob('../data/[ab].ts')", ["src/data/a.ts"]],
    ["import.meta.glob(`../data/${'a'}.ts`)", ["src/data/a.ts"]],
    ["import.meta.glob(x)", ["glob:1"]],
    ["import.meta.glob(['./d.ts', x])", ["src/ui/d.ts", "glob:1"]],
    ["import.meta.glob('./*.ts', { base: '../data' })", ["src/ui/d.ts", "glob:1"]],
    ["require.context('../data')", ["src/data/a.ts", "src/data/b.js", "src/data/deep/c.ts", "src/data/deep/index.ts"]],
    ["require.context('../data', false, /\\.ts$/)", ["src/data/a.ts"]],
    ["require.context('../data', true, /^\\.\\/.*\\.(js|jsx)$/)", ["src/data/b.js"]],
    ["require.context('../data', true, /a|c/)", ["src/data/a.ts", "src/data/b.js", "src/data/deep/c.ts", "src/data/deep/index.ts"]],
    ["require.context(x, true, /\\.ts$/)", ["require:1"]],
    // Names without their extension, and of folders.
    ["require.context('../data', false, /\\/a$/)", ["src/data/a.ts"]],
    ["require.context('..', true, /\\/deep$/)", ["src/data/deep/index.ts"]],
    ["require.context('../data', true, /c$/)", ["src/data/a.ts", "src/data/b.js", "src/data/deep/c.ts", "src/data/deep/index.ts"]],
    // Names that leave the folder they begin with, or may.
    ...["import(`../${x}/../data/a`)", "import('../' + x + '/../data/a')", "import(`../${x}/./a`)", "import(`../${x}//a`)", "import(`../${x}/`)", "import(`../.${x}`)", "import(`./..${x}`)", "import(`../..${x}`)", "import(`./${x}./data/a`)",
      "import(`./${x}../data/a`)", "import(`./a/${x}/.${y}`)", "import(`!raw-loader!../data/${x}`)"].map((c): [string, string[]] => [c, ["import:1"]]),
    ["import(`pg/${x}/../../data/a`)", ["package pg", "import:1"]],
    ["import(`../data/${x}.ts?raw`)", ["src/data/a.ts", "src/data/deep/c.ts", "src/data/deep/index.ts"]],
    ["import(`../data/${x}?worker&v=${y}`)", ["src/data/a.ts", "src/data/b.js", "src/data/deep/c.ts", "src/data/deep/index.ts"]],
    ["new URL('../data/a.ts', import.meta.url as string)", ["src/data/a.ts"]],
    ["new URL('../data/a.ts#x', import.meta.url)", ["src/data/a.ts"]],
    ["new URL('../data/a.ts?worker', import.meta.url!)", ["src/data/a.ts"]],
    ["new URL(`../data/${x}.ts`, import.meta.url)", ["src/data/a.ts", "src/data/deep/c.ts", "src/data/deep/index.ts"]],
    ["new URL(`sub/${x}`, import.meta.url)", ["src/ui/sub/f.tsx"]],
    ["new URL(`https://a.b/${x}`, import.meta.url)", []],
    // Parts of a path behind a wildcard.
    ["import.meta.glob('../*/../data/*.ts')", ["src/data/a.ts"]],
    ["import.meta.glob('../*/./*.js')", ["src/data/b.js"]],
    ["import.meta.glob('../*/../../../src/data/*.ts')", []],
    ["import.meta.glob('../*//b.js')", ["src/data/b.js"]],
    ["import.meta.glob('../{data,x}/../data/*.js')", ["src/data/b.js", "glob:1"]],
    ["import.meta.glob('./*/')", ["src/ui/d.ts", "src/ui/e.vue", "glob:1"]],
    // What is left out is no more than it says.
    ["import.meta.glob(['../data/**/*.ts', '!../data**'])", ["src/data/a.ts", "src/data/deep/c.ts", "src/data/deep/index.ts"]],
    ["import.meta.glob(['../data/**/*.ts', '!../data/**/*.ts'])", []],
    ["import.meta.glob(['../data/*', '!../data/[xb].js'])", ["src/data/a.ts", "src/data/b.js"]],
    ["import.meta.glob(['../data/*', '!../data/*/../b.js'])", ["src/data/a.ts", "src/data/b.js"]],
    // "/" and "@" may stand for several folders, though only for one at a time.
    ["import.meta.glob('/data/*.ts')", ["src/data/a.ts"]],
    ["import.meta.glob(['../data/*', '!/data/*'])", ["src/data/a.ts", "src/data/b.js"]],
    ["import.meta.glob(['/data/*', '!/data/b.js'])", ["src/data/a.ts"]],
    ["import.meta.glob(['../data/*', '!@/data/b.js'])", ["src/data/a.ts", "src/data/b.js"]],
    ["import.meta.glob(['@/data/*', '!@/data/b.js'])", ["src/data/a.ts"]],
  ])("%s", (code, expected) => {
    expect(targets(code, TREE)).toEqual(expected);
  });

  it("are the same in a list of patterns in any order, and add to what is imported by name", () => {
    const graph = buildGraphFromFiles({ ...Object.fromEntries(TREE.map((f) => [f, ""])), "src/ui/main.ts": "import './d';\nimport.meta.glob(['./sub/*', './d.ts'])" });
    expect(graph.edges.map((e) => [e.to, e.line, e.specifier])).toEqual([["src/ui/d.ts", 1, "./d"], ["src/ui/sub/f.tsx", 2, "./sub/*, ./d.ts"]]);
  });

  it("break the same rules as imports by name", () => {
    const files = { "src/ui/page.ts": "", "src/data/db.ts": "\nconst pages = import.meta.glob('../ui/*.ts')" };
    expect(checkArchitecture(arch(), buildGraphFromFiles(files)).violations).toMatchObject([{ id: "LAYER01:src/data/db.ts->src/ui/page.ts", line: 2 }]);
  });

  it("are followed up to a limit, and are not known beyond it", () => {
    const many = Array.from({ length: MAX_TARGETS + 5 }, (_, i) => `src/data/f${String(i).padStart(5, "0")}.ts`);
    for (const code of ["import.meta.glob('/**/*')", "import(`../data/${x}`)", "require.context('../data')"]) {
      const found = targets(code, many);
      expect(found).toHaveLength(MAX_TARGETS + 1);
      expect(found.slice(-2)[0]).toBe(many[MAX_TARGETS - 1]);
      expect(found.at(-1)).toMatch(/^(glob|import):1$/);
    }
  });

  it("are limited for a whole project as well", () => {
    const files: FileMap = {};
    for (let i = 0; i < 1100; i++) files[`src/data/${i}.ts`] = i < 120 ? "import.meta.glob('/**/*')" : "";
    const { edges, opaque } = buildGraphFromFiles(files);
    expect(edges).toHaveLength(100_000);
    expect(opaque).toHaveLength(120);
  });

  it("do not leave out files whose names begin with a dot, which wildcards do not match everywhere", () => {
    expect(targets("import.meta.glob(['../.data/*', '!../**/*'])", [...TREE, "src/.data/g.ts"])).toEqual(["src/.data/g.ts"]);
  });

  it("cost no more in a deep folder", () => {
    const start = process.cpuUsage();
    for (const list of ["'/x',".repeat(99), "'/x','!/y',".repeat(49)]) {
      const { edges, opaque } = buildGraphFromFiles({ [`${"d/".repeat(100)}a.ts`]: `import.meta.glob([${list}]);\n`.repeat(Math.ceil(1_000_000 / list.length)) });
      expect(edges).toEqual([]);
      expect(opaque.length).toBe(MAX_OPAQUE);
    }
    const { user, system } = process.cpuUsage(start);
    expect(user + system).toBeLessThan(15_000_000);
    // Each folder that is looked into counts.
    const { opaque } = buildGraphFromFiles({ [`${"d/".repeat(15)}a.ts`]: `import.meta.glob([${"'/x',".repeat(99)}]);\n`.repeat(2080) });
    expect(opaque.length).toBeGreaterThan(0);
    expect(opaque[0].line).toBeLessThan(2000);
    // Beyond some folders it is not known what "/" stands for.
    expect(buildGraphFromFiles({ [`${"d/".repeat(30)}a.ts`]: "import.meta.glob('/x.ts')" }).opaque).toHaveLength(1);
  });

  it("cost something for each file they are compared with", () => {
    const files: FileMap = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`src/ui/${"f".repeat(60)}${i}.ts`, ""]));
    const { edges, opaque } = buildGraphFromFiles({ ...files, "src/ui/main.ts": "import(`./${x}z`)\n".repeat(900) });
    expect(edges).toEqual([]);
    expect(opaque.length).toBeGreaterThan(0);
    expect(opaque[0].line).toBeGreaterThan(50);
  });

  it("are not known when a URL makes something else of a name", () => {
    expect(targets("import(`../data/a%${x}`)", TREE)).toEqual(["import:1"]);
    expect(targets("import(`../data\\\\${x}`)", TREE)).toEqual(["import:1"]);
    expect(targets("import(`../data/${x}.ts?a=%20`)", TREE)).toEqual(["src/data/a.ts", "src/data/deep/c.ts", "src/data/deep/index.ts"]);
  });

  it("stay affordable for a whole project", () => {
    const files: FileMap = {};
    const slow = `import.meta.glob(['/${"**/*a*".repeat(60)}/{a,b,c,d,e,f}{a,b,c,d,e,f}', '${"!/**/*b*".repeat(30)}'])\n`;
    for (let i = 0; i < 2000; i++) files[`src/data/${"a".repeat(60)}/${i}.ts`] = i < 200 ? slow + "import.meta.glob('/**/*')\nimport(`./${x}`)\n" : "";
    files["src/ui/a.ts"] = `import.meta.glob(['./${"{a,b}".repeat(6)}${"[".repeat(400)}'])\nimport.meta.glob('./${"{".repeat(200)}${",".repeat(200)}')\n`.repeat(5000);
    const start = process.cpuUsage();
    const { edges, opaque } = buildGraphFromFiles(files);
    const { user, system } = process.cpuUsage(start);
    expect((user + system) / 1000).toBeLessThan(30_000);
    expect(edges.length).toBeLessThanOrEqual(100_000);
    expect(opaque.length).toBeGreaterThan(0);
  });
});

describe("no_opaque_imports", () => {
  const check = (files: FileMap, over: Partial<Architecture> = {}, baseline: string[] = []) => checkArchitecture(arch(over), buildGraphFromFiles(files), { baseline });

  it("names each file once, at the first place, and counts the others", () => {
    const { violations, opaque } = check({ "src/ui/a.ts": "\nimport(x)\nconst r = require\nrequire(f())" });
    expect(violations).toMatchObject([{ id: "OPAQUE01:src/ui/a.ts", file: "src/ui/a.ts", line: 2, severity: "block" }]);
    expect(violations[0].message).toContain("and 2 more");
    expect(opaque).toEqual([
      { file: "src/ui/a.ts", line: 2, kind: "import" }, { file: "src/ui/a.ts", line: 3, kind: "require_value" }, { file: "src/ui/a.ts", line: 4, kind: "require" },
    ]);
  });

  it("takes no longer than in proportion for many of them", () => {
    const start = process.cpuUsage();
    const { violations } = check({ "src/ui/a.ts": "import(a)\n".repeat(80_000) });
    const { user, system } = process.cpuUsage(start);
    expect(user + system).toBeLessThan(5_000_000);
    expect(violations).toMatchObject([{ id: "OPAQUE01:src/ui/a.ts", line: 1 }]);
    const uses = Array.from({ length: 60_000 }, (_, i) => ({ file: "src/ui/a.ts", line: i, kind: "import" as const }));
    const graph = { ...buildGraphFromFiles({ "src/ui/a.ts": "" }), opaque: uses };
    const before = process.cpuUsage();
    expect(checkArchitecture(arch(), graph).violations).toHaveLength(1);
    const after = process.cpuUsage(before);
    expect(after.user + after.system).toBeLessThan(2_000_000);
  });

  it("passes code that names its modules", () => {
    expect(check({ "src/ui/a.ts": "import('../data/b'); require('pg'); import.meta.glob('../data/*')", "src/data/b.ts": "" }).violations).toEqual([]);
  });

  it("can be accepted as debt, excepted and a warning", () => {
    const files = { "src/ui/a.ts": "import(x)" };
    expect(failing(check(files))).toHaveLength(1);
    expect(failing(check(files, {}, ["OPAQUE01:src/ui/a.ts"]))).toEqual([]);
    expect(failing(check(files, { rules: [{ ...RULE, severity: "warn" }] }))).toEqual([]);
    const exception = { rule: "OPAQUE01", file: "src/ui/**", owner: "o", reason: "r", expires: "2999-01-01" };
    expect(failing(check(files, { exceptions: [exception] }))).toEqual([]);
    expect(failing(check(files, { exceptions: [{ ...exception, expires: "2000-01-01" }] }))).toHaveLength(1);
    expect(check(files, { rules: [] }).violations).toEqual([]);
  });

  it("follows files outside the modules, but leaves alone what no module leads to", () => {
    const files = { "src/ui/a.ts": "import '../../lib/x'", "lib/x.ts": "import './y'", "lib/y.ts": "import(z)", "scripts/z.ts": "require(z)" };
    expect(check(files).violations.map((v) => v.id)).toEqual(["OPAQUE01:lib/y.ts"]);
    expect(check(files).opaque.map((o) => o.file)).toEqual(["lib/y.ts"]);
    expect(check({ "src/ui/a.test.ts": "import '../../lib/x'", "lib/x.ts": "import(z)" }).violations).toEqual([]);
  });

  it("is a known rule, is proposed as a warning, and is named when it is removed", () => {
    expect(validateArchitecture(arch()).errors).toEqual([]);
    const { architecture } = inferArchitecture(buildGraphFromFiles({ "src/ui/a.ts": "import '../data/b'", "src/data/b.ts": "import(x)" }));
    expect(architecture.rules.find((r) => r.type === "no_opaque_imports")).toMatchObject({ severity: "warn" });
    expect(validateArchitecture(architecture).errors).toEqual([]);
    const text = (a: Architecture) => ({ "voxium/architecture.json": JSON.stringify(a) });
    expect(describeRuleChanges(text(arch()), text(arch({ rules: [] })), ["voxium/architecture.json"]).join()).toContain("Removes rule OPAQUE01");
    const warn = arch({ rules: [arch().rules[0], { ...RULE, severity: "warn" }] });
    expect(describeRuleChanges(text(arch()), text(warn), ["voxium/architecture.json"]).join()).toContain("severity from block to warn");
  });
});

describe("imports of files that are not source code", () => {
  const UI = { "src/ui/secret.cjs": "", "src/ui/page.ts": "" };
  const PAYLOADS = ["src/data/payload.txt", "src/data/payload", "src/data/payload.d.ts", "src/data/p.d.ts", "src/data/style.css", "src/data/logo.png", "src/data/data.json", "src/data/types.d.ts", "src/data/notes.txt", "src/ui/x.node",
    "src/data/node_modules/pkg/index.js", "src/data/node_modules/pkg/package.json", "src/data/addon.node", "src/data/assets/index.json"];
  const opaqueOf = (name: string, code: string, paths: string[] | null = PAYLOADS) => {
    const files = { ...UI, [name]: code };
    const graph = buildGraphFromFiles(files, paths ? { paths: [...Object.keys(files), ...paths] } : {});
    expect(graph.unparsed).toEqual([]);
    return graph.opaque.map((o) => `${o.kind}:${o.line}`);
  };

  it.each<[string, string]>([
    ["src/data/x.cjs", "require('./payload.txt')"], ["src/data/x.cjs", "require('./payload')"], ["src/data/x.cjs", "require('./payload.d.ts')"], ["src/data/x.ts", "import './p.d.ts'"], ["src/data/x.ts", "import '@/data/payload.txt'"],
    ["src/data/x.cjs", "require('./%70ayload.txt')"], ["src/data/x.cjs", "require('./payload.txt?x')"], ["src/data/x.cjs", "require('../ui/x.node')"], ["src/data/x.mjs", "import './payload.txt' with { type: 'x' }"],
    // In a node_modules folder that is committed, by its name, as the index of a folder or with an ending added.
    ["src/data/x.cjs", "require('./node_modules/pkg/index.js')"], ["src/data/x.cjs", "require('./node_modules/pkg')"], ["src/data/x.cjs", "require('./node_modules/pkg/index')"], ["src/data/x.cjs", "require('./addon')"],
  ])("are opaque when the file would still run as code: %s %s", (name, code) => {
    expect(opaqueOf(name, code)).toEqual(["import:1"]);
    // Without the paths of the tree that cannot be told.
    expect(opaqueOf(name, code, null)).toEqual([]);
  });

  it.each<[string, string, string]>([
    ["src/data/x.cjs", "require(`./${x}.txt`)", "require:1"], ["src/data/x.cjs", "require(`./pay${x}`)", "require:1"], ["src/data/x.cjs", "require('./' + x + '.d.ts')", "require:1"],
    ["src/data/x.ts", "import(`./${x}`)", "import:1"], ["src/data/x.js", "require.context('.', false, /\\.txt$/)", "glob:1"], ["src/ui/y.cjs", "require(`../data/${x}`)", "require:1"],
    ["src/data/x.cjs", "const x = 'pkg/index.js'; require(`./node_modules/${x}`)", "require:1"], ["src/data/x.cjs", "require(`./node_modules/${x}`)", "require:1"], ["src/data/x.cjs", "require('./node_modules/' + x)", "require:1"],
  ])("are opaque when a name with unknown parts can stand for a file that would run as code: %s %s", (name, code, kind) => {
    expect(opaqueOf(name, code)).toEqual([kind]);
    expect(opaqueOf(name, code, null)).toEqual([]);
  });

  it.each<[string, string]>([
    ["src/data/x.ts", "import(`./${x}.json`); import(`./${x}.css`); import(`./${x}.txt?raw`); import(`../ui/${x}.ts`); require.context('../ui', false, /\\.ts$/)"],
  ])("are not when what a name with unknown parts can stand for is data or source code: %s %s", (name, code) => {
    expect(opaqueOf(name, code)).toEqual([]);
  });

  it.each<[string, string]>([
    ["src/data/x.ts", "import './style.css'; import logo from './logo.png'; import d from './data.json'; import t from './notes.txt?raw'; import u from './notes.txt?url'"], ["src/data/x.ts", "import type { A } from './types'; import { B } from './types'"],
    ["src/data/x.ts", "import './missing'; import './missing.txt'; import '@/nothing/here'"], ["src/data/x.cjs", "require('../ui/secret.cjs'); require('./payload.js')"], ["src/data/x.ts", "import a from './assets'; import d from './data'"],
  ])("are not when it is data, an asset, a declaration file by its module name, or not there: %s %s", (name, code) => {
    expect(opaqueOf(name, code)).toEqual([]);
  });

  it("break no_opaque_imports in the working tree and before a change, as Node would run them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voxium-"));
    for (const [f, text] of Object.entries({ "src/ui/secret.cjs": "console.log('SECRET')", "src/data/x.cjs": "require('./payload.txt')", "src/data/payload.txt": "module.exports = require('../ui/secret.cjs')" })) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), text);
    }
    const ids = (graph: ReturnType<typeof buildGraph> | null) => (graph ? failing(checkArchitecture(arch(), graph)).map((v) => v.id) : null);
    expect(ids(buildGraph(root))).toEqual(["OPAQUE01:src/data/x.cjs"]);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "x");
    expect(ids(buildGraph(root))).toEqual(["OPAQUE01:src/data/x.cjs"]);
    expect(ids(buildGraphBefore(root))).toEqual(["OPAQUE01:src/data/x.cjs"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("include symlinks, whatever their names, with git and without", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voxium-"));
    const write = (f: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), text);
    };
    write("src/ui/secret.cjs", "console.log('SECRET LOADED')");
    write("src/ui/secret.txt", "console.log('SECRET LOADED')");
    write("src/ui/more/notes.txt", "require('../secret.cjs')");
    write("src/data/config.json", "{}");
    write("src/data/ok.cjs", "require('./config')");
    fs.symlinkSync("../ui/secret.cjs", path.join(root, "src/data/p.txt"));
    fs.symlinkSync("../ui/secret.cjs", path.join(root, "src/data/q"));
    fs.symlinkSync("../ui/more", path.join(root, "src/data/m"));
    fs.symlinkSync("/nowhere/x.js", path.join(root, "src/data/far.txt"));
    fs.symlinkSync("../ui/secret.cjs", path.join(root, "src/data/style.css"));
    // Named like source code, leading to code that is not read as source.
    fs.symlinkSync("../ui/secret.txt", path.join(root, "src/data/t.cjs"));
    fs.symlinkSync("../ui/secret.txt", path.join(root, "src/data/r.js"));
    // Without an ending, leading to data.
    fs.symlinkSync("config.json", path.join(root, "src/data/config"));
    const cases: Record<string, string> = {
      "a.cjs": "require('./p.txt')", "b.cjs": "require('./q')", "c.cjs": "const n = 'q'; require(`./${n}`)", "d.cjs": "require('./m/notes.txt')", "e.cjs": "require('./far.txt')",
      "f.cjs": "require('./style.css')", "g.cjs": "require('./t.cjs')", "h.cjs": "require('./r')",
    };
    for (const [f, code] of Object.entries(cases)) write(`src/data/${f}`, code);
    const expected = Object.keys(cases).map((f) => `OPAQUE01:src/data/${f}`);
    const ids = (graph: ReturnType<typeof buildGraph> | null) => (graph ? failing(checkArchitecture(arch(), graph)).map((v) => v.id).sort() : null);
    // Node runs each of them as code, since it loads what a link leads to, by the ending of that.
    for (const f of ["a.cjs", "b.cjs", "c.cjs", "d.cjs", "f.cjs", "g.cjs", "h.cjs"]) expect(execFileSync(process.execPath, [path.join(root, "src/data", f)], { encoding: "utf8" })).toContain("SECRET LOADED");
    expect(execFileSync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(path.join(root, "src/data/config"))})))`], { encoding: "utf8" }).trim()).toBe("{}");
    expect(ids(buildGraph(root))).toEqual(expected);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "x");
    expect(ids(buildGraph(root))).toEqual(expected);
    expect(ids(buildGraphBefore(root))).toEqual(expected);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("what Node loads", () => {
  const tree = (files: Record<string, string>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voxium-"));
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), text);
    }
    return root;
  };
  const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdio: "ignore" });
  const rules = arch({ rules: [...arch().rules, { id: "DENY01", type: "deny_dependency", from: "data", to: "ui", description: "d", rationale: "r", severity: "block" }] });
  const ids = (graph: ReturnType<typeof buildGraph> | null) => (graph ? failing(checkArchitecture(rules, graph)).map((v) => v.id).sort() : null);

  it("is the file of that very name before one with an ending, with git and without", () => {
    const root = tree({ "src/ui/secret.cjs": "console.log('SECRET LOADED')", "src/data/x": "module.exports = require('../ui/secret.cjs')", "src/data/x.js": "module.exports = 1", "src/data/a.cjs": "require('./x')" });
    expect(execFileSync(process.execPath, [path.join(root, "src/data/a.cjs")], { encoding: "utf8" })).toContain("SECRET LOADED");
    expect(ids(buildGraph(root))).toEqual(["OPAQUE01:src/data/a.cjs"]);
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "x");
    expect(ids(buildGraph(root))).toEqual(["OPAQUE01:src/data/a.cjs"]);
    expect(ids(buildGraphBefore(root))).toEqual(["OPAQUE01:src/data/a.cjs"]);
    // The file with the ending is still imported, as bundlers take it.
    expect(buildGraph(root).edges.filter((e) => e.from === "src/data/a.cjs").map((e) => e.to)).toEqual(["src/data/x.js"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is a .js file before a .ts file of the same name, and what a folder's package.json names before its index", () => {
    const files = { "src/ui/page.ts": "", "src/data/y.ts": "", "src/data/y.js": "", "src/data/d/index.ts": "", "src/data/d/package.json": `{ "main": "lib/m.js" }`, "src/data/d/lib/m.js": "", "src/data/a.cjs": "require('./y'); require('./d')" };
    const graph = buildGraphFromFiles(files, { paths: Object.keys(files) });
    expect(graph.edges.filter((e) => e.from === "src/data/a.cjs").map((e) => e.to).sort()).toEqual(["src/data/d/index.ts", "src/data/d/lib/m.js", "src/data/y.js", "src/data/y.ts"]);
    const hidden = { ...files, "src/data/d/package.json": `{ "main": "lib/m.txt" }`, "src/data/d/lib/m.txt": "" };
    expect(buildGraphFromFiles(hidden, { paths: Object.keys(hidden) }).opaque).toEqual([{ file: "src/data/a.cjs", line: 1, kind: "import" }]);
  });

  it("is a package in a committed node_modules folder of any folder above, which is opaque", () => {
    const root = tree({
      "src/ui/secret.cjs": "console.log('SECRET LOADED')", "src/data/node_modules/payload/index.js": "module.exports = require('../../../ui/secret.cjs')", "src/data/e.cjs": "require('payload')",
      "node_modules/@s/p/index.js": "", "src/data/f.cjs": "require('@s/p/x')", "src/data/g.cjs": "require('pg'); require('node:fs')",
    });
    expect(execFileSync(process.execPath, [path.join(root, "src/data/e.cjs")], { encoding: "utf8" })).toContain("SECRET LOADED");
    git(root, "init", "-q");
    git(root, "add", "-A", "-f");
    git(root, "commit", "-qm", "x");
    expect(ids(buildGraph(root))).toEqual(["OPAQUE01:src/data/e.cjs", "OPAQUE01:src/data/f.cjs"]);
    expect(ids(buildGraphBefore(root))).toEqual(["OPAQUE01:src/data/e.cjs", "OPAQUE01:src/data/f.cjs"]);
    // The package edge stays, so deny_external still sees it.
    expect(buildGraph(root).edges.filter((e) => e.from === "src/data/e.cjs").map((e) => e.pkg)).toEqual(["payload"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is what imports, exports and paths name by its very name, which is opaque when it is not source code", () => {
    const root = tree({
      "package.json": JSON.stringify({ name: "n2", imports: { "#s": "./src/ui/secret.txt", "#t": "./src/ui/plain", "#ok": "./src/data/config.json" } }),
      "src/ui/secret.txt": "console.log('SECRET LOADED')", "src/ui/plain": "console.log('SECRET LOADED')", "src/ui/plain.ts": "", "src/data/config.json": "{}",
      "src/data/a.cjs": "require('#s')", "src/data/b.cjs": "require('#t')", "src/data/c.cjs": "require('#ok')",
    });
    for (const f of ["a.cjs", "b.cjs"]) expect(execFileSync(process.execPath, [path.join(root, "src/data", f)], { encoding: "utf8" })).toContain("SECRET LOADED");
    const expected = ["DENY01:src/data/b.cjs->src/ui/plain.ts", "LAYER01:src/data/b.cjs->src/ui/plain.ts", "OPAQUE01:src/data/a.cjs", "OPAQUE01:src/data/b.cjs"];
    expect(ids(buildGraph(root))).toEqual(expected);
    git(root, "init", "-q");
    git(root, "add", "-A", "-f");
    git(root, "commit", "-qm", "x");
    expect(ids(buildGraph(root))).toEqual(expected);
    expect(ids(buildGraphBefore(root))).toEqual(expected);
    fs.rmSync(root, { recursive: true, force: true });

    // The same through tsconfig paths, baseUrl, the aliases of the architecture, and what a workspace package names.
    const files: FileMap = {
      "package.json": JSON.stringify({ workspaces: ["libs/*"] }),
      "libs/w/package.json": JSON.stringify({ name: "w", main: "lib.txt" }), "libs/w/lib.txt": "",
      "libs/e/package.json": JSON.stringify({ name: "e", exports: { "./x": "./x.sh" } }), "libs/e/x.sh": "",
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@h/*": ["src/ui/*"] } } }),
      "src/ui/h.txt": "", "src/ui/plain": "", "src/ui/style.css": "", "scripts/run": "",
      "src/data/a.ts": "import '@h/h.txt';", "src/data/b.ts": "import '@h/plain';", "src/data/c.ts": "import 'w';", "src/data/d.ts": "import 'e/x';",
      "src/data/e.ts": "import 'scripts/run';", "src/data/f.ts": "import '@al/h.txt';", "src/data/g.ts": "import '@h/style.css'; import 'w/package.json'; import 'react';",
    };
    const graph = buildGraphFromFiles(files, { paths: Object.keys(files), aliases: { "@al/*": ["src/ui/*"] } });
    expect(graph.unparsed).toEqual([]);
    expect(graph.opaque.map((o) => o.file)).toEqual(["src/data/a.ts", "src/data/b.ts", "src/data/c.ts", "src/data/d.ts", "src/data/e.ts", "src/data/f.ts"]);
    // Without the paths of the tree that cannot be told.
    expect(buildGraphFromFiles(files, { aliases: { "@al/*": ["src/ui/*"] } }).opaque).toEqual([]);
    // A declaration file that config names for TypeScript is not run.
    const typed: FileMap = {
      "package.json": JSON.stringify({ workspaces: ["libs/*"] }),
      "libs/t/package.json": JSON.stringify({ name: "t", main: "index.js", types: "index.d.ts", exports: { ".": { types: "./index.d.ts", default: "./index.js" }, "./x": { types: "./x.d.ts", default: "./x.js" } } }),
      "libs/t/index.js": "", "libs/t/index.d.ts": "", "libs/t/x.js": "", "libs/t/x.d.ts": "",
      "libs/u/package.json": JSON.stringify({ name: "u", types: "./types.d.ts" }), "libs/u/types.d.ts": "", "libs/u/index.js": "",
      "src/data/a.ts": "import 't'; import 't/x'; import 'u';",
    };
    expect(buildGraphFromFiles(typed, { paths: Object.keys(typed) }).opaque).toEqual([]);
  });

  it("is what the package.json of a committed node_modules folder names, which is not read, so a relative import of it is opaque", () => {
    const root = tree({
      "src/ui/secret.cjs": "console.log('SECRET LOADED')",
      "src/data/node_modules/mainpkg/package.json": `{"main":"lib.txt"}`, "src/data/node_modules/mainpkg/lib.txt": "require('../../../ui/secret.cjs')",
      "src/data/a4.cjs": "require('./node_modules/mainpkg')", "src/data/a5.cjs": "require('./node_modules/mainpkg/')",
      "src/data/pkgdir/package.json": `{"main":"index.ts"}`, "src/data/pkgdir/index.ts": "", "src/data/ok.cjs": "require('./pkgdir')",
    });
    expect(execFileSync(process.execPath, [path.join(root, "src/data/a4.cjs")], { encoding: "utf8" })).toContain("SECRET LOADED");
    git(root, "init", "-q");
    git(root, "add", "-A", "-f");
    git(root, "commit", "-qm", "x");
    expect(ids(buildGraph(root))).toEqual(["OPAQUE01:src/data/a4.cjs", "OPAQUE01:src/data/a5.cjs"]);
    expect(ids(buildGraphBefore(root))).toEqual(["OPAQUE01:src/data/a4.cjs", "OPAQUE01:src/data/a5.cjs"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is what a folder's package.json names before its index, so one that is not read or cannot be read is opaque whatever index is there", () => {
    const root = tree({
      "src/ui/secret.cjs": "console.log('SECRET LOADED')",
      "src/data/node_modules/mainpkg/package.json": `{"main":"lib.txt"}`, "src/data/node_modules/mainpkg/lib.txt": "require('../../../ui/secret.cjs')", "src/data/node_modules/mainpkg/index.json": "{}",
      "src/data/a6.cjs": "require('./node_modules/mainpkg')",
      "src/data/pkgdir/package.json": JSON.stringify({ main: "lib.txt", pad: "x".repeat(1_100_000) }), "src/data/pkgdir/lib.txt": "require('../../ui/secret.cjs')", "src/data/pkgdir/index.json": "{}",
      "src/data/a7.cjs": "require('./pkgdir')",
      "src/data/bare/package.json": JSON.stringify({ main: "lib.txt", pad: "x".repeat(1_100_000) }), "src/data/bare/lib.txt": "require('../../ui/secret.cjs')",
      "src/data/a8.cjs": "require('./bare')",
      // A file of that name or with an ending comes first, so the folder's package.json does not matter there.
      "src/data/first.js": "", "src/data/first/package.json": "{", "src/data/a9.cjs": "require('./first')",
      "src/data/known/package.json": `{"main":"m.json"}`, "src/data/known/m.json": "{}", "src/data/known/index.json": "{}", "src/data/ok.cjs": "require('./known')",
    });
    for (const f of ["a6.cjs", "a7.cjs", "a8.cjs"]) expect(execFileSync(process.execPath, [path.join(root, "src/data", f)], { encoding: "utf8" }), f).toContain("SECRET LOADED");
    const expected = ["OPAQUE01:src/data/a6.cjs", "OPAQUE01:src/data/a7.cjs", "OPAQUE01:src/data/a8.cjs"];
    const gaps = [{ file: "src/data/bare/package.json", reason: "is too large to be read" }, { file: "src/data/pkgdir/package.json", reason: "is too large to be read" }];
    git(root, "init", "-q");
    git(root, "add", "-A", "-f");
    git(root, "commit", "-qm", "x");
    for (const graph of [buildGraph(root), buildGraphBefore(root)!]) {
      expect(ids(graph)).toEqual(expected);
      // A package.json that cannot be read is a gap where a relative import loads its folder, not only above code.
      expect(graph.unparsed.filter((u) => u.file.endsWith("package.json"))).toEqual(gaps);
    }
    fs.rmSync(root, { recursive: true, force: true });
    // Without the paths of the tree, one in the files that cannot be read is opaque as well.
    const files = { "src/data/p/package.json": "{", "src/data/p/index.json": "{}", "src/data/a.cjs": "require('./p')" };
    const graph = buildGraphFromFiles(files);
    expect(graph.opaque).toEqual([{ file: "src/data/a.cjs", line: 1, kind: "import" }]);
    expect(graph.unparsed).toEqual([{ file: "src/data/p/package.json", reason: "is not valid JSON" }]);
  });

  it("is the folder for a name that ends with '/', '/.' or '..', never a file of that name, with git and without", () => {
    const root = tree({
      "src/ui.js": "", "src/ui/index.js": "console.log('UI INDEX LOADED')",
      "src/data/a.cjs": "require('../ui/')", "src/data/b.cjs": "require('../ui/.')",
      "src/data.js": "", "src/data/index.js": "require('../ui/index.js')", "src/data/sub/c.cjs": "require('..')",
      "src/data/p.js": "", "src/data/p/package.json": `{"main":"m.txt"}`, "src/data/p/m.txt": "console.log('MAIN LOADED')", "src/data/d.cjs": "require('./p/')",
      "src/data/q.js": "", "src/data/q/index.ts": "", "src/data/e.ts": "import './q/';",
      "src/data/f.cjs": "require('../ui')",
    });
    for (const f of ["a.cjs", "b.cjs", "sub/c.cjs"]) expect(execFileSync(process.execPath, [path.join(root, "src/data", f)], { encoding: "utf8" }), f).toContain("UI INDEX LOADED");
    expect(execFileSync(process.execPath, [path.join(root, "src/data/d.cjs")], { encoding: "utf8" })).toContain("MAIN LOADED");
    const expected = [
      "DENY01:src/data/a.cjs->src/ui/index.js", "DENY01:src/data/b.cjs->src/ui/index.js", "DENY01:src/data/index.js->src/ui/index.js",
      "LAYER01:src/data/a.cjs->src/ui/index.js", "LAYER01:src/data/b.cjs->src/ui/index.js", "LAYER01:src/data/index.js->src/ui/index.js", "OPAQUE01:src/data/d.cjs",
    ];
    const edges = (graph: ReturnType<typeof buildGraph>) => graph.edges.filter((e) => e.to && /^src\/data\/(?:[a-f]\.|sub)/.test(e.from)).map((e) => `${e.from}->${e.to}`).sort();
    const expectedEdges = [
      "src/data/a.cjs->src/ui/index.js", "src/data/b.cjs->src/ui/index.js", "src/data/e.ts->src/data/q/index.ts", "src/data/f.cjs->src/ui.js", "src/data/sub/c.cjs->src/data/index.js",
    ];
    expect(ids(buildGraph(root))).toEqual(expected);
    expect(edges(buildGraph(root))).toEqual(expectedEdges);
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "x");
    for (const graph of [buildGraph(root), buildGraphBefore(root)!]) {
      expect(ids(graph)).toEqual(expected);
      expect(edges(graph)).toEqual(expectedEdges);
    }
    fs.rmSync(root, { recursive: true, force: true });
    // The same for "." and "./", and through an alias, a tsconfig path, baseUrl and a workspace package's subpath.
    const files: FileMap = {
      "package.json": JSON.stringify({ workspaces: ["libs/*"] }), "libs/w/package.json": JSON.stringify({ name: "w" }), "libs/w/k.ts": "", "libs/w/k/index.ts": "",
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@h/*": ["src/ui/*"] } } }),
      "src/ui/z.ts": "", "src/ui/z/index.ts": "", "src/data/g.ts": "", "src/data/g/index.ts": "",
      "src/data/g/h.ts": "import '.'; import './';", "src/data/i.ts": "import '@/ui/z/'; import '@h/z/'; import 'src/ui/z/'; import 'w/k/';",
    };
    const graph = buildGraphFromFiles(files, { paths: Object.keys(files) });
    expect(graph.unparsed).toEqual([]);
    expect(graph.edges.filter((e) => e.to && e.from.startsWith("src/data/")).map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      "src/data/g/h.ts->src/data/g/index.ts", "src/data/g/h.ts->src/data/g/index.ts",
      "src/data/i.ts->libs/w/k/index.ts", "src/data/i.ts->src/ui/z/index.ts", "src/data/i.ts->src/ui/z/index.ts", "src/data/i.ts->src/ui/z/index.ts",
    ]);
  });

  it("is a declaration file that package.json imports or exports name outside a types condition, which Node runs", () => {
    const root = tree({
      "package.json": JSON.stringify({ name: "n", imports: { "#lib": "./src/data/lib.d.ts", "#typed": { types: "./src/data/t.d.ts", default: "./src/data/t.js" } } }),
      "src/ui/secret.cjs": "console.log('SECRET LOADED')", "src/data/lib.d.ts": "require('../ui/secret.cjs')", "src/data/t.d.ts": "", "src/data/t.js": "",
      "src/data/a.cjs": "require('#lib')", "src/data/b.cjs": "require('#typed')",
    });
    expect(execFileSync(process.execPath, [path.join(root, "src/data/a.cjs")], { encoding: "utf8" })).toContain("SECRET LOADED");
    expect(ids(buildGraph(root))).toEqual(["OPAQUE01:src/data/a.cjs"]);
    fs.rmSync(root, { recursive: true, force: true });
    const files: FileMap = {
      "package.json": JSON.stringify({ workspaces: ["libs/*"] }),
      "libs/m/package.json": JSON.stringify({ name: "m", main: "index.d.ts" }), "libs/m/index.d.ts": "",
      "libs/e/package.json": JSON.stringify({ name: "e", exports: { "./x": { node: "./x.d.ts" }, "./y": { "types@>=5": "./y.d.ts", default: "./y.js" } } }), "libs/e/x.d.ts": "", "libs/e/y.d.ts": "", "libs/e/y.js": "",
      "src/data/a.ts": "import 'm';", "src/data/b.ts": "import 'e/x';", "src/data/c.ts": "import 'e/y';",
    };
    expect(buildGraphFromFiles(files, { paths: Object.keys(files) }).opaque.map((o) => o.file)).toEqual(["src/data/a.ts", "src/data/b.ts"]);
  });

  it("leaves installed packages that are not in the tree alone", () => {
    const files = { "src/ui/page.ts": "", "src/data/g.cjs": "require('pg'); require('payload')", "src/ui/node_modules/payload/index.js": "" };
    expect(buildGraphFromFiles(files, { paths: [...Object.keys(files), "src/ui/node_modules/payload/index.js"] }).opaque).toEqual([]);
  });
});

describe("symlinked config files", () => {
  it("have the contents of what they lead to, with git and without, and before a change", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voxium-"));
    const write = (f: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), text);
    };
    write("config/tsconfig.shared.json", JSON.stringify({ compilerOptions: { paths: { "@ui/*": ["../src/ui/*"] } } }));
    write("config/shared/package.json", JSON.stringify({ name: "app", imports: { "#page": "./src/ui/page.ts" } }));
    write("src/ui/page.ts", "");
    write("src/data/a.ts", "import '@ui/page'; import '#page';");
    fs.symlinkSync("config/shared/package.json", path.join(root, "package.json"));
    fs.mkdirSync(path.join(root, "web"));
    fs.symlinkSync("../config/tsconfig.shared.json", path.join(root, "web/tsconfig.json"));
    write("web/b.ts", "import '@ui/page';");
    const edges = (graph: ReturnType<typeof buildGraph> | null) => {
      expect(graph?.unparsed).toEqual([]);
      return graph!.edges.filter((e) => e.to).map((e) => `${e.from}->${e.to}`).sort();
    };
    // The link in web/ is read as if it were there, so its "../src/ui/*" is relative to web/.
    const all = ["src/data/a.ts->src/ui/page.ts", "web/b.ts->src/ui/page.ts"];
    expect(edges(buildGraph(root))).toEqual(all);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "x");
    expect(edges(buildGraph(root))).toEqual(all);
    expect(edges(buildGraphBefore(root))).toEqual(all);
    expect(expandSymlinks({ "a/tsconfig.json": "{}", "src/x.ts": "" }, { "tsconfig.json": "a/tsconfig.json", "src/tsconfig.json": "src/x.ts" })).toEqual({ "a/tsconfig.json": "{}", "src/x.ts": "", "tsconfig.json": "{}" });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("files that cannot be read to their end", () => {
  const broken = "import '../ui/page'; `";

  it("have no edges, whatever was found before that", () => {
    const graph = buildGraphFromFiles({ "src/data/db.ts": broken, "src/ui/page.ts": "import '../data/db'" });
    expect(graph.unparsed).toEqual([{ file: "src/data/db.ts", reason: "ends inside a template literal" }]);
    expect(graph.edges.map((e) => e.from)).toEqual(["src/ui/page.ts"]);
    expect(graph.files).toContain("src/data/db.ts");
  });

  it("have none of what is in another script of theirs either", () => {
    const vue = "<script>import '../ui/page'</script>\n<script setup>`</script>";
    const graph = buildGraphFromFiles({ "src/data/db.vue": `${vue}\n<template/>`, "src/ui/page.ts": "", "src/data/e.vue": `<script>import '../ui/page'; import(x)</script>` });
    expect(graph.unparsed.map((u) => u.file)).toEqual(["src/data/db.vue"]);
    expect(graph.edges.map((e) => e.from)).toEqual(["src/data/e.vue"]);
    expect(graph.opaque.map((o) => o.file)).toEqual(["src/data/e.vue"]);
  });

  it("matter unless they are ignored and nothing that is checked leads to them", () => {
    const files = { "src/ui/page.ts": "", "gen/a.ts": broken, "gen/b.ts": broken, "gen/c.ts": "import './a'" };
    const names = (f: FileMap, ignore?: string[]) => unparsedFiles(buildGraphFromFiles(f), ignore).map((u) => u.file);
    expect(names(files)).toEqual(["gen/a.ts", "gen/b.ts"]);
    expect(names(files, ["gen/**"])).toEqual([]);
    expect(names({ ...files, "src/ui/page.ts": "import '../../gen/c'" }, ["gen/**"])).toEqual(["gen/a.ts"]);
    expect(names(files, ["gen/b.ts"])).toEqual(["gen/a.ts"]);
    expect(uncheckedPaths(buildGraphFromFiles(files), [])).toEqual([]);
  });

  it("are proposed as ignored at setup, and named", () => {
    const { architecture, notes } = inferArchitecture(buildGraphFromFiles({ "src/ui/a.ts": "import '../data/b'", "src/data/b.ts": "", "src/templates/t.js": "'{{ name }" }));
    expect(architecture.ignore).toContain("src/templates/t.js");
    expect(notes.join()).toContain("src/templates/t.js");
  });

  it("are told of in the working tree and in the code from before a change", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voxium-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdio: "ignore" });
    fs.writeFileSync(path.join(root, "a.ts"), broken);
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "x");
    fs.writeFileSync(path.join(root, "a.ts"), "");
    expect(buildGraphBefore(root)?.unparsed.map((u) => u.file)).toEqual(["a.ts"]);
    expect(buildGraph(root).unparsed).toEqual([]);
  });

  it("make a planned import that leads to them not allowed", () => {
    const ctx = { arch: arch(), baseline: [], files: { "src/ui/page.ts": "", "lib/a.ts": "import './b'", "lib/b.ts": broken, "lib/c.ts": "" } };
    expect(checkImport(ctx, "src/ui/page.ts", "lib/a.ts")).toMatchObject({ allowed: false, problems: [], unparsed: [{ file: "lib/b.ts" }] });
    expect(checkImport(ctx, "src/ui/page.ts", "lib/b.ts")).toMatchObject({ allowed: false, unparsed: [{ file: "lib/b.ts" }] });
    expect(checkImport(ctx, "src/ui/page.ts", "lib/c.ts")).toMatchObject({ allowed: true, unparsed: [] });
    expect(checkImport(ctx, "src/ui/page.ts", "pg")).toMatchObject({ allowed: true, unparsed: [] });
  });

  it("make a planned change not ok", () => {
    const ctx = { arch: arch(), baseline: [], files: { "src/ui/page.ts": "", "src/data/db.ts": "" } };
    const res = checkChange(ctx, [{ path: "src/data/db.ts", content: broken }]);
    expect(res).toMatchObject({ ok: false, introduced: [], unparsed: [{ file: "src/data/db.ts", reason: "ends inside a template literal" }] });
    expect(checkChange({ ...ctx, arch: arch({ ignore: ["src/data/**"] }) }, [{ path: "src/data/db.ts", content: broken }])).toMatchObject({ ok: true, unparsed: [] });
    expect(checkChange(ctx, [{ path: "src/data/db.ts", content: "import '../ui/page'" }])).toMatchObject({ ok: false, unparsed: [] });
  });
});
