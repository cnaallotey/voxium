import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph, buildGraphBefore, readProjectFiles, readProtectedAtRef } from "./node.js";
import {
  buildGraphFromFiles,
  extractImports,
  extractVueScript,
  findImports,
  checkArchitecture,
  failing,
  globToRegExp,
  inferArchitecture,
  upsertBlock,
  validateArchitecture,
  renderAgentRules,
  buildSetupFiles,
  describeRuleChanges,
  cliPackageInWorkflow,
  mergeMcpConfig,
  parseCliPackage,
  renderWorkflow,
  BLOCK_START,
  expandSymlinks,
  moduleDependencies,
  assignModules,
  detectBuildOutput,
  findProtectedChanges,
  tightenBaseline,
  locateCycle,
  moduleConnections,
  needsConnections,
  type Architecture,
} from "./index.js";

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voxium-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

const base: Architecture = {
  version: 1,
  modules: {
    ui: { paths: ["src/ui/**"] },
    services: { paths: ["src/services/**"] },
    data: { paths: ["src/data/**"] },
  },
  layers: ["ui", "services", "data"],
  rules: [
    { id: "L1", type: "layers", severity: "block", description: "d", rationale: "r" },
    { id: "C1", type: "no_cycles", severity: "block", description: "d", rationale: "r" },
    { id: "E1", type: "deny_external", module: "ui", packages: ["pg"], severity: "block", description: "d", rationale: "r" },
    { id: "S1", type: "max_file_lines", max: 3, severity: "warn", description: "d", rationale: "r" },
  ],
  exceptions: [],
};

/** CPU time in ms that a function takes, which a busy machine does not make longer the way it does the time on the clock. */
function cpuMs(f: () => unknown): number {
  const start = process.cpuUsage();
  f();
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
}

describe("glob", () => {
  it("matches nested paths and single segments", () => {
    expect(globToRegExp("src/ui/**").test("src/ui/a/b.ts")).toBe(true);
    expect(globToRegExp("src/ui/**").test("src/uix/a.ts")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("**/*.vue").test("a/b/c.vue")).toBe(true);
    expect(globToRegExp("**/*.vue").test("c.vue")).toBe(true);
  });
});

describe("import scanner", () => {
  it("finds static, dynamic, side effect, re-export and require imports", () => {
    const code = `
      import a from "./a";
      import type { T } from '../t';
      import {
        b,
        c,
      } from "pkg/sub";
      export * from "./re";
      export { d } from "@scope/lib/x";
      import "./side";
      const m = await import("./lazy");
      const r = require("cjs-pkg");
    `;
    expect(extractImports(code).sort()).toEqual(
      ["./a", "../t", "pkg/sub", "./re", "@scope/lib/x", "./side", "./lazy", "cjs-pkg"].sort(),
    );
  });

  it("ignores imports in comments and template strings", () => {
    const code = [
      '// import x from "./commented";',
      '/* import y from "./block"; */',
      'const s = `import z from "./template"`;',
      'const q = "text // not a comment";',
      'import real from "./real";',
    ].join("\n");
    expect(extractImports(code)).toEqual(["./real"]);
  });
});

describe("graph", () => {
  it("builds from an in memory file map with no filesystem", () => {
    const g = buildGraphFromFiles({
      "src/ui/a.ts": `import "../services/s"; import "react";`,
      "src/services/s.ts": `export {};`,
      "node_modules/x/index.js": `import "./y";`,
      "src/types.d.ts": `export {};`,
      "README.md": "# hi",
    });
    expect(g.files).toEqual(["src/services/s.ts", "src/ui/a.ts"]);
    expect(g.edges.map((e) => e.to ?? e.pkg).sort()).toEqual(["react", "src/services/s.ts"]);
  });

  it("resolves relative, alias, extension swapped and vue imports", () => {
    const root = project({
      "src/ui/a.ts": `import "../services/s.js"; import x from "@/data/d"; import "react";`,
      "src/ui/B.vue": `<script setup lang="ts">import { s } from "../services/s";</script>`,
      "src/services/s.ts": `export const s = 1;`,
      "src/data/d.ts": `export default 1;`,
    });
    const g = buildGraph(root);
    const internal = g.edges.filter((e) => e.to).map((e) => `${e.from}>${e.to}`).sort();
    expect(internal).toEqual([
      "src/ui/B.vue>src/services/s.ts",
      "src/ui/a.ts>src/data/d.ts",
      "src/ui/a.ts>src/services/s.ts",
    ]);
    expect(g.edges.some((e) => e.pkg === "react")).toBe(true);
  });
});

describe("check", () => {
  it("passes clean downward imports", () => {
    const root = project({
      "src/ui/a.ts": `import "../services/s";`,
      "src/services/s.ts": `import "../data/d";`,
      "src/data/d.ts": `export {};`,
    });
    const res = checkArchitecture(base, buildGraph(root));
    expect(failing(res)).toEqual([]);
  });

  it("flags upward imports, cycles and denied packages", () => {
    const root = project({
      "src/ui/a.ts": `import "../services/s"; import "pg";`,
      "src/services/s.ts": `import "../ui/a";`,
      "src/data/d.ts": `export {};`,
    });
    const res = checkArchitecture(base, buildGraph(root));
    const ids = failing(res).map((v) => v.ruleId).sort();
    expect(ids).toEqual(["C1", "E1", "L1"]);
  });

  it("treats baseline violations as accepted and exceptions as expiring", () => {
    const root = project({
      "src/services/s.ts": `import "../ui/a";`,
      "src/ui/a.ts": `export {};`,
    });
    const g = buildGraph(root);
    const first = checkArchitecture(base, g);
    const ids = first.violations.filter((v) => v.severity === "block").map((v) => v.id);
    expect(failing(first).length).toBeGreaterThan(0);

    const withBase = checkArchitecture(base, g, { baseline: ids });
    expect(failing(withBase)).toEqual([]);

    const ex: Architecture = {
      ...base,
      exceptions: [{ rule: "L1", file: "src/services/**", owner: "t", reason: "migration", expires: "2099-01-01" }],
    };
    expect(failing(checkArchitecture(ex, g)).some((v) => v.ruleId === "L1")).toBe(false);

    const expired: Architecture = { ...ex, exceptions: [{ ...ex.exceptions[0], expires: "2000-01-01" }] };
    const res = checkArchitecture(expired, g);
    expect(res.expiredExceptions).toHaveLength(1);
    expect(failing(res).some((v) => v.ruleId === "L1")).toBe(true);
  });

  it("warns on large files without failing", () => {
    const root = project({ "src/ui/a.ts": "1\n2\n3\n4\n5\n" });
    const res = checkArchitecture(base, buildGraph(root));
    expect(res.violations.some((v) => v.ruleId === "S1")).toBe(true);
    expect(failing(res)).toEqual([]);
  });
});

