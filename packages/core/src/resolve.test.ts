import { describe, expect, it } from "vitest";
import {
  buildGraphFromFiles,
  checkArchitecture,
  describeRuleChanges,
  failing,
  getArchitectureSummary,
  inferArchitecture,
  isConfigPath,
  isSourcePath,
  readJsonc,
  unparsedFiles,
  validateArchitecture,
  type Architecture,
  type BuildGraphOptions,
  type FileMap,
  type Rule,
} from "./index.js";
import { checkChange } from "./tools.js";

/** What each import of a file leads to: files, and packages as "pkg name". */
function targets(files: FileMap, from: string, opts: BuildGraphOptions = {}): string[] {
  const graph = buildGraphFromFiles(files, opts);
  expect(graph.unparsed).toEqual([]);
  return [...new Set(graph.edges.filter((e) => e.from === from).map((e) => e.to ?? `pkg ${e.pkg}`))].sort();
}

const rule = (r: Partial<Rule> & { id: string; type: Rule["type"] }): Rule => ({ description: "d", rationale: "r", severity: "block", ...r }) as Rule;

const arch = (modules: Record<string, string>, over: Partial<Architecture> = {}): Architecture => ({
  version: 1,
  modules: Object.fromEntries(Object.entries(modules).map(([name, glob]) => [name, { paths: [glob] }])),
  layers: Object.keys(modules),
  rules: [rule({ id: "LAYER01", type: "layers" })],
  exceptions: [],
  ...over,
});

const ids = (a: Architecture, files: FileMap, opts: BuildGraphOptions = {}) => [...new Set(failing(checkArchitecture(a, buildGraphFromFiles(files, opts))).map((v) => v.id))].sort();

const json = (value: unknown) => JSON.stringify(value);

