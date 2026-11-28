import { describe, expect, it } from "vitest";
import {
  applyEdits,
  buildGraphFromFiles,
  buildSetupFiles,
  checkArchitecture,
  inferArchitecture,
  isSourcePath,
  PROTECTED_FILES,
  type Architecture,
  type FileMap,
} from "@voxium/core";
import { checkPullRequest, draftSetup, planSetup, prepareSetup, unreadPaths } from "./analysis";
import { MAX_FORM_BYTES, parseEditForm, readForm, setupPrBody } from "./setup";
import { getSetupDraft, latestInference, saveAnalysis, saveSetupDraft, updateSetupDraft } from "./store";
import { database } from "./test-db";

const ARCH = "voxium/architecture.json";

/** ui > services > data, one import going up, a CLAUDE.md, and a file nothing imports that cannot be read. */
const FILES: FileMap = {
  "src/ui/Page.ts": `import "../services/s";`,
  "src/ui/Other.ts": "",
  "src/services/s.ts": `import "../data/d";`,
  "src/data/d.ts": `import "../ui/Other";`,
  "src/lib/x.ts": "",
  "CLAUDE.md": "# Mine\n",
};
const TREE = [...Object.keys(FILES), "public/huge.min.js"];

/** What setup wrote before there was a review, step by step as it did. */
function filesBeforeReview(files: FileMap, treePaths: string[], cliPackage?: string): Record<string, string> {
  const unread = unreadPaths(treePaths, files);
  const graph = buildGraphFromFiles({ ...files, ...Object.fromEntries(unread.map((p) => [p, ""])) }, { paths: treePaths });
  const inf = inferArchitecture(graph, { unread });
  const baseline = checkArchitecture(inf.architecture, graph).violations.filter((v) => v.severity === "block").map((v) => v.id);
  return buildSetupFiles({ arch: inf.architecture, baseline, existing: { "CLAUDE.md": files["CLAUDE.md"] }, cliPackage });
}

/** The draft with edits applied, made into the files of the setup pull request. */
function planWith(edits: Parameters<typeof applyEdits>[1], cliPackage?: string) {
  const draft = draftSetup(FILES, TREE);
  const result = applyEdits(draft.architecture, edits, TREE.filter(isSourcePath));
  if (!result.ok) throw new Error(result.errors.join(" "));
  return planSetup(result.architecture, draft.summary, FILES, TREE, cliPackage);
}

/** A check of a later pull request on a default branch that has these setup files merged. */
function laterCheck(setupFiles: Record<string, string>, headFiles = FILES, tree = TREE) {
  const rules = Object.fromEntries(PROTECTED_FILES.map((p) => [p, setupFiles[p] ?? null]));
  return checkPullRequest({ headFiles: { ...headFiles, ...setupFiles }, treePaths: [...tree, ...Object.keys(setupFiles)], base: rules, mergeBase: rules, head: rules });
}

describe("setup from a reviewed draft", () => {
  it("writes the files setup wrote before, when everything is accepted", () => {
    for (const cli of [undefined, "voxium@1.2.3"]) {
      const before = filesBeforeReview(FILES, TREE, cli);
      expect(JSON.parse(before[ARCH]).ignore).toEqual(["public/huge.min.js"]);
      expect(planWith({}, cli).setupFiles).toEqual(before);
      expect(prepareSetup(FILES, TREE, cli).setupFiles).toEqual(before);
    }
  });

  it("changes the files and the baseline when a module is rejected, the layers reordered or a path changed, and later checks pass", () => {
    const accepted = planWith({});
    expect(accepted.baselineCount).toBeGreaterThan(0);
    const variants = [
      planWith({ modules: { lib: { reject: true } } }),
      planWith({ layers: ["data", "services", "ui", "lib"].filter((l) => accepted.summary.layers.includes(l)) }),
      planWith({ modules: { ui: { paths: ["src/ui/Page.ts"] } } }),
    ];
    for (const plan of [accepted, ...variants]) {
      expect(laterCheck(plan.setupFiles)).toMatchObject({ state: "success", newViolations: [] });
    }
    expect(Object.keys(JSON.parse(variants[0].setupFiles[ARCH]).modules)).not.toContain("lib");
    for (const plan of variants) expect(plan.setupFiles[ARCH]).not.toBe(accepted.setupFiles[ARCH]);
    // Reordering and taking Other.ts out of ui each change which violations are debt.
    expect(variants[1].setupFiles["voxium/baseline.json"]).not.toBe(accepted.setupFiles["voxium/baseline.json"]);
    expect(variants[2].baselineCount).toBeLessThan(accepted.baselineCount);
    // And a new violation still fails.
    const worse = { ...FILES, "src/services/s.ts": `import "../data/d";\nimport "../ui/Page";` };
    expect(laterCheck(variants[2].setupFiles, worse).state).toBe("failure");
  });

  it("counts violations per rule and keeps no source code in the draft", () => {
    const draft = draftSetup(FILES, TREE);
    expect(draft.violations.LAYER01).toBeGreaterThan(0);
    expect(Object.keys(draft.violations)).toEqual(draft.architecture.rules.map((r) => r.id));
    const { unchecked, reasons, ...stored } = draft;
    expect(unchecked).toEqual([]);
    expect(reasons).toEqual({});
    for (const text of ['"../services/s"', "# Mine"]) expect(JSON.stringify(stored)).not.toContain(text);
  });

  it("plans the setup and checks later pull requests about as fast as the editor's budget says, for long globs it lets through", () => {
    const letters = (i: number, n: number) => Array.from({ length: n }, (_, j) => ((i >> j) & 1 ? "e" : "o")).join("");
    const files: FileMap = {
      ...Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`src/ui/components/feature${i % 10}/sub${i % 7}/Widget${i}.tsx`, ""])),
      "src/data/d.ts": `import "../ui/components/feature0/sub0/Widget0";`,
    };
    const tree = [...Object.keys(files), "public/huge.min.js"];
    const draft = draftSetup(files, tree);
    // 120 globs of 490 characters, which every file rules out by their plain text: cheap to match, once each is read.
    const globs = Array.from({ length: 120 }, (_, i) => `src/*${letters(i, 9)}${"q".repeat(480)}*`);
    const result = applyEdits(draft.architecture, { ignore: [...(draft.architecture.ignore ?? []), ...globs] }, tree.filter(isSourcePath));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Read again for each file, as the check did, planning took 8 seconds and so did every later check.
    let started = Date.now();
    const plan = planSetup(result.architecture, draft.summary, files, tree);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(plan.unchecked).toEqual([]);
    started = Date.now();
    const later = laterCheck(plan.setupFiles, files, tree);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(later.state).toBe("success");
  });
});