describe("infer", () => {
  it("orders layers with importers on top and proposes rules", () => {
    const root = project({
      "src/pages/home.ts": `import "../services/s";`,
      "src/services/s.ts": `import "../utils/u"; import "../data/d";`,
      "src/data/d.ts": `import "../utils/u";`,
      "src/utils/u.ts": `export {};`,
    });
    const res = inferArchitecture(buildGraph(root));
    expect(res.architecture.layers).toEqual(["pages", "services", "data", "utils"]);
    expect(res.confidence).toBe(1);
    expect(res.existingViolations).toBe(0);
    expect(validateArchitecture(res.architecture).ok).toBe(true);
  });

  it("expands feature folders and reports cycles as existing violations", () => {
    const root = project({
      "src/features/auth/a.ts": `import "../billing/b";`,
      "src/features/billing/b.ts": `import "../auth/a";`,
      "src/shared/s.ts": `export {};`,
    });
    const res = inferArchitecture(buildGraph(root));
    expect(Object.keys(res.architecture.modules).sort()).toEqual(["auth", "billing", "shared"]);
    expect(res.existingViolations).toBeGreaterThan(0);
  });
});

describe("schema and generation", () => {
  it("rejects unknown layer modules and missing rationale", () => {
    const bad = { ...base, layers: ["ui", "ghost"], rules: [{ id: "X", type: "no_cycles", severity: "block", description: "d" }] };
    const res = validateArchitecture(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/ghost/);
    expect(res.errors.join(" ")).toMatch(/rationale/);
  });

  it("updates the managed block without touching other content", () => {
    const block = renderAgentRules(base);
    const first = upsertBlock("# My notes\n\nKeep this.\n", block);
    expect(first).toContain("Keep this.");
    expect(first).toContain(BLOCK_START);
    const second = upsertBlock(first, renderAgentRules({ ...base, layers: ["data", "services", "ui"] }));
    expect(second.match(/voxium:start/g)).toHaveLength(1);
    expect(second).toContain("Keep this.");
    expect(second.indexOf("`data`")).toBeLessThan(second.indexOf("`ui`"));
  });
});

describe("line numbers", () => {
  it("point at the import that breaks the rule", () => {
    const files = { "src/ui/a.ts": "", "src/data/d.ts": `// one\n/* two\n three */\nimport x from "./x";\n\nexport {\n  y,\n} from "../ui/a";\n`, "src/data/x.ts": "" };
    const [v] = failing(checkArchitecture(base, buildGraphFromFiles(files)));
    expect(v).toMatchObject({ file: "src/data/d.ts", line: 8 });
    expect(v.id).toBe("L1:src/data/d.ts->src/ui/a.ts"); // the baseline stores ids, so a line must not change them
  });

  it("are given for every rule about imports, cycles too, and for no other", () => {
    const rule = { severity: "block" as const, description: "d", rationale: "r" };
    const arch: Architecture = { ...base, rules: [
      { id: "EXT", type: "deny_external", module: "ui", packages: ["pg"], ...rule },
      { id: "DEP", type: "deny_dependency", from: "ui", to: "data", ...rule },
      { id: "SIZE", type: "max_file_lines", max: 2, ...rule },
      { id: "CYC", type: "no_cycles", ...rule },
    ] };
    const files = { "src/ui/a.ts": `\nimport "pg";\nimport "../data/d";`, "src/data/d.ts": `import "../ui/a";` };
    const lines = Object.fromEntries(failing(checkArchitecture(arch, buildGraphFromFiles(files))).map((v) => [v.ruleId, v.line]));
    expect(lines).toEqual({ EXT: 2, DEP: 3, SIZE: undefined, CYC: 1 });
  });

  it("count from the top of a .vue file, with Windows line endings too", () => {
    const vue = `<template>\r\n  <p>import "../no"</p>\r\n</template>\r\n<script setup>\r\nimport a from "../ui/a";\r\n</script>\r\n<script>import "./x"</script>`;
    const g = buildGraphFromFiles({ "src/ui/a.ts": "", "src/data/x.ts": "", "src/data/d.vue": vue });
    expect(g.edges).toMatchObject([{ to: "src/ui/a.ts", line: 5 }, { to: "src/data/x.ts", line: 7 }]);
  });

  it("name the first of several uses, and the import that leads to it indirectly", () => {
    expect(findImports(`const a = () => import("./a");\nimport "./a";\nrequire("./b")`)).toEqual([{ specifier: "./a", line: 1 }, { specifier: "./b", line: 3 }]);
    const files = { "src/ui/a.ts": "", "src/helper.ts": `\n\nimport "./ui/a";`, "src/data/d.ts": `\nimport "../helper";` };
    expect(failing(checkArchitecture(base, buildGraphFromFiles(files)))[0]).toMatchObject({ file: "src/data/d.ts", line: 2 });
  });

  it("stay fast on hostile .vue files", () => {
    expect(cpuMs(() => {
      for (const x of ["<script", "<script>", "<script></script>"]) extractVueScript(x.repeat(400_000));
    })).toBeLessThan(3000);
  });
});