/** An npm workspace: a ui package that uses a data package through its exports. */
const NPM: FileMap = {
  "package.json": json({ name: "root", private: true, workspaces: ["packages/*"] }),
  "packages/ui/package.json": json({ name: "@acme/ui", main: "src/index.ts", dependencies: { "@acme/data": "*" } }),
  "packages/ui/src/index.ts": "export {};",
  "packages/ui/src/page.ts": `import { db } from "@acme/data";\nimport { q } from "@acme/data/query";\nimport { e } from "@acme/data/extra";\nimport React from "react";`,
  "packages/data/package.json": json({
    name: "@acme/data",
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/esm/index.js", require: "./dist/cjs/index.cjs" }, "./query": "./dist/query.js", "./*": "./src/*.ts", "./package.json": "./package.json" },
  }),
  "packages/data/src/index.ts": "export const db = 1;",
  "packages/data/src/query.ts": "export const q = 1;",
  "packages/data/src/extra.ts": "export const e = 1;",
};
const PACKAGES = { ui: "packages/ui/**", data: "packages/data/**" };

describe("workspace packages", () => {
  it("are files of npm workspaces, through exports with conditions, patterns, and dist standing for src", () => {
    expect(targets(NPM, "packages/ui/src/page.ts")).toEqual([
      "packages/data/src/extra.ts", "packages/data/src/index.ts", "packages/data/src/query.ts", "pkg @acme/data", "pkg react",
    ]);
  });

  it("are files of pnpm workspaces, but not of folders the workspace leaves out", () => {
    const files: FileMap = {
      "pnpm-workspace.yaml": "# the packages\npackages:\n  - 'apps/*'\n  - \"libs/**\"   # all\n  - '!libs/skip'\n",
      "package.json": json({ name: "root" }),
      "libs/core/package.json": json({ name: "core-lib", main: "dist/index.js" }),
      "libs/core/src/index.ts": "",
      "libs/skip/package.json": json({ name: "skip-lib", main: "index.ts" }),
      "libs/skip/index.ts": "",
      "apps/web/package.json": json({ name: "web" }),
      "apps/web/src/a.ts": "import 'core-lib'; import 'skip-lib';",
    };
    expect(targets(files, "apps/web/src/a.ts")).toEqual(["libs/core/src/index.ts", "pkg core-lib", "pkg skip-lib"]);
  });

  it("are files of yarn workspaces, by main, module and subpath, and of workspace:, file: and link: dependencies", () => {
    const files: FileMap = {
      "package.json": json({ workspaces: { packages: ["modules/*"] }, dependencies: { linked: "link:./vendor/linked", local: "file:vendor/local", ws: "workspace:*" } }),
      "modules/m/package.json": json({ name: "m", module: "lib/m.mjs" }),
      "modules/m/lib/m.mjs": "",
      "modules/m/src/sub.ts": "",
      "vendor/linked/package.json": json({ name: "whatever" }),
      "vendor/linked/index.js": "",
      "vendor/local/package.json": json({ name: "local", main: "main.js" }),
      "vendor/local/main.js": "",
      "tools/ws/package.json": json({ name: "ws", types: "types/index.d.ts" }),
      "tools/ws/src/index.ts": "",
      "tools/ws/types/index.d.ts": "",
      "src/a.ts": "import 'm'; import 'm/sub'; import 'linked'; import 'local'; import 'ws';",
    };
    expect(targets(files, "src/a.ts")).toEqual([
      "modules/m/lib/m.mjs", "modules/m/src/sub.ts", "pkg linked", "pkg local", "pkg m", "pkg ws", "tools/ws/src/index.ts", "vendor/linked/index.js", "vendor/local/main.js",
    ]);
  });

  it("include what any member of the workspace depends on, which is installed for all of them, but not what a fixture does", () => {
    const files: FileMap = {
      "package.json": json({ workspaces: ["packages/*"] }),
      "packages/b/package.json": json({ name: "b", dependencies: { evil: "file:../../src/ui", sql: "npm:pg@8" } }),
      "packages/a/package.json": json({ name: "a" }),
      "packages/a/src/x.ts": "import 'evil'; import 'sql';",
      "src/ui/package.json": json({ name: "ui", main: "page.ts" }),
      "src/ui/page.ts": "",
      "test/fixture/package.json": json({ name: "f", dependencies: { other: "file:../../src/ui", react: "npm:preact@10" } }),
      "packages/a/src/y.ts": "import 'other'; import 'react';",
    };
    expect(targets(files, "packages/a/src/x.ts")).toEqual(["pkg evil", "pkg pg", "pkg sql", "src/ui/page.ts"]);
    expect(targets(files, "packages/a/src/y.ts")).toEqual(["pkg other", "pkg react"]);
  });

  it("are their package.json when nothing in them matches, and a package may import itself by its name", () => {
    const files: FileMap = {
      "package.json": json({ workspaces: ["packages/*"] }),
      "packages/built/package.json": json({ name: "built", main: "dist/out.js" }),
      "packages/self/package.json": json({ name: "self", exports: { "./x": "./src/x.ts" } }),
      "packages/self/src/x.ts": "",
      "packages/self/src/y.ts": "import 'self/x'; import 'built';",
    };
    expect(targets(files, "packages/self/src/y.ts")).toEqual(["packages/built/package.json", "packages/self/src/x.ts", "pkg built", "pkg self"]);
  });

  it("break the layers across packages, and deny_external still fires with the id it had", () => {
    const a = arch(PACKAGES, { rules: [rule({ id: "LAYER01", type: "layers" }), rule({ id: "EXT01", type: "deny_external", module: "ui", packages: ["@acme/data"] })] });
    const up = { ...NPM, "packages/data/src/index.ts": "import '@acme/ui';" };
    expect(ids(a, up)).toEqual(["EXT01:packages/ui/src/page.ts->@acme/data", "LAYER01:packages/data/src/index.ts->packages/ui/src/index.ts"]);
    // A package that resolves to its package.json is still in its module.
    const built = { ...up, "packages/ui/package.json": json({ name: "@acme/ui", main: "dist/index.js" }), "packages/ui/src/index.ts": undefined } as unknown as FileMap;
    delete built["packages/ui/src/index.ts"];
    expect(ids(a, built)).toContain("LAYER01:packages/data/src/index.ts->packages/ui/package.json");
  });

  it("are not created by a fixture with the name of a real package outside the workspace", () => {
    const files: FileMap = {
      "package.json": json({ workspaces: ["packages/*"] }),
      "test/fixtures/x/package.json": json({ name: "react", main: "index.js" }),
      "test/fixtures/x/index.js": "",
      "test/fixtures/mono/package.json": json({ workspaces: ["*"] }),
      "test/fixtures/mono/react/package.json": json({ name: "react", main: "index.js" }),
      "test/fixtures/mono/react/index.js": "",
      "test/fixtures/mono/app/a.js": "import 'react';",
      "src/ui/a.ts": "import 'react';",
    };
    expect(targets(files, "src/ui/a.ts")).toEqual(["pkg react"]);
    // Within that fixture's own workspace it is what Node would load there.
    expect(targets(files, "test/fixtures/mono/app/a.js")).toEqual(["pkg react", "test/fixtures/mono/react/index.js"]);
  });
});

describe("tsconfig", () => {
  it("resolves names from baseUrl, in tsconfig and jsconfig", () => {
    const files: FileMap = { "tsconfig.json": json({ compilerOptions: { baseUrl: "." } }), "web/jsconfig.json": json({ compilerOptions: { baseUrl: "src" } }), "src/data/x.ts": "", "web/src/lib/y.js": "", "src/ui/a.ts": "import 'src/data/x';", "web/src/a.js": "import 'lib/y';" };
    expect(targets(files, "src/ui/a.ts")).toEqual(["pkg src", "src/data/x.ts"]);
    expect(targets(files, "web/src/a.js")).toEqual(["pkg lib", "web/src/lib/y.js"]);
  });

  it("resolves wildcard paths, taking the first target that is there, and paths without baseUrl from their own folder", () => {
    const files: FileMap = {
      "tsconfig.json": json({ compilerOptions: { baseUrl: "./src", paths: { "@app/*": ["app/*", "fallback/*"], "@lib": ["lib/index.ts"], "@app/special": ["special.ts"] } } }),
      "packages/x/tsconfig.json": json({ compilerOptions: { paths: { "~x/*": ["./src/*"] } } }),
      "src/app/x.ts": "", "src/fallback/x.ts": "", "src/fallback/y.ts": "", "src/lib/index.ts": "", "src/special.ts": "", "packages/x/src/z.ts": "",
      "src/ui/a.ts": "import '@app/x'; import '@app/y'; import '@lib'; import '@app/special'; import '@app/x?raw';",
      "packages/x/src/b.ts": "import '~x/z';",
    };
    expect(targets(files, "src/ui/a.ts")).toEqual(["pkg @app/special", "pkg @app/x", "pkg @app/y", "pkg @lib", "src/app/x.ts", "src/fallback/y.ts", "src/lib/index.ts", "src/special.ts"]);
    expect(targets(files, "packages/x/src/b.ts")).toEqual(["packages/x/src/z.ts", "pkg ~x"]);
  });

  it("follows chains of extends, with comments, trailing commas and names without .json", () => {
    const files: FileMap = {
      "tsconfig.json": `{\n  // the base\n  "extends": "./configs/tsconfig.base",\n  /* nothing else */ "compilerOptions": { "strict": true, },\n}`,
      "configs/tsconfig.base.json": json({ extends: "./tsconfig.paths.json", compilerOptions: { baseUrl: ".." } }),
      "configs/tsconfig.paths.json": json({ compilerOptions: { paths: { "@d/*": ["src/data/*"] } } }),
      "src/data/x.ts": "", "src/ui/a.ts": "import '@d/x'; // \"@d/no\"",
    };
    expect(targets(files, "src/ui/a.ts")).toEqual(["pkg @d/x", "src/data/x.ts"]);
    // An array of bases, the later winning, as TypeScript has it.
    const many = { ...files, "tsconfig.json": json({ extends: ["./configs/tsconfig.paths.json", "./configs/tsconfig.base.json"] }) };
    expect(targets(many, "src/ui/a.ts")).toEqual(["pkg @d/x", "src/data/x.ts"]);
  });

  it("keeps the first match for @/ and adds what a tsconfig in a folder says, so a change cannot remap an import away", () => {
    const files: FileMap = {
      "tsconfig.json": json({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "src/data/db.ts": "",
      "src/ui/page.ts": "import { db } from '@/data/db';",
    };
    const a = arch({ ui: "src/ui/**", data: "src/data/**" }, { rules: [rule({ id: "DENY01", type: "deny_dependency", from: "ui", to: "data" })] });
    expect(ids(a, files)).toEqual(["DENY01:src/ui/page.ts->src/data/db.ts"]);
    const remapped = { ...files, "src/ui/tsconfig.json": json({ compilerOptions: { paths: { "@/data/*": ["./stub/*"] } } }), "src/ui/stub/db.ts": "" };
    expect(targets(remapped, "src/ui/page.ts")).toEqual(["src/data/db.ts", "src/ui/stub/db.ts"]);
    expect(ids(a, remapped)).toEqual(["DENY01:src/ui/page.ts->src/data/db.ts"]);
  });

  it("ignores what leads out of the repo, and packages it extends, which are in node_modules", () => {
    const files: FileMap = {
      "tsconfig.json": json({ extends: ["@tsconfig/node20/tsconfig.json", "../../../outside.json"], compilerOptions: { baseUrl: "../../..", paths: { "@x/*": ["../../../etc/*", "src/*"] } } }),
      "src/y.ts": "", "src/a.ts": "import '@x/y';",
    };
    expect(targets(files, "src/a.ts")).toEqual(["pkg @x/y"]);
    const rooted = { ...files, "tsconfig.json": json({ extends: "@tsconfig/node20/tsconfig.json", compilerOptions: { paths: { "@x/*": ["../../../etc/*", "./src/*"] } } }) };
    expect(targets(rooted, "src/a.ts")).toEqual(["pkg @x/y", "src/y.ts"]);
  });
});

describe("package.json", () => {
  const files: FileMap = {
    "package.json": json({
      name: "app",
      imports: { "#db": { node: "./src/data/db-node.ts", default: "./src/data/db.ts" }, "#ui/*": "./src/ui/*.ts", "#pg": "pg", "#fs": "node:fs" },
      dependencies: { x: "npm:pg@8", "@my/ws": "npm:@scope/real@^1", plain: "^1.0.0" },
    }),
    "src/data/db.ts": "", "src/data/db-node.ts": "", "src/ui/page.ts": "",
    "src/data/a.ts": "import '#db'; import '#ui/page'; import '#pg'; import x from 'x'; import '@my/ws/sub'; import 'plain'; import '#fs';",
  };

  it("resolves imports under every condition, npm: aliases to the real package, and keeps the edge of the name", () => {
    expect(targets(files, "src/data/a.ts")).toEqual([
      "pkg #db", "pkg #fs", "pkg #pg", "pkg #ui", "pkg @my/ws", "pkg @scope/real", "pkg fs", "pkg pg", "pkg plain", "pkg x", "src/data/db-node.ts", "src/data/db.ts", "src/ui/page.ts",
    ]);
  });

  it("cannot dodge deny_external with an alias, an import or the node: prefix", () => {
    const a = arch({ ui: "src/ui/**", data: "src/data/**" }, { rules: [rule({ id: "EXT", type: "deny_external", module: "data", packages: ["pg", "@scope/real", "node:fs", "child_process"] })] });
    const more = { ...files, "src/data/b.ts": "import 'node:child_process'; import 'fs';" };
    expect(ids(a, more)).toEqual([
      "EXT:src/data/a.ts->@scope/real", "EXT:src/data/a.ts->fs", "EXT:src/data/a.ts->pg", "EXT:src/data/b.ts->child_process", "EXT:src/data/b.ts->fs",
    ]);
  });
});

describe("aliases of the architecture", () => {
  it("are proposed from the root tsconfig and workspace", () => {
    const files: FileMap = { ...NPM, "tsconfig.json": json({ compilerOptions: { baseUrl: ".", paths: { "@ui/*": ["packages/ui/src/*"] } } }) };
    const inferred = inferArchitecture(buildGraphFromFiles(files)).architecture;
    expect(inferred.aliases).toEqual({
      "*": ["*"],
      "@acme/data": ["packages/data/src/index.ts"],
      "@acme/data/*": ["packages/data/src/*", "packages/data/*"],
      "@acme/ui": ["packages/ui/src/index.ts"],
      "@acme/ui/*": ["packages/ui/src/*", "packages/ui/*"],
      "@ui/*": ["packages/ui/src/*"],
    });
    expect(validateArchitecture(inferred)).toEqual({ ok: true, errors: [] });
  });

  it("keep the edges when a change removes the workspace or the tsconfig paths", () => {
    const base: FileMap = { ...NPM, "packages/data/src/index.ts": "import '@acme/ui';", "tsconfig.json": json({ compilerOptions: { paths: { "@ui/*": ["./packages/ui/src/*"] } } }), "packages/data/src/q2.ts": "import '@ui/page';" };
    const aliases = inferArchitecture(buildGraphFromFiles(base)).architecture.aliases;
    const a = arch(PACKAGES, { aliases });
    const expected = ["LAYER01:packages/data/src/index.ts->packages/ui/src/index.ts", "LAYER01:packages/data/src/q2.ts->packages/ui/src/page.ts"];
    expect(ids(a, base, { aliases })).toEqual(expected);
    const head = { ...base, "package.json": json({ name: "root" }), "tsconfig.json": json({}) };
    expect(ids(a, head)).toEqual([]);
    expect(ids(a, head, { aliases })).toEqual(expected);
    // A decoy package of the same name only adds to it.
    const decoy = { ...base, "packages/decoy/package.json": json({ name: "@acme/ui", main: "x.ts" }), "packages/decoy/x.ts": "" };
    expect(targets(decoy, "packages/data/src/index.ts")).toEqual(["packages/decoy/x.ts", "packages/ui/src/index.ts", "pkg @acme/ui"]);
  });

  it("are validated and named one by one when they change", () => {
    const ok = arch({ ui: "src/ui/**" }, { aliases: { "@app/*": ["src/app/*", "src/*"], "#db": ["src/data/db.ts"] } });
    expect(validateArchitecture(ok).ok).toBe(true);
    for (const aliases of [[], { "@a/*": [] }, { "@a": ["../x"] }, { "@a": ["/etc/x"] }, { "@a": ["src/*"] }, { "@a/**": ["src/*"] }, { "./x": ["src"] }, { "@a": [1] }, { "@a": "src" }]) {
      expect(validateArchitecture({ ...ok, aliases }).ok, JSON.stringify(aliases)).toBe(false);
    }
    const before = { ...ok, aliases: { "@app/*": ["src/app/*", ...Array.from({ length: 19 }, (_, i) => `src/very/long/path/number/${i}/*`)], "#db": ["src/data/db.ts"], "@keep": ["src/k.ts"] } };
    const after = { ...ok, aliases: { "@keep": ["src/k2.ts"], "@new/*": ["src/new/*"] } };
    const lines = describeRuleChanges({ "voxium/architecture.json": json(before) }, { "voxium/architecture.json": json(after) }, ["voxium/architecture.json"]);
    expect(lines.filter((l) => /alias/.test(l)).map((l) => l.split(" (was")[0].split(", so")[0])).toEqual([
      "Removes alias @app/*", "Removes alias #db", "Changes alias @keep: it no longer stands for src/k.ts", "Changes alias @keep: it now also stands for src/k2.ts", "Adds alias @new/* for src/new/*",
    ]);
    expect(lines.some((l) => l.startsWith("Changes aliases"))).toBe(false);
  });

  it("name each path that a changed alias no longer stands for, and keep long names apart", () => {
    const describe = (b: Record<string, string[]>, c: Record<string, string[]>) =>
      describeRuleChanges({ "voxium/architecture.json": json(arch({ ui: "src/ui/**" }, { aliases: b })) }, { "voxium/architecture.json": json(arch({ ui: "src/ui/**" }, { aliases: c })) }, ["voxium/architecture.json"]);
    const twelve = Array.from({ length: 12 }, (_, i) => `packages/feature-number-${i}/src/*`);
    const fewer = describe({ "@app/*": twelve }, { "@app/*": twelve.slice(0, 11) });
    expect(fewer).toEqual(["Changes alias @app/*: it no longer stands for packages/feature-number-11/src/*, so imports by that name may no longer be seen there"]);
    const order = describe({ "@app/*": ["src/a/*", "src/b/*"] }, { "@app/*": ["src/b/*", "src/a/*"] });
    expect(order).toEqual(["Changes the order of the paths of alias @app/*, which decides the one TypeScript takes: src/b/*, src/a/*"]);
    // Two names that share their first 80 characters, with their paths swapped.
    const [n1, n2] = [`@${"x".repeat(90)}1/*`, `@${"x".repeat(90)}2/*`];
    const swapped = describe({ [n1]: ["src/one/*"], [n2]: ["src/two/*"] }, { [n1]: ["src/two/*"], [n2]: ["src/one/*"] });
    expect(swapped).toHaveLength(4);
    const nameOf = (l: string) => l.split(":")[0];
    expect(nameOf(swapped[0])).not.toBe(nameOf(swapped[1]));
    expect(swapped.every((l) => l.length < 400)).toBe(true);
    // A long path that is cut is told apart from one that begins alike.
    const long = (end: string) => `src/${"deep/".repeat(50)}${end}/*`;
    const cut = describe({ "@p/*": [long("a")] }, { "@p/*": [long("b")] });
    expect(cut).toHaveLength(2);
    expect(cut[0].replace("no longer stands for", "")).not.toBe(cut[1].replace("now also stands for", "").replace(", so imports by that name may no longer be seen there", ""));
    expect(cut[0]).toMatch(/\(#[\da-f]{8}\)/);
    // Two names whose short hashes collide, with their paths swapped: they are shown whole, so the change reads as one.
    const [c1, c2] = ["10wl8", "1xqd6"].map((end) => `@company/${"x".repeat(80)}/${end}/*`);
    const collided = describe({ [c1]: ["src/ui/*"], [c2]: ["src/data/*"] }, { [c1]: ["src/data/*"], [c2]: ["src/ui/*"] });
    expect(collided).toHaveLength(4);
    expect(collided[0]).toContain(c1);
    expect(collided[1]).toContain(c2);
    expect(new Set(collided.map(nameOf)).size).toBe(2);
    // Others in the same description are still cut.
    const mixed = describe({ [c1]: ["src/ui/*"], [c2]: ["src/data/*"], [n1]: ["src/one/*"] }, { [c1]: ["src/data/*"], [c2]: ["src/ui/*"] });
    expect(mixed.find((l) => l.startsWith("Removes"))).toMatch(/\(#[\da-f]{8}\)/);
  });

  it("are only written by init as the architecture can hold them, so that check works right after", () => {
    const code: FileMap = { "src/env/a.ts": "", "src/b.ts": "", "index.ts": "" };
    for (const paths of [
      { "~": ["./"], "~/*": ["./*"] },
      { "@many/*": Array.from({ length: 21 }, (_, i) => `./src/m${i}/*`) },
      { "@env": ["src/env/*"], "/abs/*": ["src/*"] },
    ]) {
      const graph = buildGraphFromFiles({ ...code, "tsconfig.json": json({ compilerOptions: { baseUrl: ".", paths } }) });
      const { architecture, notes } = inferArchitecture(graph);
      expect(validateArchitecture(architecture), json(paths)).toEqual({ ok: true, errors: [] });
      if (paths["~"] || paths["@env"]) expect(notes.some((n) => n.startsWith('Not written to "aliases"')), json(paths)).toBe(true);
    }
    const many = inferArchitecture(buildGraphFromFiles({ ...code, "tsconfig.json": json({ compilerOptions: { paths: { "@many/*": Array.from({ length: 50 }, (_, i) => `./src/m${i}/*`) } } }) })).architecture;
    expect(many.aliases?.["@many/*"]).toHaveLength(50);
    expect(inferArchitecture(buildGraphFromFiles({ ...code, "tsconfig.json": json({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["./*"] } } }) })).architecture.aliases).toEqual({ "*": ["*"], "~/*": ["*"] });
  });

  it("are shown to agents", () => {
    const a = arch({ ui: "src/ui/**" }, { aliases: { "@app/*": ["src/app/*"] } });
    expect(getArchitectureSummary({ arch: a, files: {}, baseline: [] }).aliases).toEqual({ "@app/*": ["src/app/*"] });
  });
});

describe("config files", () => {
  it("are read along with the code, but are not code", () => {
    for (const p of ["package.json", "a/package.json", "tsconfig.json", "tsconfig.app.json", "web/jsconfig.json", "pnpm-workspace.yaml", "lerna.json"]) expect(isConfigPath(p), p).toBe(true);
    for (const p of ["node_modules/x/package.json", "a/.git/package.json", "package-lock.json", "config.json", "src/tsconfig.ts"]) expect(isConfigPath(p), p).toBe(false);
    expect(isSourcePath("package.json")).toBe(false);
    const graph = buildGraphFromFiles({ ...NPM, "tsconfig.json": "{}".padEnd(5000, " ") });
    expect(graph.files.some((f) => f.endsWith(".json"))).toBe(false);
    expect(Object.keys(graph.lines).some((f) => f.endsWith(".json"))).toBe(false);
  });

  it("make the check incomplete when one above some code cannot be read, unless it is ignored", () => {
    const files: FileMap = { "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["src/*"] } }`, "src/a.ts": "import '@/b';", "src/b.ts": "", "tests/fixtures/broken/tsconfig.json": "{" };
    const graph = buildGraphFromFiles(files);
    expect(graph.unparsed).toEqual([{ file: "tsconfig.json", reason: "is not valid JSON" }]);
    expect(unparsedFiles(graph)).toHaveLength(1);
    expect(unparsedFiles(graph, ["tsconfig.json"])).toEqual([]);
    // Missing: in the tree, but not read.
    expect(buildGraphFromFiles({ "src/a.ts": "" }, { paths: ["src/a.ts", "tsconfig.json", "docs/package.json"] }).unparsed).toEqual([{ file: "tsconfig.json", reason: "could not be read" }]);
    // Extending what is in the tree but not read, or itself. What is not in the tree at all is generated, and ignored.
    const extending = { "src/a.ts": "", "tsconfig.json": json({ extends: "./tsconfig.base.json" }) };
    const extended = buildGraphFromFiles(extending, { paths: [...Object.keys(extending), "tsconfig.base.json"] }).unparsed;
    expect(extended).toEqual([{ file: "tsconfig.base.json", reason: "could not be read" }, { file: "tsconfig.json", reason: "extends a file that cannot be read" }]);
    expect(buildGraphFromFiles(extending, { paths: Object.keys(extending) }).unparsed).toEqual([]);
    const loop = buildGraphFromFiles({ "src/a.ts": "", "tsconfig.json": json({ extends: "./tsconfig.b.json" }), "tsconfig.b.json": json({ extends: "./tsconfig.json" }) }).unparsed;
    expect(loop.map((u) => u.file)).toEqual(["tsconfig.b.json", "tsconfig.json"]);
    // At setup, they are not proposed as ignored, which would drop what they say.
    expect(inferArchitecture(graph).architecture.ignore ?? []).not.toContain("tsconfig.json");
  });

  it("make a planned change not ok when it breaks one", () => {
    const files: FileMap = { "tsconfig.json": json({}), "src/ui/a.ts": "", "src/data/b.ts": "" };
    const ctx = { arch: arch({ ui: "src/ui/**", data: "src/data/**" }), files, baseline: [] };
    expect(checkChange(ctx, [{ path: "src/data/b.ts", content: "export {};" }]).ok).toBe(true);
    expect(checkChange(ctx, [{ path: "tsconfig.json", content: "{ nope" }])).toMatchObject({ ok: false, unparsed: [{ file: "tsconfig.json", reason: "is not valid JSON" }] });
  });

  it("stay cheap and refuse what is too large, has too many paths, or tries to change Object.prototype", () => {
    const big = json({ name: "x", padding: "a".repeat(4_000_000) });
    expect(buildGraphFromFiles({ "package.json": big, "src/a.ts": "" }).unparsed).toEqual([{ file: "package.json", reason: "is too large to be read" }]);
    const patterns = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`@p${i}/*`, [`src/p${i}/*`]]));
    expect(buildGraphFromFiles({ "tsconfig.json": json({ compilerOptions: { paths: patterns } }), "src/a.ts": "" }).unparsed).toEqual([{ file: "tsconfig.json", reason: "has too many paths" }]);
    // Many config files with many patterns each, and many imports that try them: the whole project has a limit.
    const many: FileMap = {};
    for (let i = 0; i < 8; i++) many[`tsconfig.${i}.json`] = json({ compilerOptions: { paths: Object.fromEntries(Array.from({ length: 900 }, (_, j) => [`@q${i}x${j}/*`, [`src/*`]])) } });
    for (let i = 0; i < 400; i++) many[`src/f${i}.ts`] = Array.from({ length: 20 }, (_, j) => `import '@q7x${j}/f${(i + 1) % 400}';`).join("\n");
    const graph = buildGraphFromFiles(many);
    expect(graph.unparsed.map((u) => u.reason)).toContain("has too many paths");
    // As many patterns as are allowed, in folders above many imports, cost about the length of each name.
    const allowed: FileMap = {};
    for (const dir of ["", "a/", "a/b/", "a/b/c/"]) allowed[`${dir}tsconfig.json`] = json({ compilerOptions: { paths: Object.fromEntries(Array.from({ length: 1000 }, (_, j) => [`@r${dir.length}x${j}/*`, [`./${"a/b/c/".slice(dir.length)}*`]])) } });
    for (let i = 0; i < 200; i++) allowed[`a/b/c/f${i}.ts`] = Array.from({ length: 100 }, (_, j) => `import '@r0x${j * 7}/f${(i + j) % 200}'; import 'p${j}';`).join("\n");
    const start = process.cpuUsage();
    const wide = buildGraphFromFiles(allowed);
    const { user, system } = process.cpuUsage(start);
    expect(wide.unparsed).toEqual([]);
    expect(wide.edges.filter((e) => e.to).length).toBe(19_800); // each file imports itself once, which is no edge
    expect((user + system) / 1000).toBeLessThan(15_000);
    const crowded: FileMap = { "src/a.ts": "" };
    for (let i = 0; i < 25; i++) crowded[`tsconfig.${String(i).padStart(2, "0")}.json`] = "{}";
    expect(buildGraphFromFiles(crowded).unparsed.map((u) => u.reason)).toEqual(Array(5).fill("is one of too many tsconfig files in its folder"));

    const hostile: FileMap = {
      "tsconfig.json": `{ "compilerOptions": { "paths": { "__proto__": ["src/evil/*"], "@a/*": ["src/a/*"], "constructor": ["src/c.ts"] } } }`,
      "package.json": `{ "name": "__proto__", "__proto__": { "polluted": 1 }, "imports": { "__proto__": "./src/evil/x.ts", "#a": "./src/a/x.ts" }, "dependencies": { "__proto__": "npm:pg@1" }, "exports": { "__proto__": "./x" } }`,
      "src/a/x.ts": "", "src/c.ts": "", "src/evil/x.ts": "",
      "src/b.ts": "import '@a/x'; import '#a'; import 'constructor'; import 'toString'; import 'hasOwnProperty';",
    };
    expect(targets(hostile, "src/b.ts")).toEqual(["pkg #a", "pkg @a/x", "pkg constructor", "pkg hasOwnProperty", "pkg toString", "src/a/x.ts", "src/c.ts"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(readJsonc(`{"__proto__": {"x": 1}}`)).toEqual(JSON.parse(`{"__proto__": {"x": 1}}`));
  });

  it("keep a string that looks like a comment, and refuse a comment that does not end", () => {
    expect(readJsonc(`{ "a": "// not a comment", "b": "/* nor this */", "c": [1, 2, ], } // end`)).toEqual({ a: "// not a comment", b: "/* nor this */", c: [1, 2] });
    expect(() => readJsonc(`{ "a": 1 /* `)).toThrow("ends inside a comment");
    expect(() => readJsonc(`{ "a": 1 `)).toThrow("is not valid JSON");
  });
});

