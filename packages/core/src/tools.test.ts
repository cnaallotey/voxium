import { describe, expect, it } from "vitest";
import {
  checkChange,
  checkImport,
  createProposal,
  getRulesForPath,
  type Architecture,
  type ToolContext,
} from "./index.js";

const arch: Architecture = {
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
    { id: "D1", type: "deny_dependency", from: "ui", to: "data", severity: "block", description: "d", rationale: "ui goes through services" },
    { id: "E1", type: "deny_external", module: "ui", packages: ["pg"], severity: "block", description: "d", rationale: "r" },
  ],
  exceptions: [],
};

const files = {
  "src/ui/a.ts": `import "../services/s";`,
  "src/services/s.ts": `import "../data/d";`,
  "src/data/d.ts": `export {};`,
};

const ctx: ToolContext = { arch, files, baseline: [] };

describe("agent tools", () => {
  it("get_rules_for_path lists what a module may and may not import", () => {
    const r = getRulesForPath(ctx, "src/ui/new.ts") as any;
    expect(r.module).toBe("ui");
    expect(r.mayImportFromModules).toEqual(["ui", "services"]); // data is denied by D1
    expect(r.mustNotImportFromModules).toEqual(["data"]);
    expect(r.bannedPackages).toEqual(["pg"]);
    const mid = getRulesForPath(ctx, "src/services/new.ts") as any;
    expect(mid.mustNotImportFromModules).toEqual(["ui"]);
    expect((getRulesForPath(ctx, "scripts/x.ts") as any).module).toBeNull();
  });

  it("check_import allows downward and blocks upward, denied and banned imports", () => {
    expect(checkImport(ctx, "src/ui/a.ts", "src/services/s.ts").allowed).toBe(true);
    expect(checkImport(ctx, "src/data/d.ts", "src/services/s.ts").allowed).toBe(false);
    const denied = checkImport(ctx, "src/ui/a.ts", "src/data/d.ts");
    expect(denied.allowed).toBe(false);
    expect(denied.problems.map((p) => p.rule)).toContain("D1");
    expect(checkImport(ctx, "src/ui/a.ts", "pg").allowed).toBe(false);
    expect(checkImport(ctx, "src/services/s.ts", "pg").allowed).toBe(true);
    expect(checkImport(ctx, "src/ui/a.ts", "@scope/lib").allowed).toBe(true);
  });

  it("check_change reports only introduced violations", () => {
    const ok = checkChange(ctx, [{ path: "src/ui/b.ts", content: `import "../services/s";` }]);
    expect(ok.ok).toBe(true);

    const bad = checkChange(ctx, [{ path: "src/data/d.ts", content: `import "../services/s";` }]);
    expect(bad.ok).toBe(false);
    expect(bad.introduced.map((v) => v.rule).sort()).toEqual(["C1", "L1"]);

    // Violations that already exist are not blamed on the new change.
    const dirty: ToolContext = { ...ctx, files: { ...files, "src/data/d.ts": `import "../services/s";` } };
    const unrelated = checkChange(dirty, [{ path: "src/ui/c.ts", content: `export {};` }]);
    expect(unrelated.ok).toBe(true);
    expect(unrelated.introduced).toEqual([]);
  });

  it("check_change handles deletes", () => {
    const res = checkChange(ctx, [{ path: "src/services/s.ts", content: null }]);
    expect(res.ok).toBe(true);
  });

  it("proposals are always pending and never approved", () => {
    const p = createProposal({ title: "Add notifications module", summary: "s", rationale: "r" }, new Date("2026-11-24T10:00:00Z"));
    expect(p.status).toBe("pending_approval");
    expect(p.approvedBy).toBeNull();
    expect(p.id).toBe("2026-11-24_add_notifications_module");
    expect(p.requestedBy).toBe("agent");
  });
});