describe("describing rule changes", () => {
  const ARCH = "voxium/architecture.json";
  const say = (change: (a: Architecture) => void) => {
    const next = structuredClone(base);
    change(next);
    return describeRuleChanges({ [ARCH]: JSON.stringify(base) }, { [ARCH]: JSON.stringify(next) }, [ARCH]);
  };

  it("names every kind of change", () => {
    const first = base.rules[0];
    expect(say((a) => void a.rules.shift()).join()).toContain(`Removes rule ${first.id} [${first.severity}]`);
    expect(say((a) => void (a.rules[0].severity = "warn"))).toEqual([`Changes rule ${first.id}: severity from block to warn`]);
    expect(say((a) => void a.layers.reverse()).join()).toMatch(/Changes the layers from .* to /);
    expect(say((a) => void (a.modules.extra = { paths: ["src/extra/**"] }))).toEqual(["Adds module extra (src/extra/**)"]);
    expect(say((a) => void (a.modules[a.layers[0]].paths = ["nowhere/**"])).join()).toContain("nowhere/**");
    expect(say((a) => void (a.ignore = ["src/**"]))).toEqual(["Stops checking src/**"]);
    expect(say((a) => void a.exceptions.push({ rule: "L", file: "src/x.ts", owner: "ann", reason: "later", expires: "2030-01-01" }))).toEqual([
      "Adds exception to L for src/x.ts until 2030-01-01 (owner ann: later)",
    ]);
    expect(say((a) => void (a.meta = { approvedBy: "me" })).join()).toContain("meta");
    expect(say((a) => void Object.assign(a, { surprise: 1 })).join()).toContain("surprise");
  });

  it("mentions a change of module order, which decides who owns overlapping files", () => {
    const text = say((a) => void (a.modules = Object.fromEntries(Object.entries(a.modules).reverse())));
    expect(text.join()).toMatch(/which module wins/);
  });

  it("never stays silent, whatever the files hold", () => {
    const d = (x: string | null, y: string | null) => describeRuleChanges({ [ARCH]: x }, { [ARCH]: y }, [ARCH]);
    const ok = JSON.stringify(base);
    expect(d(ok, null)).toEqual(["Removes voxium/architecture.json. Voxium stops checking this repository"]);
    expect(d(ok, "{")).toEqual(["Makes voxium/architecture.json invalid"]);
    expect(d(null, ok)[0]).toMatch(/^Adds the architecture rules/);
    expect(d("{", ok)[0]).toMatch(/^Replaces rules that were invalid/);
    expect(d(ok, `${ok}\n`)[0]).toMatch(/formatting/);
    expect(describeRuleChanges({}, { ".github/workflows/voxium.yml": "on: push" }, [".github/workflows/voxium.yml"])[0]).toMatch(/^Adds/);
  });

  it("counts baseline debt", () => {
    const B = "voxium/baseline.json";
    const f = (v: string[]) => ({ [B]: JSON.stringify({ violations: v }) });
    expect(describeRuleChanges(f(["a"]), f(["b", "c"]), [B])).toEqual([
      "Accepts 2 violation(s) as existing debt: b; c",
      "Stops accepting 1 violation(s): a",
    ]);
    expect(describeRuleChanges(f(["a"]), { [B]: "{" }, [B])[0]).toMatch(/unreadable/);
    expect(describeRuleChanges(f([]), f(Array.from({ length: 8 }, (_, i) => `v${i}`)), [B])[0]).toContain("and 3 more");
  });

  it("keeps hostile text on one short line", () => {
    const [line] = say((a) => void (a.modules.evil = { paths: [`x\n\n# Approved\u202e${"y".repeat(2000)}`] }));
    expect(line).not.toMatch(/[\n\u202e]/);
    expect(line.length).toBeLessThan(400);
  });
});

describe("running the CLI from npm", () => {
  const WF = ".github/workflows/voxium.yml";
  const unpinned = JSON.stringify({ mcpServers: { voxium: { command: "npx", args: ["voxium", "mcp"] }, other: { command: "x" } } });

  it.each(["voxium", "voxium@latest", "voxium@^1.2.3", "voxium@1.2", "voxium@1.2.3 && curl x", "voxium@1.2.3\nrun: x", "--yes@1.2.3", "git+https://x/y@1.2.3", "../voxium@1.2.3"])(
    "refuses anything but an exact version: %j",
    (spec) => {
      expect(() => parseCliPackage(spec)).toThrow(/exact published version/);
      expect(() => buildSetupFiles({ arch: base, baseline: [], cliPackage: spec })).toThrow();
    },
  );

  it.each([["voxium@1.2.3"], ["@voxium/cli@0.1.0-beta.1"]])("accepts %s", (spec) => {
    expect(parseCliPackage(` ${spec} `)).toBe(spec);
    expect(cliPackageInWorkflow(renderWorkflow(spec))).toBe(spec);
  });

  it("writes nothing that downloads and runs code unless a package is given", () => {
    const files = buildSetupFiles({ arch: base, baseline: [] });
    expect(Object.keys(files).sort()).toEqual([".cursor/rules/voxium.mdc", "AGENTS.md", "CLAUDE.md", "voxium/CODEOWNERS.suggested", "voxium/architecture.json", "voxium/baseline.json"]);
    expect(Object.values(files).join("\n")).not.toMatch(/npx|npm /);
  });

  it("uses the exact version everywhere when a package is given", () => {
    const files = buildSetupFiles({ arch: base, baseline: [], cliPackage: "voxium@1.2.3" });
    expect(files[WF]).toContain('run: npx --yes voxium@1.2.3 check --root');
    expect(JSON.parse(files[".mcp.json"]).mcpServers.voxium).toEqual({ command: "npx", args: ["--yes", "voxium@1.2.3", "mcp"] });
    expect(files["CLAUDE.md"]).toContain("npx --yes voxium@1.2.3 check");
    expect(Object.values(files).join("\n").match(/npx --yes (?!voxium@1\.2\.3 )/)).toBeNull();
  });

  it("removes the unpinned server older versions wrote, and leaves every other server alone", () => {
    expect(JSON.parse(mergeMcpConfig(unpinned)!).mcpServers).toEqual({ other: { command: "x" } });
    expect(JSON.parse(mergeMcpConfig(unpinned, "voxium@1.2.3")!).mcpServers.voxium.args).toEqual(["--yes", "voxium@1.2.3", "mcp"]);
    expect(mergeMcpConfig(JSON.stringify({ mcpServers: { voxium: { command: "node", args: ["mine.js"] } } }))).toBeUndefined();
    expect(mergeMcpConfig(undefined)).toBeUndefined();
    for (const bad of ["{", "null", "[]", "1"]) expect(mergeMcpConfig(bad, "voxium@1.2.3")).toBeUndefined();
  });

  it("does not take an unpinned version from an existing workflow", () => {
    expect(cliPackageInWorkflow(renderWorkflow("voxium@1.2.3").replace("voxium@1.2.3", "voxium"))).toBeUndefined();
    expect(cliPackageInWorkflow(undefined)).toBeUndefined();
  });
});