describe("unresolved imports", () => {
  it("are counted, but not assets, packages or what resolves", () => {
    const files: FileMap = {
      "tsconfig.json": json({ compilerOptions: { paths: { "@app/*": ["./src/app/*"] } } }),
      "src/app/x.ts": "",
      "src/ui/a.ts": "import './missing'; import '@/nothing'; import '@app/none'; import '@app/x'; import './style.css'; import 'react'; import '../app/x'; import './data';",
    };
    const graph = buildGraphFromFiles(files, { paths: [...Object.keys(files), "src/ui/data.json"] });
    expect(graph.unresolved).toBe(3);
    expect(checkArchitecture(arch({ ui: "src/ui/**" }), graph).stats.unresolved).toBe(3);
  });
});

describe("a change to config", () => {
  /** A workspace whose app maps its own names in its own tsconfig, which is not the root one. */
  const BASE: FileMap = {
    "package.json": json({ workspaces: ["apps/*"] }),
    "apps/web/package.json": json({ name: "web" }),
    "apps/web/tsconfig.json": json({ compilerOptions: { baseUrl: ".", paths: { "@web/*": ["src/*"] } } }),
    "apps/web/src/data/db.ts": "",
    "apps/web/src/ui/page.ts": "import { db } from '@web/data/db';",
  };
  const DENY = rule({ id: "DENY01", type: "deny_dependency", from: "ui", to: "data" });
  const aliases = inferArchitecture(buildGraphFromFiles(BASE)).architecture.aliases;
  const a = arch({ ui: "apps/web/src/ui/**", data: "apps/web/src/data/**" }, { rules: [DENY], aliases });
  const expected = ["DENY01:apps/web/src/ui/page.ts->apps/web/src/data/db.ts"];

  it("cannot take away what a tsconfig that is not the root one maps, by editing, emptying or removing it", () => {
    expect(aliases).not.toHaveProperty("@web/*"); // only the root config is written into the architecture
    expect(ids(a, BASE, { aliases })).toEqual(expected);
    const remapped = {
      ...BASE,
      "apps/web/tsconfig.json": json({ compilerOptions: { baseUrl: ".", paths: { "@web/data/*": ["src/ui/stub/*"], "@web/*": ["src/*"] } } }),
      "apps/web/src/ui/stub/db.ts": "",
    };
    const emptied = { ...BASE, "apps/web/tsconfig.json": json({ compilerOptions: {} }) };
    const { "apps/web/tsconfig.json": _, ...removed } = BASE;
    for (const head of [remapped, emptied, removed]) {
      expect(ids(a, head, { aliases })).toEqual([]); // what the head alone says
      expect(ids(a, head, { aliases, configBefore: BASE })).toEqual(expected);
    }
    expect(targets(remapped, "apps/web/src/ui/page.ts", { configBefore: BASE })).toEqual(["apps/web/src/data/db.ts", "apps/web/src/ui/stub/db.ts", "pkg @web/data"]);
  });

  it("cannot take away a workspace package, an import or the main of a folder that was there before", () => {
    const base: FileMap = {
      "package.json": json({ name: "root", workspaces: ["packages/*"], imports: { "#db": "./packages/data/src/db.ts" } }),
      "packages/data/package.json": json({ name: "@acme/data", main: "src/db.ts" }),
      "packages/data/src/db.ts": "",
      "packages/data/lib/package.json": json({ main: "../src/db.ts" }),
      "packages/ui/package.json": json({ name: "@acme/ui" }),
      "packages/ui/src/page.ts": "import '@acme/data'; import '#db'; import '../../data/lib';",
    };
    const head = { ...base, "package.json": json({ name: "root" }), "packages/data/lib/package.json": json({ main: "../../ui/src/page.ts" }) };
    // Here data is above ui, so that ui may not import it.
    const a2 = arch({ data: "packages/data/**", ui: "packages/ui/**" });
    expect(ids(a2, base)).toEqual(["LAYER01:packages/ui/src/page.ts->packages/data/src/db.ts"]);
    expect(ids(a2, head)).toEqual([]);
    expect(ids(a2, head, { configBefore: base })).toEqual(["LAYER01:packages/ui/src/page.ts->packages/data/src/db.ts"]);
    // Each of the three alone keeps the edge.
    for (const only of [{ "package.json": base["package.json"] }, { "packages/data/lib/package.json": base["packages/data/lib/package.json"] }]) {
      const half = { ...head, ...only };
      expect(ids(a2, half).length + ids(a2, half, { configBefore: base }).length).toBeGreaterThan(0);
    }
  });

  it("is judged with the config before it, which only adds, and whose own problems are not the change's", () => {
    const broken = { ...BASE, "apps/web/tsconfig.json": "{", "tsconfig.json": "{" };
    const graph = buildGraphFromFiles(BASE, { configBefore: broken });
    expect(graph.unparsed).toEqual([]);
    expect(graph.edges.filter((e) => e.to).map((e) => e.to)).toEqual(["apps/web/src/data/db.ts"]);
    // Source files of the earlier commit are not used: only what its config says, about the files at hand.
    const withCode = { ...BASE, "apps/web/src/ui/old.ts": "import '@web/data/db';" };
    expect(buildGraphFromFiles(BASE, { configBefore: withCode }).files).not.toContain("apps/web/src/ui/old.ts");
  });

  it("is checked the same way by check_change, which takes the files at hand as before", () => {
    const ctx = { arch: a, files: BASE, baseline: [] };
    const res = checkChange(ctx, [{ path: "apps/web/tsconfig.json", content: json({ compilerOptions: { baseUrl: ".", paths: { "@web/data/*": ["src/ui/stub/*"], "@web/*": ["src/*"] } } }) }, { path: "apps/web/src/ui/stub/db.ts", content: "" }]);
    // The import was there before, so it is no new violation, but it is not gone either: a new import of it is one.
    expect(res.ok).toBe(true);
    const more = checkChange(ctx, [
      { path: "apps/web/tsconfig.json", content: json({ compilerOptions: {} }) },
      { path: "apps/web/src/ui/other.ts", content: "import '@web/data/db';" },
    ]);
    expect(more.introduced.map((v) => v.rule)).toEqual(["DENY01"]);
  });
});

