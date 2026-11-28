import { describe, expect, it } from "vitest";
import { assignModules, buildGraphFromFiles, buildSnapshot, checkArchitecture, MAX_SNAPSHOT_BYTES, moduleDependencies, type Architecture } from "./index.js";

const rule = { severity: "block" as const, description: "d", rationale: "r" };
const arch: Architecture = {
  version: 1,
  modules: { ui: { paths: ["src/ui/**"] }, "<b>svc</b>": { paths: ["src/services/**"] }, data: { paths: ["src/data/**"] }, tools: { paths: ["tools/**"] } },
  layers: ["ui", "<b>svc</b>", "data"],
  rules: [
    { id: "L1", type: "layers", ...rule },
    { id: "D1", type: "deny_dependency", from: "ui", to: "data", ...rule },
    { id: "W1", type: "deny_dependency", from: "tools", to: "ui", ...rule, severity: "warn" },
  ],
  exceptions: [
    { rule: "L1", file: "src/data/legacy.ts", owner: "dev", reason: "Until the move", expires: "2099-01-01" },
    { rule: "L1", file: "src/data/old.ts", owner: "dev", reason: "Old", expires: "2020-01-01" },
  ],
};
const files = {
  "src/ui/page.ts": `import "../services/s"; import "../data/d"; // SECRET_TOKEN=abc`,
  "src/services/s.ts": `import "../data/d";`,
  "src/data/d.ts": `export {};`,
  "src/data/up.ts": `import "../ui/page";`,
  "src/data/up2.ts": `import "../services/s"; import "../ui/page";`,
  "src/data/legacy.ts": `import "../ui/page";`,
  "tools/t.ts": `import "../src/ui/page";`,
};
const graph = buildGraphFromFiles(files);
const result = checkArchitecture(arch, graph, { baseline: ["L1:src/data/up.ts->src/ui/page.ts"], today: new Date("2026-11-27") });
const snap = buildSnapshot(arch, graph, result, new Date("2026-11-27"));

describe("a snapshot", () => {
  it("has the edges moduleDependencies gives, with those the rules forbid", () => {
    const modOf = assignModules(arch, graph.files);
    const pairs = new Map<string, number>();
    for (const d of moduleDependencies(graph, modOf)) if (d.toMod && d.toMod !== d.fromMod) pairs.set(`${d.fromMod}>${d.toMod}`, (pairs.get(`${d.fromMod}>${d.toMod}`) ?? 0) + 1);
    expect(Object.fromEntries(snap.edges.map((e) => [`${e.from}>${e.to}`, e.imports]))).toEqual(Object.fromEntries(pairs));
    expect(Object.fromEntries(snap.edges.map((e) => [`${e.from}>${e.to}`, e.violating]))).toEqual({
      "ui><b>svc</b>": 0, "ui>data": 1, "<b>svc</b>>data": 0, "data>ui": 3, "data><b>svc</b>": 1, "tools>ui": 1, // a rule that only warns forbids it too
    });
    expect(snap.edges[0]).toMatchObject({ from: "data", to: "ui", violating: 3 });
  });

  it("counts violations by rule and module, and lists exceptions by expiry", () => {
    expect(snap.modules).toEqual([
      { name: "ui", files: 1, layer: 0, debt: 0 },
      { name: "<b>svc</b>", files: 1, layer: 1, debt: 0 },
      { name: "data", files: 4, layer: 2, debt: 1 },
      { name: "tools", files: 1, layer: null, debt: 0 },
    ]);
    expect(snap.rules.find((r) => r.id === "L1")).toMatchObject({ new: 2, baseline: 1, excepted: 1, warn: 0 });
    expect(snap.rules.find((r) => r.id === "D1")).toMatchObject({ new: 1 });
    expect(snap.rules.find((r) => r.id === "W1")).toMatchObject({ warn: 1, new: 0 });
    expect(snap.totals).toMatchObject({ files: 7, modules: 4, new: 3, baseline: 1, excepted: 1, warn: 1 });
    expect(snap.exceptions.map((e) => [e.file, e.expired])).toEqual([["src/data/old.ts", true], ["src/data/legacy.ts", false]]);
    expect(snap.truncated).toBe(false);
  });

  it("holds no code, message or reason, and is the same every time", () => {
    const text = JSON.stringify(snap);
    for (const v of result.violations) expect(text).not.toContain(v.message);
    expect(text).not.toContain("SECRET_TOKEN");
    expect(text).not.toContain('import "');
    expect(text).not.toContain("Until the move");
    expect(JSON.stringify(buildSnapshot(arch, graph, result, new Date("2026-11-27")))).toBe(text);
  });

  it("stays within its size, keeping the totals and the edges that break rules first", () => {
    const names = Array.from({ length: 120 }, (_, i) => `module_with_a_long_name_${i}`);
    const big: Architecture = { version: 1, modules: Object.fromEntries(names.map((n) => [n, { paths: [`src/${n}/**`] }])), layers: names, rules: [{ id: "L1", type: "layers", ...rule }], exceptions: [] };
    const code = Object.fromEntries(names.map((n) => [`src/${n}/a.ts`, names.map((m) => `import "../${m}/a";`).join("\n")]));
    const g = buildGraphFromFiles(code);
    const s = buildSnapshot(big, g, checkArchitecture(big, g));
    expect(new TextEncoder().encode(JSON.stringify(s)).length).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect(s.truncated).toBe(true);
    expect(s.totals.edges).toBe(120 * 119);
    expect(s.edges.length).toBeGreaterThan(100);
    expect(s.edges.every((e) => e.violating > 0)).toBe(true);
    // Very long names are no way past the limit: then only the totals are kept.
    const long = Array.from({ length: 150 }, (_, i) => `m${i}_${"x".repeat(20_000)}`);
    const wide: Architecture = { version: 1, modules: Object.fromEntries(long.map((n, i) => [n, { paths: [`src/m${i}/**`] }])), layers: [], rules: [], exceptions: [] };
    const w = buildGraphFromFiles({ "src/m0/a.ts": "" });
    const t = buildSnapshot(wide, w, checkArchitecture(wide, w));
    expect(new TextEncoder().encode(JSON.stringify(t)).length).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect(t).toMatchObject({ truncated: true, modules: [], totals: { modules: 150 } });
  });
});