const ids = (files: Record<string, string>, arch: Architecture = base) =>
  failing(checkArchitecture(arch, buildGraphFromFiles(files))).map((v) => v.id);

describe("files outside modules", () => {
  it("cannot be used to pass an import around the layers", () => {
    expect(
      ids({
        "src/ui/a.ts": "export {};",
        "src/bridge.ts": `export * from "./hop";`,
        "src/hop.ts": `export * from "./ui/a"; import "./bridge";`,
        "src/data/d.ts": `import "../bridge";`,
      }),
    ).toEqual(["L1:src/data/d.ts->src/bridge.ts=>ui"]);
  });

  it("cannot be used to reach a denied package or to hide a cycle", () => {
    expect(ids({ "src/db.ts": `import "pg";`, "src/ui/a.ts": `import "../db";` })).toEqual(["E1:src/ui/a.ts->src/db.ts=>pg"]);
    const noLayers: Architecture = { ...base, layers: [] };
    expect(
      ids({ "src/ui/a.ts": `import "../services/s";`, "src/services/s.ts": `import "../x";`, "src/x.ts": `import "./ui/a";` }, noLayers),
    ).toEqual(["C1:services+ui"]);
  });

  it("may be imported when they only lead downward, and may import anything themselves", () => {
    expect(ids({ "src/main.ts": `import "./ui/a"; import "./data/d";`, "src/ui/a.ts": `import "../x";`, "src/x.ts": `import "./data/d";`, "src/data/d.ts": "" })).toEqual([]);
  });

  it("lets stand alone tests share helpers, but not a test file that other code imports", () => {
    const helper = { "test/utils.ts": `import "../src/ui/a";`, "src/ui/a.ts": "", "src/data/d.test.ts": `import "../../test/utils";` };
    expect(ids(helper)).toEqual([]);
    expect(ids({ ...helper, "src/data/d.ts": `import "./d.test";` })).toEqual(["L1:src/data/d.test.ts->test/utils.ts=>ui"]);
  });

  it("gives the same answer with many files importing each other", () => {
    const files: Record<string, string> = { "src/ui/a.ts": "", "src/data/d.ts": `import "../u0";` };
    for (let i = 0; i < 2000; i++) files[`src/u${i}.ts`] = `import "./u${(i + 1) % 2000}"; import "./u${(i * 7) % 2000}";`;
    files["src/u1999.ts"] += `import "./ui/a";`;
    const g = buildGraphFromFiles(files);
    const deps = moduleDependencies(g, assignModules(base, g.files));
    expect(deps).toEqual([{ from: "src/data/d.ts", fromMod: "data", to: "src/ui/a.ts", toMod: "ui", via: "src/u0.ts", line: 1 }]);
  });
});

describe("ignored files", () => {
  it.each(["build", "out", "dist", "voxium", ".cache", "coverage"])("code in a committed folder named %s is still checked", (dir) => {
    expect(ids({ "src/ui/a.ts": "", [`src/data/${dir}/d.js`]: `import "../../ui/a";` })).toHaveLength(1);
    expect(ids({ "src/ui/a.ts": "", [`${dir}/b.ts`]: `import "../src/ui/a";`, "src/data/d.ts": `import "../../${dir}/b";` })).toHaveLength(1);
  });

  it("skips only what the architecture ignores", () => {
    const files = { "src/ui/a.ts": "", "src/data/gen/d.ts": `import "../../ui/a";` };
    expect(ids(files)).toHaveLength(1);
    expect(ids(files, { ...base, ignore: ["src/data/gen/**"] })).toEqual([]);
    // Importing an ignored file still counts as importing what it leads to.
    expect(ids({ ...files, "src/data/d.ts": `import "./gen/d";` }, { ...base, ignore: ["src/data/gen/**"] })).toEqual([
      "L1:src/data/d.ts->src/data/gen/d.ts=>ui",
    ]);
    expect(validateArchitecture({ ...base, ignore: [1] }).ok).toBe(false);
  });

  it("proposes ignoring committed build output, never source", () => {
    expect(detectBuildOutput(["dist/index.js", "packages/a/dist/x.mjs", "src/build/x.js", "build/tool.ts", "out/a.js", "out/b.ts", ".yarn/releases/y.cjs", "a/.pnp.cjs"])).toEqual([
      ".yarn/**",
      "a/.pnp.cjs",
      "dist/**",
      "packages/a/dist/**",
    ]);
  });
});

describe("protected files", () => {
  const A = "voxium/architecture.json";
  it("notices deletion and edits, but not a branch that is behind", () => {
    expect(findProtectedChanges({ [A]: "1" }, { [A]: "1" }, {})).toEqual([A]);
    expect(findProtectedChanges({ [A]: "1" }, { [A]: "1" }, { [A]: "2" })).toEqual([A]);
    expect(findProtectedChanges({ [A]: "2" }, { [A]: "1" }, { [A]: "1" })).toEqual([]);
    expect(findProtectedChanges({ [A]: "2" }, { [A]: "1" }, { [A]: "2" })).toEqual([]);
  });

  it("only ever makes the baseline stricter", () => {
    const b = (...violations: string[]) => JSON.stringify({ violations });
    expect(tightenBaseline(b("x", "y"), b("x"))).toEqual(["x"]);
    expect(tightenBaseline(b("x"), b("x", "y"))).toEqual(["x"]);
    expect(tightenBaseline(b("x"), "{")).toEqual(["x"]);
    expect(tightenBaseline(b("x"), null)).toEqual([]);
  });
});