describe("exports and imports", () => {
  it("follow every target of a fallback array, and conditions nested deeply, but a gap past the limit", () => {
    const nest = (depth: number, leaf: string): unknown => (depth ? { default: nest(depth - 1, leaf) } : leaf);
    const files: FileMap = {
      "package.json": json({ name: "n1", imports: { "#f": ["./src/ui/missing.ts", "./src/ui/x.ts"], "#s": nest(12, "./src/ui/secret.ts"), "#c": nest(12, "child_process") } }),
      "src/ui/x.ts": "", "src/ui/secret.ts": "",
      "src/data/a.ts": "import '#f'; import '#s'; import c from '#c';",
    };
    expect(targets(files, "src/data/a.ts")).toEqual(["pkg #c", "pkg #f", "pkg #s", "pkg child_process", "src/ui/secret.ts", "src/ui/x.ts"]);
    const a = arch({ ui: "src/ui/**", data: "src/data/**" }, { rules: [rule({ id: "LAYER01", type: "layers" }), rule({ id: "EXT", type: "deny_external", module: "data", packages: ["child_process"] })] });
    expect(ids(a, files)).toEqual(["EXT:src/data/a.ts->child_process", "LAYER01:src/data/a.ts->src/ui/secret.ts", "LAYER01:src/data/a.ts->src/ui/x.ts"]);
    const exported: FileMap = {
      "package.json": json({ workspaces: ["p/*"] }),
      "p/ui/package.json": json({ name: "ui", exports: { ".": ["./nothing.js", { node: { import: { default: "./src/main.ts" } } }] } }),
      "p/ui/src/main.ts": "", "p/data/src/a.ts": "import 'ui';", "p/data/package.json": json({ name: "data" }),
    };
    expect(targets(exported, "p/data/src/a.ts")).toEqual(["p/ui/src/main.ts", "pkg ui"]);
    const deep = { ...files, "package.json": json({ name: "n1", imports: { "#s": nest(40, "./src/ui/secret.ts") } }) };
    expect(buildGraphFromFiles(deep).unparsed).toEqual([{ file: "package.json", reason: "nests the conditions of exports or imports too deeply" }]);
    const deepExports = { ...exported, "p/ui/package.json": json({ name: "ui", exports: nest(40, "./src/main.ts") }) };
    expect(buildGraphFromFiles(deepExports).unparsed).toEqual([{ file: "p/ui/package.json", reason: "nests the conditions of exports or imports too deeply" }]);
  });

  it("have a limit on their entries, and matching many entries that begin alike counts as work, so a check stays affordable", () => {
    const cpu = (f: () => unknown) => {
      const start = process.threadCpuUsage();
      f();
      const { user, system } = process.threadCpuUsage(start);
      return (user + system) / 1000;
    };
    const code = (n: number, name: (i: number) => string) => Object.fromEntries(Array.from({ length: n / 100 }, (_, f) => [`src/data/f${f}.ts`, Array.from({ length: 100 }, (_, j) => `import '${name(f * 100 + j)}';`).join("\n")]));
    const exportsMap = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`./*t${i}`, `./src/*.ts`]));
    const big: FileMap = { "package.json": json({ workspaces: ["pk/*"] }), "pk/u/package.json": json({ name: "u", exports: exportsMap(1001) }), "pk/u/src/q.ts": "", ...code(2000, (i) => `u/q${i}`) };
    let graph = buildGraphFromFiles(big);
    expect(graph.unparsed).toEqual([{ file: "pk/u/package.json", reason: "has too many entries in exports or imports" }]);
    const imports: FileMap = { "package.json": json({ name: "r", imports: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`#*t${i}`, "./src/x.ts"])) }), "src/x.ts": "", ...code(100, (i) => `#q${i}`) };
    expect(buildGraphFromFiles(imports).unparsed).toEqual([{ file: "package.json", reason: "has too many entries in exports or imports" }]);
    // As many entries as are allowed, all beginning alike, and many imports that match none of them: bounded, then a gap.
    const allowed: FileMap = { ...big, "pk/u/package.json": json({ name: "u", exports: exportsMap(1000) }), ...code(20_000, (i) => `u/q${i}`) };
    const ms = cpu(() => (graph = buildGraphFromFiles(allowed, { paths: Object.keys(allowed) })));
    expect(graph.unparsed).toEqual([{ file: "pk/u/package.json", reason: "takes too many lookups to resolve the imports below it" }]);
    expect(ms).toBeLessThan(10_000);
    // Real ones cost nothing more, however many imports use them.
    const real: FileMap = { ...big, "pk/u/package.json": json({ name: "u", exports: { ".": "./src/q.ts", "./*": "./src/*.ts", "./a/*": "./src/*.ts" } }) };
    expect(buildGraphFromFiles(real).unparsed).toEqual([]);
  });
});

