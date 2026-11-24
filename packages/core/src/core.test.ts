import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph } from "./node.js";
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
  BLOCK_START,
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