describe("scanner cost", () => {
  it("stays linear on files with many keywords and no strings", () => {
    let found: string[] = [];
    expect(cpuMs(() => (found = extractImports(`${"export {}; typeof foo\n".repeat(40_000)}import "./a";`)))).toBeLessThan(6000); // about 1 s of CPU, and minutes if it grew with the square of the size
    expect(found).toEqual(["./a"]);
  });

  it("still finds names that are keywords", () => {
    expect(extractImports(`export { x as import } from "./a"; import { export as y } from "./b";`).sort()).toEqual(["./a", "./b"]);
  });
});

describe("symlinks", () => {
  it("follows links to files, folders and other links", () => {
    const files = { "src/ui/a.ts": "export {};", "src/data/d.ts": `import "./file"; import "./dir/a"; import "./twice";` };
    const links = { "src/data/file.ts": "src/ui/a.ts", "src/data/dir": "src/ui", "src/data/twice.ts": "src/data/file.ts" };
    const g = buildGraphFromFiles(expandSymlinks(files, links));
    expect(failing(checkArchitecture(base, g)).map((v) => v.id).sort()).toEqual([
      "L1:src/data/dir/a.ts->src/ui/a.ts",
      "L1:src/data/file.ts->src/ui/a.ts",
      "L1:src/data/twice.ts->src/ui/a.ts",
    ]);
    expect(expandSymlinks(files, { a: "b", b: "a" })).toEqual(files); // a loop
  });
});

describe("git", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...args], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();

  it("reads what could be committed, and rules only from the ref asked for", () => {
    const root = project({
      ".gitignore": "dist\n",
      "dist/out.js": "1",
      "src/build/a.js": "1",
      "src/b.ts": "1",
      "voxium/architecture.json": "base",
    });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "x");
    fs.writeFileSync(path.join(root, "src/new.ts"), "1");
    fs.writeFileSync(path.join(root, "voxium/architecture.json"), "edited");
    expect(Object.keys(readProjectFiles(root)).sort()).toEqual(["src/b.ts", "src/build/a.js", "src/new.ts"]);

    git(root, "add", "-f", "dist/out.js"); // force added, so it would be committed
    expect(Object.keys(readProjectFiles(root))).toContain("dist/out.js");

    const rules = readProtectedAtRef(root, "main");
    expect(rules["voxium/architecture.json"]).toBe("base");
    expect(rules["voxium/baseline.json"]).toBeNull();
    expect(() => readProtectedAtRef(root, "nope")).toThrow(/no such commit/);
    expect(() => readProtectedAtRef(root, "--help")).toThrow(/no such commit/);
  });

  it("reads the code from before a change", () => {
    const root = project({
      "src/ui/a.ts": `import "../ü/b";`, "src/ü/b.ts": "export const é = 1;", "src/empty.ts": "", "docs/x.md": `import "./y"`,
      "app/src/z.ts": `import "./y";`, "app/src/y.ts": "",
    });
    git(root, "init", "-q", "-b", "main");
    fs.symlinkSync("../src/ui", path.join(root, "app/link"));
    fs.symlinkSync("/src", path.join(root, "app/abs")); // not app/src
    git(root, "add", "-A");
    git(root, "commit", "-qm", "x");
    const same = () => {
      const { root: _, ...g } = buildGraphBefore(root)!;
      const { root: __, ...now } = buildGraph(root);
      return [g, now].map((x) => ({ files: [...x.files].sort(), lines: x.lines, edges: x.edges.map((e) => JSON.stringify(e)).sort() }));
    };
    const [before, now] = same();
    expect(before).toEqual(now);
    expect(before.files).toContain("src/ü/b.ts");

    // What is not committed, and what the branch has committed since, is the change.
    fs.writeFileSync(path.join(root, "src/new.ts"), "1");
    expect(buildGraphBefore(root)!.files).not.toContain("src/new.ts");
    git(root, "checkout", "-qb", "work");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "y");
    git(root, "checkout", "-q", "main");
    fs.writeFileSync(path.join(root, "src/later.ts"), "1");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "z");
    git(root, "checkout", "-q", "work");
    expect(buildGraphBefore(root)!.files).toContain("src/new.ts");
    const branch = buildGraphBefore(root, "main")!;
    expect(branch.files).not.toContain("src/new.ts");
    expect(branch.files).not.toContain("src/later.ts");
    expect(branch.files).toContain("src/ui/a.ts");
    expect(buildGraphBefore(path.join(root, "app"))!.files).toEqual(expect.arrayContaining(["src/y.ts", "src/z.ts"]));
    expect(buildGraphBefore(path.join(root, "app"))!.files).toHaveLength(2);

    for (const ref of ["nope", "--help", "--all", "--octopus"]) expect(buildGraphBefore(root, ref)).toBeNull();
    expect(buildGraphBefore(project({ "a.ts": "" }))).toBeNull();
    const empty = project({ "a.ts": "" });
    git(empty, "init", "-q");
    expect(buildGraphBefore(empty)).toBeNull();
  });

  it("reads submodules, nested repos and symlinks, and survives odd work trees", () => {
    const lib = project({ "a.ts": "export {};", "dist/x.ts": "1" });
    git(lib, "init", "-q", "-b", "main");
    git(lib, "add", "-A");
    git(lib, "commit", "-qm", "x");
    const root = project({ "src/ui/p.ts": "export {};", "src/gone/x.ts": "1" });
    git(root, "init", "-q", "-b", "main");
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "packages/lib");
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested/n.ts"), "1");
    git(path.join(root, "nested"), "init", "-q");
    fs.mkdirSync(path.join(root, "src/data"));
    fs.symlinkSync("../ui/p.ts", path.join(root, "src/data/link.ts"));
    fs.symlinkSync("/etc", path.join(root, "src/data/outside"));
    fs.symlinkSync("missing.ts", path.join(root, "src/data/broken.ts"));
    git(root, "add", "-A", "src");
    git(root, "commit", "-qm", "x");
    fs.rmSync(path.join(root, "src/gone"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/gone"), "now a file");

    const files = readProjectFiles(root);
    expect(Object.keys(files).sort()).toEqual(["nested/n.ts", "packages/lib/a.ts", "packages/lib/dist/x.ts", "src/data/link.ts", "src/ui/p.ts"]);
    expect(failing(checkArchitecture(base, buildGraphFromFiles(files))).map((v) => v.id)).toEqual(["L1:src/data/link.ts->src/ui/p.ts"]);
  });
});