describe("pnpm-workspace.yaml", () => {
  const files = (yaml: string): FileMap => ({
    "pnpm-workspace.yaml": yaml,
    "libs/core/package.json": json({ name: "core-lib", main: "src/index.ts" }),
    "libs/core/src/index.ts": "",
    "apps/web/src/a.ts": "import 'core-lib';",
  });

  it("is read in each way YAML writes a list, with or without indentation, quotes, comments or a document marker", () => {
    for (const yaml of [
      "packages:\n  - 'libs/*'\n  - apps/*\n",
      "packages:\n- 'libs/*'\n- apps/*\n",
      "packages: [\n  'libs/*',\n  'apps/*'\n]\n",
      "packages: ['libs/*', \"apps/*\"]  # inline\n",
      '"packages":\n  - libs/*\n',
      "---\r\n# workspace\r\npackages:\r\n\r\n  - libs/*   # libraries\r\n\r\ncatalog:\r\n  react: ^18\r\n",
      "packages:\n  - 'libs/*'\n  - '!libs/skip'\n",
      "packages: ['libs/*', '!libs/skip']\n",
    ]) {
      expect(targets(files(yaml), "apps/web/src/a.ts"), yaml).toEqual(["libs/core/src/index.ts", "pkg core-lib"]);
    }
    expect(targets(files("onlyBuiltDependencies:\n  - esbuild\n"), "apps/web/src/a.ts")).toEqual(["pkg core-lib"]);
  });

  it("is a gap when its packages are written in a way that is not read, rather than no packages", () => {
    for (const yaml of ["packages: libs/*\n", "packages: &list\n  - libs/*\n", "packages:\n  - *list\n", "packages:\n  libs: x\n", "packages: [ 'libs/*'\n", "packages:\n  - [libs/*]\n", "packages: [libs/*] x\n", "packages: [[libs/*]]\n", "packages:\n  - # c\n"]) {
      expect(buildGraphFromFiles(files(yaml)).unparsed, yaml).toEqual([{ file: "pnpm-workspace.yaml", reason: "has a packages list that cannot be read" }]);
    }
  });

  it("is a gap where YAML reads quotes, brackets, indents or white space differently from a simple reading, rather than hiding what follows", () => {
    for (const yaml of [
      // A quote inside a plain value is text to YAML; read as a string it swallowed the lines up to the next quote.
      "foo: [it's]\noverrides:\n  x: npm:pg@8\nbaz: [it's]\npackages:\n  - libs/*\n",
      "foo: {a: it's}\noverrides:\n  x: npm:pg@8\nbaz: {b: it's}\npackages:\n  - libs/*\n",
      'foo: [a"b]\noverrides:\n  x: npm:pg@8\nbaz: [c"d]\npackages:\n  - libs/*\n',
      "packages: [libs/*, it's]\ncatalog:\n  x: npm:pg@8\nfoo: [x']\n",
      // Line breaks and white space that YAML readers disagree on.
      "foo: [x]\roverrides:\n  x: npm:pg@8\npackages:\n  - libs/*\n",
      "foo: [a\u00a0#x, b]\npackages:\n  - libs/*\n",
      "packages:\n  - libs/*\u2028overrides:\n  x: npm:pg@8\n",
      // Quotes that YAML reads on over lines, doubled quotes and text after a closing quote.
      "packages:\n  - 'libs/*\n  - apps/*'\n",
      "packages:\n  - 'it''s'\n",
      "packages:\n  - 'libs/*' x\n",
      // Brackets that do not match, flow content at the left edge, and plain values that go on over lines.
      "foo: [ a }\npackages:\n  - libs/*\nbar: ]\n",
      "foo: [ #c\npackages:\n  - libs/*\n]\n",
      "overrides: { x: npm:pg@8\n  y }\npackages:\n  - libs/*\n",
      // Indents: a list or map whose entries are not lined up, a nested list, a read key indented under another one.
      "packages:\n- apps/*\n  - libs/*\n",
      "packages:\n  - libs/*\noverrides:\n x: a\n  y: npm:pg@8\n",
      "packages:\n  - - libs/*\n",
      "foo:\n  - a\n  packages:\n  - libs/*\n",
      // A list where a map is expected, and values that YAML reads as something other than text.
      "packages:\n  - libs/*\noverrides:\n- x\n",
      "packages:\n  - libs/*\noverrides:\n  x: a: b\n",
      "packages:\n  - libs/*\noverrides:\n  x: ? y\n",
    ]) {
      expect(buildGraphFromFiles(files(yaml)).unparsed.map((u) => u.file), JSON.stringify(yaml)).toEqual(["pnpm-workspace.yaml"]);
    }
  });

  it("reads honest files with quotes, flow lists and maps over several lines, and catalogs", () => {
    for (const yaml of [
      "packages: [\n  'libs/*',\n  \"apps/*\"\n]\noverrides: {\n  a: b,\n  c: 'd'\n}\n",
      "packages:\n  - 'libs/*'\ncatalog:\n  react: ^18.2.0\n  'react-dom': \"^18.2.0\"\ncatalogs:\n  r17:\n    react: ^17\n  r18: { react: ^18, react-dom: ^18 }\n",
      "packages: ['libs/*', 'apps/*']\noverrides:\n  '@scope/x': npm:@scope/y@1\npublicHoistPattern: ['*eslint*', \"*prettier*\"]\n",
    ]) {
      expect(targets(files(yaml), "apps/web/src/a.ts"), yaml).toEqual(["libs/core/src/index.ts", "pkg core-lib"]);
    }
  });

  it("may start with a byte order mark, and is a gap when it is too large or has a line too long, rather than cut short", () => {
    expect(targets(files("\uFEFFpackages:\n  - libs/*\n"), "apps/web/src/a.ts")).toEqual(["libs/core/src/index.ts", "pkg core-lib"]);
    expect(buildGraphFromFiles(files(`packages:\n  - libs/*\n${"# padding\n".repeat(110_000)}`)).unparsed).toEqual([{ file: "pnpm-workspace.yaml", reason: "is too large to be read" }]);
    expect(buildGraphFromFiles(files(`packages:\n  - libs/*\nx: '${"a".repeat(20_000)}'\n`)).unparsed).toEqual([{ file: "pnpm-workspace.yaml", reason: "has a line too long to be read" }]);
  });

  it("is read in time proportional to its size, whatever its lines hold", () => {
    const cpu = (yaml: string) => {
      const start = process.threadCpuUsage();
      const graph = buildGraphFromFiles(files(yaml));
      const { user, system } = process.threadCpuUsage(start);
      return [graph.unparsed.map((u) => u.reason), (user + system) / 1000] as const;
    };
    const line = " ".repeat(16_000);
    // Each of these took seconds to minutes with regular expressions that go back and forth over a line.
    for (const yaml of [
      `a${line}b\n`.repeat(60), `packages:\n- 'x'${line}y\n`.repeat(1), `packages:\n  - libs/*\noverrides:\n  a${line}b\n`, `packages: [${"a\n".repeat(400_000)}]\n`,
      `a${line.slice(1)}:\n`.repeat(60), `packages:\n  - libs/*\ncatalog: {${`a: b,${line.slice(0, 15_000)}\n`.repeat(60)}}\n`, `"packages${line}`.repeat(60),
    ]) {
      const [, ms] = cpu(yaml);
      expect(ms, yaml.slice(0, 30)).toBeLessThan(2000);
    }
    expect(cpu(`a${" ".repeat(80_000)}b\n`)).toEqual([["has a line too long to be read"], expect.any(Number)]);
  });
});

