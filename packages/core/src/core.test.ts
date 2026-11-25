import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph, readProjectFiles, readProtectedAtRef } from "./node.js";
import {
  buildGraphFromFiles,
  extractImports,
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
    expect(Object.keys(files).sort()).toEqual(["AGENTS.md", "CLAUDE.md", "voxium/CODEOWNERS.suggested", "voxium/architecture.json", "voxium/baseline.json"]);
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
    expect(deps).toEqual([{ from: "src/data/d.ts", fromMod: "data", to: "src/ui/a.ts", toMod: "ui", via: "src/u0.ts" }]);
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
    const t = Date.now();
    expect(extractImports(`${"export default foo\n".repeat(200_000)}import "./a";`)).toEqual(["./a"]);
    expect(Date.now() - t).toBeLessThan(2000);
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