describe("cycles", () => {
  const down = { "src/ui/a.ts": `import "../services/s";`, "src/services/s.ts": `import "../data/d";`, "src/data/d.ts": "" };
  const cycleOf = (files: Record<string, string>, arch = base, baseline: string[] = []) =>
    checkArchitecture(arch, buildGraphFromFiles(files), { baseline, today: new Date("2026-01-01") }).violations.filter((v) => v.ruleId === "C1");
  const excepting = (...files: string[]): Architecture => ({
    ...base,
    exceptions: files.map((file) => ({ rule: "C1", file, owner: "o", reason: "r", expires: "2099-01-01" })),
  });
  const noLayers: Architecture = { ...base, layers: [], rules: base.rules.filter((r) => r.id !== "L1") };

  it("point at the import against the layer order and name the way back, with the same id as before", () => {
    const [v, ...more] = cycleOf({ ...down, "src/data/d.ts": `\n\nimport "../ui/a";` });
    expect(more).toEqual([]);
    expect(v).toMatchObject({ id: "C1:data+services+ui", file: "src/data/d.ts", line: 3 });
    expect(v.message).toBe(
      "Modules form a dependency cycle: data <-> services <-> ui. src/data/d.ts:3 (data) imports src/ui/a.ts (ui); src/ui/a.ts:1 (ui) imports src/services/s.ts (services); src/services/s.ts:1 (services) imports src/data/d.ts (data).",
    );
  });

  it("name the shortest way back", () => {
    const [v] = cycleOf({ ...down, "src/ui/z.ts": `import "../data/d";`, "src/data/d.ts": `import "../ui/a";` });
    expect(v.message).toMatch(/src\/data\/d\.ts:1 .* imports src\/ui\/a\.ts \(ui\); src\/ui\/z\.ts:1 \(ui\) imports src\/data\/d\.ts \(data\)\.$/);
  });

  it("name the shortest way back, not one that visits a module twice as far", () => {
    const modules = Object.fromEntries(["a", "b", "c", "d"].map((m) => [m, { paths: [`src/${m}/**`] }]));
    const files = { "src/a/f.ts": `import "../b/f"; import "../c/f";`, "src/b/f.ts": `import "../c/f";`, "src/c/f.ts": `import "../d/f";`, "src/d/f.ts": `import "../a/f";` };
    const [v] = cycleOf(files, { ...base, modules, layers: ["a", "b", "c", "d"] });
    expect(v.message.match(/\((\w)\) imports/g)).toEqual(["(d) imports", "(a) imports", "(c) imports"]);
  });

  it("do not point at imports that leave the cycle", () => {
    const files = { "src/ui/a.ts": "", "src/services/a.ts": `import "../ui/a";`, "src/services/s.ts": `import "../data/d";`, "src/data/d.ts": `import "../services/s";` };
    expect(cycleOf(files, base, ["L1:src/data/d.ts->src/services/s.ts"])[0]).toMatchObject({ id: "C1:data+services", file: "src/data/d.ts" });
  });

  it("say so when an import goes through a file outside the modules", () => {
    const [v] = cycleOf({ ...down, "src/data/d.ts": `import "../bridge";`, "src/bridge.ts": `import "./ui/a";` });
    expect(v).toMatchObject({ file: "src/data/d.ts", line: 1 });
    expect(v.message).toContain("src/data/d.ts:1 (data) reaches src/ui/a.ts (ui) through src/bridge.ts, which is outside every module;");
  });

  it("prefer imports that are not accepted debt, and the module pair with the fewest", () => {
    const files = { ...down, "src/data/a.ts": `import "../ui/a";`, "src/data/b.ts": `import "../ui/a";` };
    expect(cycleOf(files)[0].file).toBe("src/data/a.ts");
    expect(cycleOf(files, base, ["L1:src/data/a.ts->src/ui/a.ts"])[0].file).toBe("src/data/b.ts");
    expect(cycleOf({ "src/data/a.ts": `import "../ui/u";`, "src/data/b.ts": `import "../ui/u";`, "src/ui/u.ts": `import "../data/a";` }, noLayers)[0].file).toBe("src/ui/u.ts");
  });

  it("do not depend on the order of the files", () => {
    const files = { ...down, "src/data/a.ts": `import "../ui/a";`, "src/data/b.ts": `import "../ui/a";`, "src/services/t.ts": `import "../ui/a";` };
    const turned = Object.fromEntries(Object.entries(files).reverse());
    expect(cycleOf(turned)[0]).toEqual(cycleOf(files)[0]);
  });

  it("stay short when they are long", () => {
    const n = 12;
    const arch: Architecture = {
      ...noLayers,
      modules: Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, { paths: [`src/m${i}/**`] }])),
    };
    const files = Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/m${i}/f.ts`, `import "../m${(i + 1) % n}/f";`]));
    const [v] = cycleOf(files, arch);
    expect(v.message.match(/ imports /g)).toHaveLength(6);
    expect(v.message).toContain("; 6 more import(s) lead back to m0.");
  });

  describe("caused by a change", () => {
    const at = (files: Record<string, string>, isNew: (i: { file: string; to: string }) => boolean, arch = base) => {
      const res = checkArchitecture(arch, buildGraphFromFiles(files));
      const v = res.violations.find((x) => x.ruleId === "C1")!;
      const c = res.cycles.get(v.id)!;
      return locateCycle(v, c.modules, c.imports, isNew);
    };

    it("point at the import it adds, even a downward one that closes a cycle", () => {
      const files = { "src/ui/a.ts": `import "../data/d";`, "src/data/d.ts": `import "../ui/a";` };
      expect(at(files, (i) => i.file === "src/ui/a.ts").file).toBe("src/ui/a.ts");
      expect(at(files, (i) => i.file === "src/data/d.ts").file).toBe("src/data/d.ts");
      expect(at(files, () => false).file).toBe("src/data/d.ts");
    });

    it("do not blame an import between modules that were already connected", () => {
      const files = { ...down, "src/ui/b.ts": `import "../services/s";`, "src/data/d.ts": `import "../ui/a";` };
      expect(at(files, (i) => i.file === "src/ui/b.ts" || i.file === "src/data/d.ts").file).toBe("src/data/d.ts");
      expect(at(files, (i) => i.file === "src/ui/b.ts").file).toBe("src/data/d.ts");
    });

    it("prefer the import it adds against the layer order over older ones of the same kind", () => {
      const files = { ...down, "src/data/a.ts": `import "../ui/a";`, "src/data/z.ts": `import "../ui/a";` };
      expect(at(files, (i) => i.file === "src/data/z.ts").file).toBe("src/data/z.ts");
    });

    it("among the imports it adds, prefer the one against the layer order", () => {
      const files = { "src/ui/a.ts": `import "../data/d";`, "src/data/d.ts": `import "../ui/a";`, "src/data/e.ts": `import "../ui/a";` };
      expect(at(files, () => true).file).toBe("src/data/d.ts");
    });
  });

  describe("within an accepted one", () => {
    // Accepted: a, b and c in one cycle.
    const abc = { "src/ui/a.ts": `import "../services/s";`, "src/services/s.ts": `import "../ui/a"; import "../data/d";`, "src/data/d.ts": `import "../services/s";` };
    const whole = ["C1:data+services+ui"];
    const less = { ...abc, "src/data/d.ts": "" };
    const check = (files: Record<string, string>, before: Record<string, string> | null, baseline = whole, arch = base) =>
      checkArchitecture(arch, buildGraphFromFiles(files), {
        baseline,
        ...(before ? { connections: moduleConnections(arch, buildGraphFromFiles(before)) } : {}),
      });
    const open = (r: ReturnType<typeof check>) => r.violations.filter((v) => v.ruleId === "C1" && !v.baseline && !v.excepted).map((v) => v.id);

    it("are accepted when they are what is left of it", () => {
      const r = check(less, abc);
      expect(open(r)).toEqual([]);
      expect(r.violations.find((v) => v.id === "C1:services+ui")).toMatchObject({ baseline: true });
      expect(needsConnections(r)).toBe(false);
    });

    it("are new, and ask for the code from before, when that is not known", () => {
      const r = check(less, null);
      expect(open(r)).toEqual(["C1:services+ui"]);
      expect(needsConnections(r)).toBe(true);
    });

    it("are new when the change adds a connection to them, and point at it", () => {
      const before = { ...abc, "src/ui/a.ts": `import "../data/d";`, "src/services/s.ts": `import "../ui/a";` }; // ui > data > services > ui
      const after = { "src/ui/a.ts": `import "../services/s";`, "src/services/s.ts": `import "../ui/a";`, "src/data/d.ts": "" };
      const r = check(after, before);
      expect(open(r)).toEqual(["C1:services+ui"]);
      expect(needsConnections(r)).toBe(false);
      expect(r.violations.find((v) => v.ruleId === "C1")).toMatchObject({ file: "src/ui/a.ts" }); // not the older import against the layer order
    });

    it("are new when the accepted one was gone already", () => {
      expect(open(check(less, { ...less, "src/services/s.ts": "" }))).toEqual(["C1:services+ui"]);
    });

    it("may get more imports along connections they had", () => {
      expect(open(check({ ...less, "src/services/t.ts": `import "../ui/a";` }, abc))).toEqual([]);
    });

    it("are judged one by one when it falls apart", () => {
      const modules = Object.fromEntries(["p", "q", "r", "s"].map((m) => [m, { paths: [`${m}/**`] }]));
      const arch: Architecture = { ...noLayers, modules };
      const before = { "p/f.ts": `import "../q/f";`, "q/f.ts": `import "../p/f"; import "../r/f";`, "r/f.ts": `import "../s/f"; import "../q/f";`, "s/f.ts": `import "../r/f";` };
      const after = { ...before, "q/f.ts": `import "../p/f";`, "r/f.ts": `import "../s/f";` };
      const all = ["C1:p+q+r+s"];
      expect(open(check(before, null, all, arch))).toEqual([]);
      expect(open(check(after, before, all, arch))).toEqual([]);
      expect(open(check(after, { ...before, "s/f.ts": "" }, all, arch))).toEqual(["C1:r+s"]);
    });

    it("are new when they reach beyond it or belong to another rule", () => {
      for (const baseline of [["C1:services+ui"], ["C2:data+services+ui"], ["L1:data+services+ui"], ["C1:data", "C1:services", "C1:ui"], []]) {
        const r = check({ ...abc }, abc, baseline);
        expect(open(r)).toEqual(whole);
        expect(needsConnections(check(abc, null, baseline))).toBe(false);
      }
    });

    it("are not guessed at when a module name has the separator in it", () => {
      const arch: Architecture = { ...noLayers, modules: { "p+q": { paths: ["pq/**"] }, p: { paths: ["p/**"] }, q: { paths: ["q/**"] }, r: { paths: ["r/**"] } } };
      const files = { "p/f.ts": `import "../q/f";`, "q/f.ts": `import "../p/f";` };
      expect(open(check(files, files, ["C1:p+q+r"], arch))).toEqual(["C1:p+q"]);
    });

    it("are accepted with exceptions when what is left was there before", () => {
      const arch = { ...excepting("src/data/d.ts") };
      const grown = { ...abc, "src/data/d.ts": `import "../services/s";`, "src/ui/b.ts": "" };
      expect(open(check(grown, abc, ["C1:services+ui"], arch))).toEqual([]);
      const r = check(grown, null, [], arch);
      expect(open(r)).toHaveLength(1);
      expect(needsConnections(r)).toBe(false); // nothing is accepted, so nothing depends on it
      // Without the excepted import, services and ui are left of an accepted cycle that had a fourth module.
      const modules = { ...base.modules, extra: { paths: ["src/extra/**"] } };
      const four = { ...arch, modules, layers: [...base.layers, "extra"] };
      const wide = ["C1:extra+services+ui"];
      expect(open(check(abc, abc, wide, four))).toEqual([]);
      const unknown = check(abc, null, wide, four);
      expect(open(unknown)).toEqual(whole);
      expect(needsConnections(unknown)).toBe(true);
      expect(open(check(abc, { ...abc, "src/services/s.ts": `import "../data/d";` }, wide, four))).toEqual(whole);
    });

    it("that are excepted ask for nothing", () => {
      const r = check(less, null, whole, excepting("src/services/s.ts"));
      expect(open(r)).toEqual([]);
      expect(needsConnections(r)).toBe(false);
    });
  });

  describe("with exceptions", () => {
    const files = { ...down, "src/data/d.ts": `import "../ui/a";` };
    const blocked = (f: Record<string, string>, arch: Architecture, baseline: string[] = []) => cycleOf(f, arch, baseline).filter((v) => !v.baseline && !v.excepted);

    it("are excepted by the files whose imports cause them", () => {
      expect(blocked(files, excepting("src/data/d.ts"))).toEqual([]);
      expect(blocked(files, excepting("src/data/**"))).toEqual([]);
      // Not the import it points at, but there is no cycle without this one either.
      expect(cycleOf(files, excepting("src/ui/a.ts"))[0]).toMatchObject({ file: "src/data/d.ts", excepted: true });
    });

    it("are not excepted by other files, or while another import keeps them going", () => {
      expect(blocked(files, excepting("src/ui/other.ts"))).toHaveLength(1);
      expect(blocked(files, excepting("src/data/other.ts", "src/data/d.tsx"))).toHaveLength(1);
      const [v] = blocked({ ...files, "src/data/e.ts": `import "../ui/a";` }, excepting("src/data/d.ts"));
      expect(v).toMatchObject({ id: "C1:data+services+ui", file: "src/data/e.ts" });
      expect(v.message).not.toContain("src/data/d.ts:1");
    });

    it("are not excepted by a file that merely takes part, when the rest is still a cycle", () => {
      const two = { ...files, "src/services/s.ts": `import "../data/d"; import "../ui/a";` };
      const [v] = blocked(two, excepting("src/data/d.ts"));
      expect(v).toMatchObject({ id: "C1:data+services+ui", file: "src/services/s.ts" });
    });

    it("are excepted when what is left is accepted debt", () => {
      const two = { ...files, "src/services/s.ts": `import "../data/d"; import "../ui/a";` };
      expect(blocked(two, excepting("src/data/d.ts"), ["C1:services+ui"])).toEqual([]);
      expect(blocked(two, excepting("src/data/d.ts"), ["C1:data+services"])).toHaveLength(1);
      expect(blocked(two, base, ["C1:services+ui"])).toHaveLength(1);
    });

    it("ignore exceptions to other rules and expired ones", () => {
      const ex = { file: "src/data/d.ts", owner: "o", reason: "r" };
      expect(blocked(files, { ...base, exceptions: [{ ...ex, rule: "L1", expires: "2099-01-01" }] })).toHaveLength(1);
      expect(blocked(files, { ...base, exceptions: [{ ...ex, rule: "C1", expires: "2025-12-31" }] })).toHaveLength(1);
    });

    it("stay accepted debt as before", () => {
      expect(cycleOf(files, base, ["C1:data+services+ui"])[0]).toMatchObject({ baseline: true });
      expect(cycleOf(files, base, ["C1:data+services+ui"])[0].excepted).toBeUndefined();
      expect(blocked(files, excepting("src/ui/a.ts"), ["C1:data+services+ui"])).toEqual([]);
      // Exceptions that leave a smaller one do not change that, and nothing else has to be known.
      const two = { ...files, "src/services/s.ts": `import "../data/d"; import "../ui/a";` };
      const r = checkArchitecture(excepting("src/data/d.ts"), buildGraphFromFiles(two), { baseline: ["C1:data+services+ui"] });
      expect(r.violations.find((v) => v.ruleId === "C1")).toMatchObject({ baseline: true });
      expect(needsConnections(r)).toBe(false);
    });
  });
});

describe("graph scan cache", () => {
  it("gives the same graph with a cache as without, and reads a file again when its contents change", () => {
    const before = { "src/a.ts": `import "./b";`, "src/b.ts": `import "./c";`, "src/c.ts": "", "src/d.vue": `<script>import "./a"</script>` };
    const after = { ...before, "src/b.ts": `import "./a";\nimport x from "pg";`, "src/e.ts": `import "./d.vue";` };
    const scans = new Map();
    const one = buildGraphFromFiles(after, { scans });
    expect(one).toEqual(buildGraphFromFiles(after));
    expect([...scans.keys()].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.vue", "src/e.ts"]);
    const kept = scans.get("src/a.ts");
    expect(buildGraphFromFiles(before, { scans })).toEqual(buildGraphFromFiles(before));
    // Unchanged contents are not read again; changed ones are, and replace what was kept.
    expect(scans.get("src/a.ts")).toBe(kept);
    expect(scans.get("src/b.ts").raw).toBe(before["src/b.ts"]);
    expect(buildGraphFromFiles(after, { scans })).toEqual(one);
  });
});