describe("deny_external", () => {
  const a = arch({ ui: "src/ui/**", data: "src/data/**" }, { rules: [rule({ id: "EXT", type: "deny_external", module: "data", packages: ["pg", "@scope/real"] })] });

  it("cannot be dodged with npm: aliases in overrides, resolutions or pnpm overrides, or with a tarball or git dependency", () => {
    const code = { "src/data/a.ts": "import 'x';", "src/data/b.ts": "import '@my/y';" };
    for (const pkg of [
      { dependencies: { x: "^1.0.0" }, overrides: { x: "npm:pg@8" } },
      { dependencies: { x: "^1.0.0" }, overrides: { "x@^1": "npm:pg@8" } },
      { dependencies: { a: "^1.0.0" }, overrides: { a: { x: "npm:pg@8" } } },
      { dependencies: { x: "^1.0.0" }, overrides: { x: { ".": "npm:pg@8" } } },
      { dependencies: { x: "^1.0.0" }, resolutions: { "**/x": "npm:pg@8" } },
      { dependencies: { x: "^1.0.0" }, resolutions: { "a/x": "npm:pg@^8" } },
      { dependencies: { x: "^1.0.0" }, pnpm: { overrides: { "a>x": "npm:pg@8" } } },
      { dependencies: { x: "https://registry.npmjs.org/pg/-/pg-8.11.0.tgz" } },
      { dependencies: { x: "https://example.com/files/pg-8.11.0.tgz" } },
      { dependencies: { x: "git+https://github.com/someone/pg.git#v8" } },
      { dependencies: { x: "github:someone/pg" } },
      { devDependencies: { x: "file:../vendor/pg-8.11.0.tgz" } },
    ]) {
      expect(ids(a, { ...code, "package.json": json(pkg) }), json(pkg)).toEqual(["EXT:src/data/a.ts->pg"]);
    }
    const scoped = { ...code, "package.json": json({ overrides: { "@my/y": "npm:@scope/real@1" } }) };
    expect(ids(a, scoped)).toEqual(["EXT:src/data/b.ts->@scope/real"]);
    const yaml = { ...code, "package.json": json({ name: "r" }), "pnpm-workspace.yaml": "packages:\n  - 'p/*'\noverrides:\n  \"x@1\": npm:pg@8\ncatalog:\n  '@my/y': 'npm:@scope/real@1'\n" };
    expect(ids(a, yaml)).toEqual(["EXT:src/data/a.ts->pg", "EXT:src/data/b.ts->@scope/real"]);
    // An honest version or range is no alias, and a package's own name stays.
    expect(ids(a, { ...code, "package.json": json({ dependencies: { x: "^1.0.0", "@my/y": "1.x" }, overrides: { x: "1.2.3", z: "$x" } }) })).toEqual([]);
    // The same in a flow map, and what a Yarn patch: wraps.
    for (const yamlText of ["overrides: { x: 'npm:pg@8' }\n", "overrides: {\n  \"x\": npm:pg@8,  # pg\n  z: 1 }\n", "catalog: {x: \"npm:pg@8\"}\n"]) {
      expect(ids(a, { ...code, "package.json": json({ dependencies: { x: "1" } }), "pnpm-workspace.yaml": yamlText }), yamlText).toEqual(["EXT:src/data/a.ts->pg"]);
    }
    for (const x of ["patch:pg@npm%3A8.11.0#./p.patch", "patch:x@npm%3Apg%408#./p.patch", "patch:pg@npm:8.11.0#~/.yarn/patches/pg.patch::version=8.11.0&hash=1"]) {
      expect(ids(a, { ...code, "package.json": json({ dependencies: { x } }) }), x).toEqual(["EXT:src/data/a.ts->pg"]);
      expect(ids(a, { ...code, "package.json": json({ resolutions: { x } }) }), x).toEqual(["EXT:src/data/a.ts->pg"]);
    }
    // A patch of the package itself, or a plain version after npm:, is no other package.
    expect(targets({ ...code, "package.json": json({ dependencies: { x: "patch:x@npm%3A1.0.0#./p.patch", "@my/y": "npm:1.2.3" } }) }, "src/data/a.ts")).toEqual(["pkg x"]);
    expect(targets({ ...code, "package.json": json({ dependencies: { x: "patch:x@npm%3A1.0.0#./p.patch", "@my/y": "npm:1.2.3" } }) }, "src/data/b.ts")).toEqual(["pkg @my/y"]);
    // What cannot be read there is a gap, not nothing.
    for (const yamlText of ["overrides: *anchor\n", "overrides:\n  x:\n    y: npm:pg@8\n", "overrides: { x: [a] }\n", "overrides: { x: 'npm:pg@8'\n", "catalog:\n  x: &a npm:pg@8\n", "overrides: null\n"]) {
      expect(buildGraphFromFiles({ ...code, "pnpm-workspace.yaml": yamlText }).unparsed, yamlText).toEqual([{ file: "pnpm-workspace.yaml", reason: "has overrides or a catalog that cannot be read" }]);
    }
    // Named catalogs are read like the default one, and an entry of one does not hide the same name in another.
    for (const yamlText of [
      "catalogs:\n  evil:\n    x: npm:pg@8\n", "catalogs:\n  react18:\n    react: ^18\n  evil: { x: 'npm:pg@8' }\n", "catalogs:\n    evil:\n        'x': \"npm:pg@8\"   # c\n",
      "catalog:\n  x: npm:pg@8\noverrides:\n  x: 1.0.0\n", "overrides:\n  x: npm:pg@8\ncatalogs:\n  a:\n    x: ^1\n",
    ]) {
      expect(ids(a, { ...code, "package.json": json({ dependencies: { x: "catalog:evil" } }), "pnpm-workspace.yaml": yamlText }), yamlText).toEqual(["EXT:src/data/a.ts->pg"]);
    }
    for (const yamlText of ["catalogs: { evil: { x: 'npm:pg@8' } }\n", "catalogs:\n  evil: *a\n", "catalogs:\n  evil:\n    <<: *a\n", "catalogs:\n  evil:\n    x:\n      y: npm:pg@8\n", "catalogs:\n    x: npm:pg@8\n  y: 1\n"]) {
      expect(buildGraphFromFiles({ ...code, "pnpm-workspace.yaml": yamlText }).unparsed, yamlText).toEqual([{ file: "pnpm-workspace.yaml", reason: "has overrides or a catalog that cannot be read" }]);
    }
    const deep = { ...code, "package.json": json({ overrides: JSON.parse(`${'{"a":'.repeat(40)}"npm:pg@8"${"}".repeat(40)}`) }) };
    expect(buildGraphFromFiles(deep).unparsed).toEqual([{ file: "package.json", reason: "nests overrides too deeply" }]);
  });

  it("cannot be dodged with a pnpm-workspace.yaml written in another form of YAML: each that is not read is a gap", () => {
    const code = { "package.json": json({ dependencies: { x: "1" } }), "src/data/a.ts": "import 'x';" };
    // YAML (and pnpm with it) reads each of these as overrides of x with pg, and each as packages.
    for (const yamlText of [
      "{overrides: {x: 'npm:pg@8'}}\n", '{"packages": ["pk/*"], "overrides": {"x": "npm:pg@8"}}\n', "--- {overrides: {x: 'npm:pg@8'}}\n", "? overrides\n: x: npm:pg@8\n",
      "!!str overrides:\n  x: npm:pg@8\n", "&a overrides:\n  x: npm:pg@8\n", "  overrides:\n    x: npm:pg@8\n", "# c\n\n  overrides:\n    x: npm:pg@8\n", "[a]\n", "- a\n",
      "packages:\n  - pk/*\n---\noverrides:\n  x: npm:pg@8\n", "*a\n", "%YAML 1.2\n---\noverrides:\n  x: npm:pg@8\n", '"over\\x72ides":\n  x: npm:pg@8\n', "<<: {overrides: {x: npm:pg@8}}\n",
      "foo: [\noverrides: {x: npm:pg@8}\n", "foo: 1\nbar\n",
    ]) {
      expect(ids(a, { ...code, "pnpm-workspace.yaml": yamlText }), yamlText).toEqual([]);
      expect(buildGraphFromFiles({ ...code, "pnpm-workspace.yaml": yamlText }).unparsed, yamlText).toEqual([{ file: "pnpm-workspace.yaml", reason: "is written in a form of YAML that cannot be read" }]);
    }
    for (const yamlText of ["overrides:\n  x: 1\noverrides:\n  x: npm:pg@8\n", "overrides:\n  x: npm:pg@8\n'overrides': {}\n"]) {
      expect(buildGraphFromFiles({ ...code, "pnpm-workspace.yaml": yamlText }).unparsed, yamlText).toEqual([{ file: "pnpm-workspace.yaml", reason: "has the same key twice" }]);
    }
    // A key or value YAML reads as something other than is written there is a gap too.
    for (const yamlText of ["overrides:\n  !!str x: npm:pg@8\n", "overrides:\n  &k x: npm:pg@8\n", 'overrides:\n  "\\x78": npm:pg@8\n', 'overrides:\n  x: "npm:p\\x67@8"\n', "overrides: {!!str x: npm:pg@8}\n", "overrides:\n  ? x\n  : npm:pg@8\n"]) {
      expect(buildGraphFromFiles({ ...code, "pnpm-workspace.yaml": yamlText }).unparsed, yamlText).toEqual([{ file: "pnpm-workspace.yaml", reason: "has overrides or a catalog that cannot be read" }]);
    }
    expect(buildGraphFromFiles({ ...code, "pnpm-workspace.yaml": 'packages: ["p\\x6bs/*"]\n' }).unparsed).toEqual([{ file: "pnpm-workspace.yaml", reason: "has a packages list that cannot be read" }]);
    // What honest files have is read as before: comments, a document marker, a quoted key with JSON's colon, other keys of any form below them.
    for (const yamlText of [
      "---\n# w\npackages:\n- pk/*\noverrides:\n  x: npm:pg@8\n...\n", '"overrides":{"x": "npm:pg@8"}\n', "onlyBuiltDependencies:\n  - esbuild\npatchedDependencies:\n  a@1: patches/a.patch\noverrides:\n  x: npm:pg@8\n",
      "foo: |\n  overrides:\n    x: 1\noverrides:\n  x: npm:pg@8\n", "foo: [\n  1,\n  {a: [2]}\n]\noverrides: { x: npm:pg@8 }\n", "'packages':\n  - pk/*\n\"overrides\":\n  x: npm:pg@8\n",
    ]) {
      const graph = buildGraphFromFiles({ ...code, "pnpm-workspace.yaml": yamlText });
      expect(graph.unparsed, yamlText).toEqual([]);
      expect(ids(a, { ...code, "pnpm-workspace.yaml": yamlText }), yamlText).toEqual(["EXT:src/data/a.ts->pg"]);
    }
  });

  it("sees the workspace packages of a pnpm-workspace.yaml that is a flow map, or makes it a gap", () => {
    const files = (yamlText: string): FileMap => ({ "pnpm-workspace.yaml": yamlText, "pk/ui/package.json": json({ name: "@acme/ui", main: "index.ts" }), "pk/ui/index.ts": "", "src/data/a.ts": "import '@acme/ui';" });
    expect(targets(files("packages: [pk/*]\n"), "src/data/a.ts")).toEqual(["pk/ui/index.ts", "pkg @acme/ui"]);
    expect(buildGraphFromFiles(files("{packages: [pk/*]}\n")).unparsed).toEqual([{ file: "pnpm-workspace.yaml", reason: "is written in a form of YAML that cannot be read" }]);
  });
});