describe("reading the editor form", () => {
  const arch: Architecture = {
    version: 1,
    modules: { ui: { paths: ["src/ui/**"] }, data: { paths: ["src/data/**"] } },
    layers: ["ui", "data"],
    rules: [{ id: "L1", type: "layers", severity: "block", description: "d", rationale: "r" }],
    exceptions: [],
    ignore: ["dist/**"],
  };
  const unchanged: Array<[string, string]> = [
    ["m0.keep", "on"],
    ["m0.name", "ui"],
    ["m0.paths", "src/ui/**"],
    ["m1.keep", "on"],
    ["m1.name", "data"],
    ["m1.paths", "src/data/**\r\n"],
    ["l0.pos", "1"],
    ["l1.pos", "2"],
    ["r0.on", "on"],
    ["r0.severity", "block"],
    ["ignore", "dist/**"],
  ];
  const parse = (change: Record<string, string | null>) =>
    parseEditForm([...unchanged.filter(([k]) => !(k in change)), ...Object.entries(change).filter((e): e is [string, string] => e[1] !== null)], arch);

  it("reads an unchanged form as no edits, and each change as one", () => {
    expect(parse({})).toEqual({ ok: true, edits: {} });
    expect(parse({ "m1.keep": null, "m0.name": " view ", "m0.paths": "src/ui/**\n\nsrc/view/**", "l0.pos": "2", "l1.pos": "1", "r0.on": null, "r0.severity": "warn", ignore: "" })).toEqual({
      ok: true,
      edits: {
        modules: { ui: { rename: "view", paths: ["src/ui/**", "src/view/**"] }, data: { reject: true } },
        layers: ["data", "ui"],
        rules: { L1: { off: true, severity: "warn" } },
        ignore: [],
      },
    });
    // Two layers in the same place keep their order.
    expect(parse({ "l1.pos": "1" })).toEqual({ ok: true, edits: {} });
  });

  it("refuses fields it does not send, fields sent twice, files, and values it does not offer", () => {
    for (const bad of [
      [...unchanged, ["exceptions", "[]"]],
      [...unchanged, ["m2.keep", "on"]],
      [...unchanged, ["r0.on", "on"]],
      [...unchanged, ["__proto__", "x"]],
      [...unchanged.slice(1), ["m0.keep", new Blob(["on"])]],
    ] as Array<Array<[string, unknown]>>) {
      expect(parseEditForm(bad, arch).ok).toBe(false);
    }
    for (const pos of ["0", "3", "1.5", "x", ""]) expect(parse({ "l0.pos": pos }).ok).toBe(false);
    expect(parse({ "r0.severity": "off" }).ok).toBe(false);
    expect(parseEditForm([...unchanged, ["title", "t"]], arch, ["title"]).ok).toBe(true);
  });

  it("edits a module named like a property of every object", () => {
    const odd = JSON.parse(`{"version":1,"modules":{"__proto__":{"paths":["a/**"]},"b":{"paths":["b/**"]}},"layers":["__proto__","b"],"exceptions":[],"rules":[]}`) as Architecture;
    const form: Array<[string, string]> = [["m0.name", "__proto__"], ["m0.paths", "a/**"], ["m1.keep", "on"], ["m1.name", "b"], ["m1.paths", "b/**"]];
    const parsed = parseEditForm(form, odd);
    expect(parsed.ok && Object.hasOwn(parsed.edits.modules!, "__proto__")).toBe(true);
    const result = parsed.ok && applyEdits(odd, parsed.edits, ["a/x.ts", "b/y.ts"]);
    expect(result && result.ok && Object.keys(result.architecture.modules)).toEqual(["b"]);
    const kept = applyEdits(odd, {}, ["a/x.ts", "b/y.ts"]);
    expect(kept.ok && Object.keys(kept.architecture.modules)).toEqual(["__proto__", "b"]);
  });
});

