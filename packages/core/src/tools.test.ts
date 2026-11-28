import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveProposal } from "./node.js";
import {
  checkChange,
  checkImport,
  createProposal,
  MAX_PROPOSAL_BYTES,
  parseProposal,
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

  it("check_import sees through a target outside every module", () => {
    const c: ToolContext = { ...ctx, files: { ...files, "src/bridge.ts": `export * from "./ui/a";` } };
    const res = checkImport(c, "src/data/d.ts", "src/bridge.ts");
    expect(res.allowed).toBe(false);
    expect(res.problems[0].message).toMatch(/outside every module/);
    expect(checkImport(c, "src/ui/a.ts", "src/bridge.ts").allowed).toBe(true);
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

  it("check_change points a cycle at the import the change adds", () => {
    const layerless: Architecture = { ...arch, layers: [], rules: arch.rules.filter((r) => r.id === "C1") };
    const old = { "src/ui/a.ts": "", "src/data/d.ts": `import "../ui/a";`, "src/x.ts": "" };
    const at = (files: Record<string, string>, path: string, content: string) =>
      checkChange({ arch: layerless, files, baseline: [] }, [{ path, content }]).introduced.map((v) => v.file);
    expect(at(old, "src/ui/a.ts", `import "../data/d";`)).toEqual(["src/ui/a.ts"]);
    expect(at({ ...old, "src/ui/a.ts": `import "../data/d";`, "src/data/d.ts": "" }, "src/data/d.ts", `import "../ui/a";`)).toEqual(["src/data/d.ts"]);
    // In a file that already imported another module.
    expect(at({ ...old, "src/ui/a.ts": `import "../services/s";`, "src/services/s.ts": "" }, "src/ui/a.ts", `import "../services/s"; import "../data/d";`)).toEqual(["src/ui/a.ts"]);
    // Through a file outside the modules, whose own new import is what closes it.
    expect(at({ ...old, "src/ui/a.ts": `import "../x";` }, "src/x.ts", `import "./data/d";`)).toEqual(["src/ui/a.ts"]);
  });

  it("check_change does not blame a change for what it leaves of a cycle", () => {
    const layerless: Architecture = { ...arch, layers: [], rules: arch.rules.filter((r) => r.id === "C1") };
    const all = { "src/ui/a.ts": `import "../services/s";`, "src/services/s.ts": `import "../ui/a"; import "../data/d";`, "src/data/d.ts": `import "../services/s";` };
    for (const baseline of [[], ["C1:data+services+ui"]]) {
      const c: ToolContext = { arch: layerless, files: all, baseline };
      expect(checkChange(c, [{ path: "src/data/d.ts", content: "" }])).toMatchObject({ ok: true, introduced: [] });
      const worse = checkChange(c, [{ path: "src/services/s.ts", content: `import "../data/d";` }, { path: "src/ui/a.ts", content: "" }]);
      expect(worse.ok).toBe(true); // services and data are left
      const ring = { "src/ui/a.ts": `import "../services/s";`, "src/services/s.ts": `import "../data/d";`, "src/data/d.ts": `import "../ui/a";` };
      const turned = checkChange({ ...c, files: ring }, [{ path: "src/services/s.ts", content: `import "../ui/a";` }]);
      expect(turned.introduced.map((v) => [v.rule, v.file])).toEqual([["C1", "src/services/s.ts"]]);
    }
  });

  it("check_change accepts debt that is in the baseline, also when the code does not have it now", () => {
    const c: ToolContext = { ...ctx, baseline: ["C1:data+services", "L1:src/data/d.ts->src/services/s.ts"] };
    expect(checkChange(c, [{ path: "src/data/d.ts", content: `import "../services/s";` }])).toMatchObject({ ok: true, introduced: [] });
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

describe("agent tools with the aliases of the rules", () => {
  const aliased: ToolContext = { arch: { ...arch, aliases: { "@ui/*": ["src/ui/*"], "@data/*": ["src/data/*"] } }, files: { ...files, "src/shared/x.ts": `import "@ui/a";` }, baseline: [] };

  it("check_change sees an import by an alias, as CI does, before and after the change", () => {
    const res = checkChange(aliased, [{ path: "src/data/d.ts", content: `import "@ui/a";` }]);
    expect(res.ok).toBe(false);
    expect(res.introduced.map((v) => v.rule).sort()).toEqual(["C1", "L1"]);
    // An import by an alias that was already there is not blamed on the change.
    const before: ToolContext = { ...aliased, files: { ...aliased.files, "src/ui/b.ts": `import "@data/d";` }, baseline: ["D1:src/ui/b.ts->src/data/d.ts", "L1:src/ui/b.ts->src/data/d.ts"] };
    expect(checkChange(before, [{ path: "src/ui/b.ts", content: `import "@data/d"; export const b = 1;` }]).introduced).toEqual([]);
  });

  it("check_import follows a file outside every module through the aliases it imports by", () => {
    const res = checkImport(aliased, "src/data/new.ts", "src/shared/x.ts");
    expect(res.allowed).toBe(false);
    expect(res.problems.map((p) => p.rule)).toContain("L1");
    expect(checkImport({ ...aliased, arch }, "src/data/new.ts", "src/shared/x.ts").allowed).toBe(true);
  });
});

describe("proposals", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  const base = { title: "Split billing", summary: "Move billing out of services", rationale: "It grew too large" };
  const exception = { rule: "L1", file: "src/data/d.ts", owner: "ann", reason: "Until the split", expires: "2027-01-01" };

  it("carry a validated architecture or exception, and nothing else of the input", () => {
    const p = createProposal({ ...base, architecture: arch, acceptDebt: true }, now);
    expect(p.change).toEqual({ architecture: arch, acceptDebt: true });
    const e = createProposal({ ...base, exception: { ...exception, extra: "x" } as never }, now);
    expect(e.change).toEqual({ exception });
    expect(createProposal(base, now).change).toBeNull();
  });

  it.each<[string, object]>([
    ["an invalid architecture", { architecture: { ...arch, layers: ["nope"] } }],
    ["an exception without an expiry", { exception: { ...exception, expires: "soon" } }],
    ["both kinds of change", { architecture: arch, exception }],
    ["an empty title", { title: " \n " }],
    ["a title that is not text", { title: 5 }],
    ["a rationale that is too long", { rationale: "x".repeat(4001) }],
    ["acceptDebt that is not a boolean", { acceptDebt: "yes" }],
    ["an architecture that makes the file too large", { architecture: { ...arch, ignore: Array.from({ length: 4000 }, (_, i) => `gen/${i}/**`) } }],
  ])("refuse %s", (_n, over) => {
    expect(() => createProposal({ ...base, ...over } as never, now)).toThrow(/not valid/);
  });

  it("keep a title on one line and drop invisible characters", () => {
    const p = createProposal({ ...base, title: "Split\n# billing\u202e", rationale: "Line one\r\nLine two\u0000" }, now);
    expect(p.title).toBe("Split # billing");
    expect(p.rationale).toBe("Line one\nLine two");
  });

  it("read back what createProposal writes, but never its status or approver", () => {
    const p = createProposal({ ...base, exception, requestedBy: "agent" }, now);
    const text = JSON.stringify({ ...p, status: "approved", approvedBy: "lead" });
    expect(parseProposal(text)).toEqual({ ok: true, proposal: { title: p.title, summary: p.summary, rationale: p.rationale, suggestedChange: null, change: { exception } } });
  });

  it.each<[string, string]>([
    ["text larger than the limit", JSON.stringify({ ...base, summary: "x".repeat(MAX_PROPOSAL_BYTES) })],
    ["deeply nested JSON", `${"[".repeat(5000)}${"]".repeat(5000)}`],
    ["deep JSON inside a change", JSON.stringify({ ...base, change: { architecture: JSON.parse(`${"{\"a\":".repeat(40)}1${"}".repeat(40)}`) } })],
    ["broken JSON", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["fields of the wrong type", JSON.stringify({ ...base, summary: ["x"] })],
    ["a missing rationale", JSON.stringify({ title: "t", summary: "s" })],
    ["unknown kinds of change", JSON.stringify({ ...base, change: { approve: true } })],
    ["a change that is not an object", JSON.stringify({ ...base, change: "merge" })],
    ["an invalid architecture", JSON.stringify({ ...base, change: { architecture: { version: 2 } } })],
  ])("are not read from %s", (_n, text) => {
    expect(parseProposal(text).ok).toBe(false);
  });

  it("keep an exception's fields on one line, without invisible characters, and within limits", () => {
    const p = createProposal({ ...base, exception: { ...exception, file: "src/\u202estd.ycagel/**", reason: "why\u202e\u0007 it\nis needed", owner: " ann\u200b " } }, now);
    expect(p.change?.exception).toEqual({ ...exception, file: "src/std.ycagel/**", reason: "why it is needed", owner: "ann" });
    expect(() => createProposal({ ...base, exception: { ...exception, owner: "\u202e\u0007" } }, now)).toThrow(/"owner" must not be empty/);
    expect(() => createProposal({ ...base, exception: { ...exception, file: "x".repeat(1001) } }, now)).toThrow(/"file" may have at most 1000/);
    const read = parseProposal(JSON.stringify({ ...base, change: { exception: { ...exception, rule: "L1\u202e" } } }));
    expect(read).toMatchObject({ ok: true, proposal: { change: { exception: { rule: "L1" } } } });
  });

  it("clean the exceptions of a whole architecture the same way", () => {
    const dirty = { rule: "L1", file: "src/‮sts.ycagel/**", owner: "dev\u0007", reason: "why‮\u0007 it\nis needed", expires: "2099-01-01" };
    const p = createProposal({ ...base, architecture: { ...arch, exceptions: [exception, dirty] } }, now);
    expect(p.change?.architecture?.exceptions).toEqual([exception, { ...dirty, file: "src/sts.ycagel/**", owner: "dev", reason: "why it is needed" }]);
    expect(JSON.stringify(p)).not.toMatch(/[‮\u0007]/);
    // The rest of the architecture is kept as it was given.
    expect({ ...p.change?.architecture, exceptions: [] }).toEqual(arch);
    expect(() => createProposal({ ...base, architecture: { ...arch, exceptions: [{ ...dirty, owner: "​\u0007" }] } }, now)).toThrow(/architecture: exception 1: "owner" must not be empty/);
    expect(() => createProposal({ ...base, architecture: { ...arch, exceptions: [{ ...dirty, reason: "x".repeat(4001) }] } }, now)).toThrow(/"reason" may have at most 4000/);
    const read = parseProposal(JSON.stringify({ ...base, change: { architecture: { ...arch, exceptions: [dirty] } } }));
    expect(read.ok && read.proposal.change?.architecture?.exceptions[0].file).toBe("src/sts.ycagel/**");
  });

  it("are read up to sixteen levels deep, and not one more", () => {
    const nested = (levels: number) => JSON.stringify({ ...base, extra: JSON.parse(`${"[".repeat(levels)}${"]".repeat(levels)}`) });
    expect(parseProposal(nested(15)).ok).toBe(true);
    expect(parseProposal(nested(16))).toEqual({ ok: false, error: "The proposal is not valid: it nests more than 16 levels deep." });
  });

  it("does not count brackets inside strings as nesting", () => {
    expect(parseProposal(JSON.stringify({ ...base, rationale: "[[[[[[[[[[[[[[[[[[[[[[[[[[\\\"{{{{{{{{{{{{{{{{{{{{" })).ok).toBe(true);
  });

  describe("saved by the CLI and the MCP server", () => {
    const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "voxium-proposal-"));

    it("never replace a proposal with the same title from the same day", () => {
      const root = tmp();
      const p = createProposal(base, now);
      const first = saveProposal(root, p);
      const second = saveProposal(root, { ...p, summary: "Another" });
      expect([first.id, second.id]).toEqual(["2026-11-24_split_billing", "2026-11-24_split_billing_2"]);
      expect(JSON.parse(fs.readFileSync(path.join(root, first.path), "utf8")).summary).toBe(base.summary);
      expect(JSON.parse(fs.readFileSync(path.join(root, second.path), "utf8"))).toMatchObject({ id: second.id, summary: "Another" });
      fs.rmSync(root, { recursive: true });
    });

    it("refuse to write through a symlinked folder", () => {
      const root = tmp();
      const outside = tmp();
      fs.mkdirSync(path.join(root, "voxium"));
      fs.symlinkSync(outside, path.join(root, "voxium/proposals"));
      expect(() => saveProposal(root, createProposal(base, now))).toThrow(/must be a folder/);
      expect(fs.readdirSync(outside)).toEqual([]);
      fs.rmSync(root, { recursive: true });
      fs.rmSync(outside, { recursive: true });
    });
  });
});

describe("agent tools with convention rules", () => {
  const conv: Architecture = {
    ...arch,
    rules: [
      ...arch.rules,
      { id: "N1", type: "naming", module: "*", files: "src/**", style: "kebab", description: "d", rationale: "r", severity: "block" },
      { id: "P1", type: "placement", files: "**/*.repo.ts", modules: ["data"], description: "d", rationale: "r", severity: "warn" },
      { id: "A1", type: "public_api", module: "data", entries: ["src/data/index.ts"], description: "d", rationale: "r", severity: "block" },
      { id: "A2", type: "public_api", module: "services", entries: ["src/services/index.ts"], description: "d", rationale: "r", severity: "block" },
      { id: "E2", type: "deny_external", module: "*", except: ["data"], packages: ["mysql"], description: "d", rationale: "r", severity: "block" },
    ],
  };
  const convFiles = { ...files, "src/services/index.ts": `export * from "./s";`, "src/data/index.ts": `export * from "./d";` };
  const c: ToolContext = { arch: conv, files: convFiles, baseline: [] };

  it("get_rules_for_path gives the naming style, the allowed places and the entries of importable modules", () => {
    const r = getRulesForPath(c, "src/ui/UserCard.repo.ts") as any;
    expect(r.naming).toEqual([{ rule: "N1", severity: "block", style: "kebab-case", ok: false }]);
    expect(r.placement).toEqual([{ rule: "P1", severity: "warn", allowedModules: ["data"], ok: false }]);
    expect(r.entriesOfModules).toEqual({ services: ["src/services/index.ts"] }); // data is denied to ui by D1
    expect(r.bannedPackages).toEqual(["pg", "mysql"]);
    const s = getRulesForPath(c, "src/services/x.ts") as any;
    expect(s.entriesOfModules).toEqual({ data: ["src/data/index.ts"] });
    expect(s.naming[0].ok).toBe(true);
    expect((getRulesForPath(c, "src/data/x.ts") as any).bannedPackages).toEqual([]);
    const outside = getRulesForPath(c, "src/Loose.repo.ts") as any;
    expect(outside.module).toBeNull();
    expect(outside.placement[0].ok).toBe(false);
    expect(outside.naming[0].ok).toBe(false);
  });

  it("check_import refuses a file that is not an entry and names the entry to use", () => {
    expect(checkImport(c, "src/ui/a.ts", "src/services/index.ts").allowed).toBe(true);
    const res = checkImport(c, "src/ui/a.ts", "src/services/s.ts");
    expect(res.allowed).toBe(false);
    expect(res.problems.map((p) => p.rule)).toEqual(["A2"]);
    expect(res.problems[0].fix).toContain("src/services/index.ts");
    expect(res.useInstead).toEqual(["src/services/index.ts"]);
    // Through a file outside the modules as well.
    const around: ToolContext = { ...c, files: { ...convFiles, "src/lib/hop.ts": `export * from "../services/s";` } };
    expect(checkImport(around, "src/ui/a.ts", "src/lib/hop.ts").problems.map((p) => p.rule)).toEqual(["A2"]);
  });

  it("check_import is about the import, not about the names of the files", () => {
    const res = checkImport(c, "src/ui/BadName.ts", "src/services/index.ts");
    expect(res).toMatchObject({ allowed: true, problems: [] });
  });

  it("check_change reports a new file with a bad name, in the wrong place or importing past an entry", () => {
    const res = checkChange(c, [
      { path: "src/ui/NewCard.ts", content: `import "../services/s";` },
      { path: "src/ui/user.repo.ts", content: "" },
    ]);
    expect(res.ok).toBe(false);
    expect(res.introduced.map((v) => v.rule).sort()).toEqual(["A2", "N1", "P1"]);
    expect(checkChange(c, [{ path: "src/ui/new-card.ts", content: `import "../services/index";` }]).ok).toBe(true);
    // A warning alone does not fail it.
    expect(checkChange(c, [{ path: "src/ui/user.repo.ts", content: "" }])).toMatchObject({ ok: true, introduced: [{ rule: "P1", severity: "warn" }] });
  });
});