describe("tsconfig extends", () => {
  it("of a file in node_modules is a package, which is ignored, as gts sets it up", () => {
    const files: FileMap = { "tsconfig.json": json({ extends: "./node_modules/gts/tsconfig-google.json", compilerOptions: { baseUrl: "." } }), "src/a.ts": "import 'src/b';", "src/b.ts": "" };
    expect(targets(files, "src/a.ts")).toEqual(["pkg src", "src/b.ts"]);
    expect(buildGraphFromFiles(files, { paths: [...Object.keys(files), "node_modules/gts/tsconfig-google.json"] }).unparsed).toEqual([]);
    const nested = { ...files, "tsconfig.json": json({ extends: "../node_modules/x/base.json" }), "web/tsconfig.json": json({ extends: "../node_modules/@tsconfig/node20/tsconfig.json" }) };
    expect(buildGraphFromFiles(nested).unparsed).toEqual([]);
  });

  it("of a file that is not in the tree, as SvelteKit and Nuxt generate it, is ignored with a note, but one in the tree that is not read is a gap", () => {
    for (const ext of ["./.svelte-kit/tsconfig.json", "./.nuxt/tsconfig.json"]) {
      const files: FileMap = { "tsconfig.json": json({ extends: ext, compilerOptions: { baseUrl: "." } }), "package.json": json({ name: "app" }), "src/a.ts": "import 'src/b';", "src/b.ts": "" };
      for (const graph of [buildGraphFromFiles(files), buildGraphFromFiles(files, { paths: Object.keys(files) })]) {
        expect(graph.unparsed, ext).toEqual([]);
        expect(graph.notes).toEqual([`tsconfig.json extends ${ext.slice(2)}, which is not in the repository (generated or ignored), so what it sets is not used`]);
      }
      expect(targets(files, "src/a.ts")).toEqual(["pkg src", "src/b.ts"]);
      expect(inferArchitecture(buildGraphFromFiles(files)).notes.some((n) => n.includes(ext.slice(2)))).toBe(true);
      // In the tree, but not read: what it says could change what code imports.
      expect(buildGraphFromFiles(files, { paths: [...Object.keys(files), ext.slice(2)] }).unparsed).toEqual([{ file: "tsconfig.json", reason: "extends a file that cannot be read" }]);
    }
  });
});