describe("reading a form body", () => {
  const req = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://vx.test/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });

  it("reads a plain form", async () => {
    expect(await readForm(req("a=1&b=x%0Ay&a=2"))).toEqual([["a", "1"], ["b", "x\ny"], ["a", "2"]]);
  });

  it("refuses a body over the limit, whatever its length header says, and one that is not a plain form", async () => {
    expect(await readForm(req("a=" + "x".repeat(MAX_FORM_BYTES)))).toBeNull();
    expect(await readForm(req("a=xxxxxxxxxx", { "content-length": "3" }), 8)).toBeNull();
    expect(await readForm(req("a=1", { "content-length": String(MAX_FORM_BYTES + 1) }))).toBeNull();
    expect(await readForm(req("a=1", { "content-type": "multipart/form-data; boundary=x" }))).toBeNull();
    expect(await readForm(req("a=1", { "content-type": "text/plain" }))).toBeNull();
  });
});

describe("the setup pull request description", () => {
  it("shows names from the repository as code or plain text, never as Markdown, links or mentions", () => {
    const plan = { ...planWith({}), ignore: ["evil`](https://x.test) @team <b>.js"] };
    plan.summary = { ...plan.summary, layers: ["ui`<img>"] };
    const body = setupPrBody(plan, undefined, { counts: { accepted: 5, edited: 1, rejected: 2 }, warnings: ['Module "[x](https://y.test) @org/team" has no files.'] });
    expect(body).toContain("`evil'](https://x.test) @team <b>.js`");
    expect(body).toContain("`ui'<img>`");
    expect(body).toContain("5 part(s) accepted as inferred, 1 edited, 2 rejected");
    expect(body).toContain("\\[x\\](https:⁠//y.test) @⁠org/team");
  });
});

describe("stored drafts", () => {
  async function repo() {
    const { db, raw } = database();
    raw.exec(`INSERT INTO users (id, github_id, login) VALUES (1, 11, 'ann');
      INSERT INTO orgs (id, installation_id, account_login, account_type) VALUES (1, 1, 'acme', 'Organization');
      INSERT INTO repos (id, org_id, github_repo_id, full_name, default_branch) VALUES (5, 1, 55, 'acme/a', 'main');`);
    return db;
  }

  it("keeps one draft a repo, and replaces it only while it is the one that was read", async () => {
    const db = await repo();
    expect(await getSetupDraft(db, 5)).toBeNull();
    await saveSetupDraft(db, { repo_id: 5, user_id: 1, commit_sha: "a", draft_json: "{}" });
    await saveSetupDraft(db, { repo_id: 5, user_id: 1, commit_sha: "b", draft_json: `{"x":1}` });
    expect(await getSetupDraft(db, 5)).toMatchObject({ repo_id: 5, commit_sha: "b", draft_json: `{"x":1}` });
    expect(await updateSetupDraft(db, 5, "{}", `{"y":1}`)).toBe(false);
    expect(await updateSetupDraft(db, 5, `{"x":1}`, `{"y":1}`)).toBe(true);
    expect(await updateSetupDraft(db, 5, `{"x":1}`, `{"z":1}`)).toBe(false);
    expect((await getSetupDraft(db, 5))?.draft_json).toBe(`{"y":1}`);
  });

  it("finds the latest inference behind any number of checks", async () => {
    const db = await repo();
    await saveAnalysis(db, { repo_id: 5, kind: "inference", summary: { n: 1 } });
    await saveAnalysis(db, { repo_id: 5, kind: "inference", summary: { n: 2 } });
    for (let i = 0; i < 25; i++) await saveAnalysis(db, { repo_id: 5, kind: "pr_check", pr_number: i, summary: {} });
    expect(JSON.parse((await latestInference(db, 5))!.summary_json)).toEqual({ n: 2 });
  });

  it("reads the latest inference through an index, not through every analysis of the repo", () => {
    const { raw } = database();
    const plan = (raw.prepare("EXPLAIN QUERY PLAN SELECT * FROM analyses WHERE repo_id = ? AND kind = 'inference' ORDER BY id DESC LIMIT 1").all(5) as Array<{ detail: string }>).map((r) => r.detail);
    expect(plan.join("\n")).toMatch(/USING INDEX idx_analyses_repo_kind \(repo_id=\? AND kind=\?\)/);
    expect(plan.join("\n")).not.toMatch(/TEMP B-TREE/);
  });
});