describe("resolving", () => {
  const cpu = <T>(f: () => T): [T, number] => {
    const start = process.threadCpuUsage();
    const result = f();
    const used = process.threadCpuUsage(start);
    return [result, (used.user + used.system) / 1000];
  };
  /** The CPU time of ordinary code of about the same size, read at the same moment, so that a busy machine does not count. */
  const ordinary = () => {
    const files: FileMap = { "tsconfig.json": json({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }) };
    for (let i = 0; i < 200; i++) files[`src/m${i % 20}/f${i}.ts`] = Array.from({ length: 50 }, (_, j) => `import '@/m${j % 20}/f${(i + j) % 200}'; import 'p${j}';`).join("\n");
    return cpu(() => buildGraphFromFiles(files))[1];
  };

  it("stops at a limit, as a gap, however many tsconfig files apply, however many targets they have, and whatever the workspaces", () => {
    const deep: FileMap = {};
    let dir = "";
    for (let d = 0; d < 100; d++) {
      dir += `d${d}/`;
      for (let k = 0; k < 20; k++) deep[`${dir}tsconfig.${String(k).padStart(2, "0")}.json`] = json({ compilerOptions: { baseUrl: "." } });
    }
    for (let f = 0; f < 10; f++) deep[`${dir}f${f}.ts`] = Array.from({ length: 100 }, (_, j) => `import 'p${f}x${j}';`).join("\n");
    const targetsMany = (n: number, imports: number): FileMap => {
      const out: FileMap = {};
      let at = "";
      for (let d = 0; d < n; d++) {
        at += `d${d}/`;
        out[`${at}tsconfig.json`] = json({ compilerOptions: { paths: { "*": Array.from({ length: 50 }, (_, j) => `./m${j}/*`) } } });
      }
      for (let f = 0; f < imports / 100; f++) out[`${at}f${f}.ts`] = Array.from({ length: 100 }, (_, j) => `import 'p${f}x${j}';`).join("\n");
      return out;
    };
    const wide = targetsMany(40, 1000);
    const one = targetsMany(1, 20_000);
    const globs: FileMap = { "package.json": json({ workspaces: Array.from({ length: 10_000 }, (_, j) => `pk${j}/*`) }), "src/a.ts": "import 'n5';" };
    for (let p = 0; p < 1000; p++) globs[`pk${p}/x/package.json`] = json({ name: `n${p}` });
    const products: FileMap = { "package.json": json({ workspaces: Array.from({ length: 900 }, (_, j) => `pk${j}/*`) }), "src/a.ts": "" };
    for (let p = 0; p < 300; p++) products[`pk${p}/x/package.json`] = json({ name: `n${p}` });

    const base = ordinary();
    for (const [files, reason] of [
      [deep, "is one of too many tsconfig files with paths or baseUrl that apply to the same code"],
      [wide, "takes too many lookups to resolve the imports below it"],
      [one, "takes too many lookups to resolve the imports below it"],
      [globs, "has too many workspace patterns"],
      [products, "has too many workspace patterns"],
    ] as const) {
      const [graph, ms] = cpu(() => buildGraphFromFiles(files, { paths: Object.keys(files) }));
      expect(graph.unparsed.length).toBeGreaterThan(0);
      expect(graph.unparsed.map((u) => u.reason)).toContain(reason);
      // Each costs a bounded amount, not one that grows with what the config multiplies.
      expect(ms, reason).toBeLessThan(Math.max(base, 50) * 60);
    }
  });

  it("has room for tens of thousands of different alias targets in an honest repo, but stops long targets at a limit in characters", () => {
    // Each alias target is looked for through paths and through baseUrl, and both are checked for code that is not read:
    // 30,000 of them took more than the 100,000 lookups the limit once counted them against together.
    const honest: FileMap = { "tsconfig.json": json({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }) };
    for (let f = 0; f < 300; f++) honest[`packages/p${f % 50}/src/f${f}.ts`] = Array.from({ length: 100 }, (_, j) => `import '@/x${f * 100 + j}';`).join("\n");
    const graph = buildGraphFromFiles(honest, { paths: Object.keys(honest) });
    expect(graph.unparsed).toEqual([]);
    expect(graph.unresolved).toBe(30_000);
    // Targets of 2,000 characters cost far more for each lookup, so they reach the limit in characters, in bounded time.
    const long: FileMap = { "tsconfig.json": json({ compilerOptions: { baseUrl: ".", paths: { "*": Array.from({ length: 50 }, (_, j) => `./${"d".repeat(2000)}${j}/*`) } } }) };
    for (let f = 0; f < 200; f++) long[`src/f${f}.ts`] = Array.from({ length: 100 }, (_, j) => `import 'q${f}x${j}';`).join("\n");
    const base = ordinary();
    const [hostile, ms] = cpu(() => buildGraphFromFiles(long, { paths: Object.keys(long) }));
    expect(hostile.unparsed).toEqual([{ file: "tsconfig.json", reason: "takes too many lookups to resolve the imports below it" }]);
    expect(ms).toBeLessThan(Math.max(base, 50) * 60);
  });

  it("tries a name once per folder, so that many imports of it cost no more", () => {
    const files: FileMap = {};
    for (let d = 0; d < 20; d++) files[`p${d}/tsconfig.json`] = json({ compilerOptions: { baseUrl: ".", paths: Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`@x${j}/*`, Array.from({ length: 20 }, (_, k) => `./t${k}/*`)])) } });
    for (let d = 0; d < 20; d++) for (let i = 0; i < 50; i++) files[`p${d}/src/f${i}.ts`] = Array.from({ length: 100 }, (_, j) => `import '@x${j % 20}/y'; import 'react'; import 'lodash/${j % 5}';`).join("\n");
    const graph = buildGraphFromFiles(files);
    expect(graph.unparsed).toEqual([]);
  });
});
