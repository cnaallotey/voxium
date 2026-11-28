import { describe, expect, it } from "vitest";
import {
  applyEdits,
  applyTemplate,
  buildGraphFromFiles,
  checkArchitecture,
  detectFrameworks,
  globCost,
  globWork,
  MAX_GLOB_WORK,
  inferArchitecture,
  uncheckedPaths,
  isTemplateName,
  matchesGlob,
  TEMPLATE_NAMES,
  validateArchitecture,
  type Architecture,
  type FileMap,
  type TemplateName,
} from "./index.js";

const files = (paths: string[], body = ""): FileMap => Object.fromEntries(paths.map((p) => [p, body]));

/** ui imports services imports data, three times, and data once imports ui. */
const APP: FileMap = {
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/ui/page${i}.ts`, `import "../services/s${i % 3}";`])),
  "src/services/s0.ts": `import "../data/d0";`,
  "src/services/s1.ts": `import "../data/d0";`,
  "src/services/s2.ts": `import "../data/d0";`,
  "src/data/d0.ts": "",
  "src/data/d1.ts": `import "../ui/page0";`,
};

describe("inferred proposals", () => {
  const res = inferArchitecture(buildGraphFromFiles(APP));

  it("rates every module, layer and rule once, in the order of the architecture", () => {
    const arch = res.architecture;
    expect(res.proposals.filter((p) => p.kind === "module").map((p) => p.name)).toEqual(Object.keys(arch.modules));
    expect(res.proposals.filter((p) => p.kind === "layer").map((p) => p.name)).toEqual(arch.layers);
    expect(res.proposals.filter((p) => p.kind === "rule").map((p) => p.name)).toEqual(arch.rules.map((r) => r.id));
    for (const p of res.proposals) {
      expect(p.confidence).toBeGreaterThanOrEqual(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
      expect(p.evidence).toMatch(/\.$/);
    }
    // The fields that were there before stay.
    expect(res).toMatchObject({ confidence: expect.any(Number), notes: expect.any(Array), existingViolations: expect.any(Number) });
  });

  it("bases a module on its file count and a layer on the share of imports that go down the order", () => {
    expect(res.architecture.layers).toEqual(["ui", "services", "data"]);
    const of = (kind: string, name: string) => res.proposals.find((p) => p.kind === kind && p.name === name)!;
    expect(of("module", "ui")).toMatchObject({ confidence: 1, evidence: "12 source file(s) match src/ui/**." });
    expect(of("module", "data").confidence).toBe(0.2);
    // ui-services: 12 down. services-data: 3 down. data-ui: 1 up.
    expect(of("layer", "services")).toMatchObject({ confidence: 1, evidence: "15 of 15 import(s) between services and other layers go down the order." });
    expect(of("layer", "data").confidence).toBe(0.75);
    expect(of("rule", "LAYER01")).toMatchObject({ confidence: 0.94, evidence: expect.stringContaining("1 violation(s) in 1 file(s)") });
  });

  it("names the frameworks package.json depends on, and says when it cannot be read", () => {
    const pkg = (deps: object) => JSON.stringify({ dependencies: deps, devDependencies: { vite: "5" } });
    expect(detectFrameworks(pkg({ next: "14", express: "4", "@nestjs/core": "10" }))).toEqual(["next", "express", "nest", "vite"]);
    expect(detectFrameworks(JSON.stringify({ dependencies: { nuxt: "3" } }))).toEqual(["nuxt"]);
    expect(detectFrameworks("{}")).toEqual([]);
    for (const bad of ["{", "[]", "null", "3"]) expect(detectFrameworks(bad)).toBeNull();
    const graph = buildGraphFromFiles(APP);
    expect(inferArchitecture(graph, { packageJson: pkg({ next: "14" }) })).toMatchObject({
      frameworks: ["next", "vite"],
      notes: expect.arrayContaining(["package.json uses next, vite. A template fits it: next."]),
    });
    expect(inferArchitecture(graph, { packageJson: "{" }).notes).toContain("The root package.json could not be read, so no framework was detected.");
    expect(inferArchitecture(graph).frameworks).toEqual([]);
  });
});

/** A small repo laid out the way each template expects, with some folders the template does not know. */
const FIXTURES: Record<TemplateName, string[]> = {
  layered: ["src/controllers/user.ts", "src/services/user.ts", "src/domain/user.ts", "src/repositories/user.ts", "src/utils/id.ts", "src/odd/x.ts"],
  hexagonal: ["src/adapters/http.ts", "src/application/create.ts", "src/ports/repo.ts", "src/domain/order.ts", "src/shared/id.ts"],
  feature_sliced: [
    "src/app/index.tsx",
    "src/pages/home/index.tsx",
    "src/widgets/header/index.ts",
    "src/widgets/header/ui.tsx",
    "src/features/login/index.ts",
    "src/entities/user/index.ts",
    "src/shared/api.ts",
  ],
  modular_monolith: ["src/main.ts", "src/app/server.ts", "src/modules/billing/index.ts", "src/modules/billing/charge.ts", "src/modules/users/index.ts", "src/shared/log.ts"],
  next: ["app/page.tsx", "app/api/route.ts", "components/button.tsx", "hooks/use-user.ts", "lib/db.ts", "types/user.ts", "dist/app.js"],
  nuxt: ["pages/index.vue", "layouts/default.vue", "components/Card.vue", "composables/useUser.ts", "stores/user.ts", "server/api/user.ts", "utils/date.ts"],
};

describe("templates", () => {
  it.each(TEMPLATE_NAMES.map((n) => [n]))("%s gives a valid architecture for its fixture, with only modules that match a file", (name) => {
    const paths = FIXTURES[name];
    const arch = applyTemplate(name, paths);
    expect(validateArchitecture(arch).errors).toEqual([]);
    expect(Object.keys(arch.modules).length).toBeGreaterThan(1);
    expect(arch.layers).toEqual(Object.keys(arch.modules));
    for (const def of Object.values(arch.modules)) {
      for (const glob of def.paths) expect(paths.some((p) => matchesGlob(p, glob))).toBe(true);
    }
    for (const r of arch.rules) expect(r.rationale.length).toBeGreaterThan(10);
    // Pure: the same files give the same architecture, whatever their order.
    expect(applyTemplate(name, [...paths].reverse())).toEqual(arch);
    // Checking the fixture with it works.
    expect(() => checkArchitecture(arch, buildGraphFromFiles(files(paths)))).not.toThrow();
  });

  it("leaves out modules no file matches, and committed build output", () => {
    const arch = applyTemplate("next", FIXTURES.next);
    expect(Object.keys(arch.modules)).toEqual(["app", "components", "hooks", "lib", "types"]);
    expect(arch.ignore).toContain("dist/**");
    expect(Object.keys(applyTemplate("layered", ["src/services/a.ts", "src/domain/b.ts"]).modules)).toEqual(["application", "domain"]);
    expect(applyTemplate("hexagonal", ["README.ts"]).modules).toEqual({});
  });

  it("adds the rules each template is known for", () => {
    const ids = (n: TemplateName) => applyTemplate(n, FIXTURES[n]).rules.map((r) => r.id);
    expect(ids("feature_sliced")).toEqual(expect.arrayContaining(["API_WIDGETS", "API_FEATURES", "API_ENTITIES"]));
    expect(ids("modular_monolith")).toEqual(expect.arrayContaining(["API_BILLING", "API_USERS"]));
    expect(ids("nuxt")).toEqual(expect.arrayContaining(["SERVER_PAGES", "SERVER_COMPONENTS"]));
    // A slice is used through its index file only.
    const fsd = applyTemplate("feature_sliced", FIXTURES.feature_sliced);
    const graph = buildGraphFromFiles({ ...files(FIXTURES.feature_sliced), "src/pages/home/index.tsx": `import "../../widgets/header/ui";` });
    expect(checkArchitecture(fsd, graph).violations.map((v) => v.ruleId)).toContain("API_WIDGETS");
  });

  it("keeps each folder of a modular monolith to itself, whatever it is called", () => {
    const starred = applyTemplate("modular_monolith", ["src/modules/*/x.ts", "src/modules/billing/y.ts", "src/modules/users/z.ts"]);
    expect(Object.values(starred.modules).map((m) => m.paths)).toEqual([["src/modules/billing/**"], ["src/modules/users/**"]]);
    expect(Object.values(starred.modules).flatMap((m) => m.paths).some((g) => g.includes("*/"))).toBe(false);
    const clash = applyTemplate("modular_monolith", ["modules/src_modules_a_b/x.ts", "src/modules/a-b/x.ts", "src/modules/a_b/y.ts", "src/modules/a_b_2/z.ts"]);
    expect(Object.fromEntries(Object.entries(clash.modules).map(([n, m]) => [n, m.paths]))).toEqual({
      src_modules_a_b: ["modules/src_modules_a_b/**"],
      a_b: ["src/modules/a_b/**"],
      src_modules_a_b_2: ["src/modules/a-b/**"],
      a_b_2: ["src/modules/a_b_2/**"],
    });
    expect(validateArchitecture(clash).errors).toEqual([]);
  });

  it("refuses a name that is not a template", () => {
    expect(isTemplateName("layered")).toBe(true);
    for (const bad of ["Layered", "__proto__", "", 3, null]) expect(isTemplateName(bad)).toBe(false);
    expect(() => applyTemplate("mvc" as TemplateName, [])).toThrow(/Unknown template "mvc"/);
  });
});

describe("editing a draft", () => {
  const draft = inferArchitecture(buildGraphFromFiles(APP)).architecture;
  const paths = Object.keys(APP);
  const edit = (edits: Parameters<typeof applyEdits>[1], list: string[] | undefined = paths) => applyEdits(draft, edits, list);
  const arch = (edits: Parameters<typeof applyEdits>[1]) => {
    const r = edit(edits);
    if (!r.ok) throw new Error(r.errors.join(" "));
    return r.architecture;
  };

  it("gives back the same architecture, field for field, when everything is accepted", () => {
    const r = edit({});
    expect(r.ok && JSON.stringify(r.architecture)).toBe(JSON.stringify(draft));
    expect(r.ok && r.counts).toEqual({ accepted: 3 + 1 + draft.rules.length, edited: 0, rejected: 0 });
    // Edits that say what is already there count as accepted.
    const same = edit({ modules: { ui: { paths: ["src/ui/**"] } }, layers: [...draft.layers], rules: { LAYER01: { severity: "block" } } });
    expect(same.ok && JSON.stringify(same.architecture)).toBe(JSON.stringify(draft));
    expect(same.ok && same.counts.edited).toBe(0);
  });

  it("rejects, renames and re-paths modules, and follows them in the layers and the rules", () => {
    const withDep: Architecture = {
      ...draft,
      rules: [...draft.rules, { id: "D1", type: "deny_dependency", from: "data", to: "ui", severity: "block", description: "d", rationale: "r" }],
    };
    const r = applyEdits(withDep, { modules: { services: { reject: true }, data: { rename: "storage", paths: ["src/data/**", "src/db/**"] } } }, paths);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Modules keep their place, which decides which one a file belongs to.
    expect(Object.keys(r.architecture.modules)).toEqual(Object.keys(draft.modules).filter((m) => m !== "services").map((m) => (m === "data" ? "storage" : m)));
    expect(r.architecture.modules.storage.paths).toEqual(["src/data/**", "src/db/**"]);
    expect(r.architecture.layers).toEqual(["ui", "storage"]);
    expect(r.architecture.rules.find((x) => x.id === "D1")).toMatchObject({ from: "storage", to: "ui" });
    expect(r.architecture.rules[0].description).toBe("Modules may only import from their own module or from modules lower in the layer order: ui > storage.");
    // Leaving a module out does not count as a change of the layer order.
    expect(r.counts).toMatchObject({ rejected: 1, edited: 1 });
    expect(r.warnings.some((w) => w.includes('"storage"'))).toBe(false);
  });

  it("reorders layers, switches rules off and changes their severity", () => {
    const edits = { layers: ["data", "services", "ui"], rules: { CYCLE01: { off: true }, LAYER01: { severity: "warn" as const } } };
    // A rule switched off is thrown out, not edited: these counts are what the 60 percent metric is made of.
    const r = edit(edits);
    expect(r.ok && r.counts).toEqual({ accepted: 3 + draft.rules.length - 2, edited: 2, rejected: 1 });
    const a = arch(edits);
    expect(a.layers).toEqual(["data", "services", "ui"]);
    expect(a.rules.map((r) => r.id)).not.toContain("CYCLE01");
    expect(a.rules.find((r) => r.id === "LAYER01")?.severity).toBe("warn");
    expect(checkArchitecture(a, buildGraphFromFiles(APP)).violations.filter((v) => v.ruleId === "LAYER01")).toHaveLength(15);
  });

  it("edits what is ignored, warns about globs that take in much, and refuses to leave no file in any module", () => {
    expect(arch({ ignore: ["src/data/d1.ts"] }).ignore).toEqual(["src/data/d1.ts"]);
    const wide = edit({ ignore: ["src/ui/**"] });
    expect(wide.ok && wide.warnings).toEqual(["Module \"ui\" has no files: another module or the ignore list takes them, or its paths match none.", "Ignoring \"src/ui/**\" leaves out 12 of 17 source files, which are then not checked."]);
    const everything = edit({ ignore: ["**"] });
    expect(everything).toEqual({ ok: false, errors: ["No file would be in any module, so nothing would be checked. Keep or fix a module, or ignore less."] });
    // Without the list of files, a glob that starts with a wildcard is still warned about.
    const blind = edit({ ignore: ["**/x.ts"] }, undefined);
    expect(blind.ok && blind.warnings).toEqual(['Ignoring "**/x.ts" leaves out matching files anywhere in the repository.']);
    expect(arch({ ignore: [] }).ignore).toBeUndefined();
  });

  it("refuses edits that would let a module take in everything, or that name what is not there", () => {
    const fail = (edits: Parameters<typeof applyEdits>[1]) => {
      const r = edit(edits);
      return r.ok ? [] : r.errors;
    };
    expect(fail({ modules: { ui: { paths: ["**"] } } })).toEqual(['Path "**" of module "ui" must start with a folder name, so that it cannot take in every file.']);
    expect(fail({ modules: { ui: { paths: ["*/**"] } } })).toHaveLength(1);
    expect(fail({ modules: { ui: { paths: ["../x/**"] } } })).toEqual(['A path of module "ui" must be a path inside the repository.']);
    expect(fail({ modules: { ui: { paths: [] } } })).toEqual(['Module "ui" needs 1 to 20 paths.']);
    expect(fail({ modules: { ui: { rename: "a b" } } })[0]).toMatch(/^Module name "a b" must be/);
    expect(fail({ modules: { ui: { rename: "data" } } })).toEqual(['Two modules would be called "data".']);
    expect(fail({ modules: { ghost: {} } })).toEqual(['There is no module "ghost" to edit.']);
    expect(fail({ rules: { NOPE: { off: true } } })).toEqual(['There is no rule "NOPE" to edit.']);
    expect(fail({ rules: { LAYER01: { severity: "off" as never } } })).toEqual(['Rule "LAYER01" can only be block or warn.']);
    expect(fail({ layers: ["ui", "data"] })).toEqual(["The new layer order must list every layer of the draft once."]);
    expect(fail({ layers: ["ui", "data", "data"] })).toHaveLength(1);
    expect(fail({ layers: ["ui", "services", "evil"] })).toHaveLength(1);
    expect(fail({ ignore: ["/etc/**"] })).toHaveLength(1);
    expect(fail({ ignore: Array.from({ length: 1001 }, (_, i) => `x${i}`) })).toEqual(["At most 1000 globs can be ignored."]);
    expect(fail({ ignore: ["x".repeat(513)] })).toHaveLength(1);
  });

  it("refuses globs that would take long to match, from anyone who may send the editor, without matching them first", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `src/ui/feature${i % 50}/component${i}.ts`);
    const big = inferArchitecture(buildGraphFromFiles(files([...many, "src/data/a.ts"]))).architecture;
    const crafted = Array.from({ length: 300 }, (_, i) => `src/${"*a".repeat(245)}${i}*.ts`);
    const started = Date.now();
    const r = applyEdits(big, { ignore: crafted }, many);
    expect(r.ok ? [] : r.errors[0]).toMatch(/must have at most 16 wildcards/);
    // Within the wildcards a glob may have, the globs together are held to a budget for the number of files.
    const fewer = Array.from({ length: 256 }, (_, i) => `src/${Array.from({ length: 8 }, (_, j) => ((i >> j) & 1 ? "?*" : "*?")).join("e")}.ts`);
    const slow = applyEdits(big, { ignore: fewer }, many);
    expect(slow.ok ? [] : slow.errors).toEqual(["The new ignored globs and module paths would take too long to match against the 5000 source files. Use fewer globs, shorter ones, or fewer wildcards."]);
    expect(Date.now() - started).toBeLessThan(1000);
    // A module path is held to the same limits.
    const path = applyEdits(big, { modules: { ui: { paths: ["src/ui/**", `src/${"*a".repeat(20)}.ts`] } } }, many);
    expect(path.ok ? [] : path.errors).toEqual([`Glob "src/${"*a".repeat(20)}.ts" must have at most 16 wildcards.`]);
    // The same few globs pass for a small repository, and globs the draft has already are not held to the limits.
    expect(applyEdits(big, { ignore: fewer.slice(0, 3) }, many.slice(0, 100)).ok).toBe(true);
    const costly = { ...big, ignore: crafted };
    expect(applyEdits(costly, {}, many.slice(0, 10)).ok).toBe(true);
    expect(globCost("src/ui/**")).toBe(1);
    expect(globCost("src/ui/a.ts")).toBe(1);
    expect(globCost("**/*.test.ts")).toBe(4 * 12 + 3 * 32);
  });

  it("refuses a glob listed twice, which would be matched twice", () => {
    const many = Array.from({ length: 3000 }, (_, i) => `src/ui/components/feature${i % 40}/sub${i % 7}/Widget${i}.tsx`);
    const big = inferArchitecture(buildGraphFromFiles(files([...many, "src/data/a.ts"]))).architecture;
    const glob = `src/**/${"*/".repeat(13)}*`;
    const started = Date.now();
    const r = applyEdits(big, { ignore: Array(1000).fill(glob) }, many);
    expect(r.ok ? [] : r.errors).toEqual([`Ignored glob ${JSON.stringify(glob)} is listed twice.`]);
    const twice = applyEdits(big, { modules: { ui: { paths: ["src/ui/**", glob, glob] } } }, many);
    expect(twice.ok ? [] : twice.errors).toEqual([`Path ${JSON.stringify(glob)} of module "ui" is listed twice.`]);
    expect(Date.now() - started).toBeLessThan(1000);
    // A glob the draft lists twice may stay so.
    const doubled = { ...big, ignore: ["src/gen/**", "src/gen/**"] };
    expect(applyEdits(doubled, { ignore: ["src/gen/**", "src/gen/**"] }, many).ok).toBe(true);
    expect(applyEdits(doubled, { ignore: ["src/gen/**", "src/gen/**", "src/gen/**"] }, many).ok).toBe(false);
  });

  it("charges each time a glob is listed and each character of the paths it is followed through", () => {
    const glob = `src/**/${"*/".repeat(13)}*`;
    const file = (i: number) => `src/ui/components/feature${i % 40}/sub${i % 7}/Widget${String(i).padStart(5, "0")}.tsx`;
    // As many files as make the glob fit the budget once, but not twice.
    const n = Math.floor((0.7 * MAX_GLOB_WORK) / globWork([glob], [file(0)]));
    const short = Array.from({ length: n }, (_, i) => file(i));
    const big = inferArchitecture(buildGraphFromFiles(files([...short, "src/data/a.ts"]))).architecture;
    expect(applyEdits(big, { ignore: [glob] }, short).ok).toBe(true);
    const both = applyEdits(big, { ignore: [glob], modules: { ui: { paths: ["src/ui/**", glob] } } }, short);
    expect(both.ok ? [] : both.errors).toEqual([`The new ignored globs and module paths would take too long to match against the ${n} source files. Use fewer globs, shorter ones, or fewer wildcards.`]);
    // The same number of files with longer paths costs more for each character.
    const long = short.map((f) => f.replace("src/ui/", "src/ui/deeper/folder/deeper/folder/"));
    const longer = applyEdits(big, { ignore: [glob] }, long);
    expect(longer.ok ? [] : longer.errors[0]).toMatch(/would take too long to match/);
    // Looking for the glob's plain text in the middle, its slash, costs some more for each character after the prefix, and
    // more for each character of the path that the text has too.
    const has = (f: string, text: string) => [...f].filter((c) => text.includes(c)).length;
    const lookAt = (paths: string[], prefix: number, text: string) => paths.reduce((sum, f) => sum + Math.ceil((f.length - prefix) / 2) + 8 * has(f, text), 0);
    expect(globWork([glob], long) - globWork([glob], short)).toBe(n * "deeper/folder/deeper/folder/".length * globCost(glob) + lookAt(long, 4, "/") - lookAt(short, 4, "/"));
    // Files that cannot match, by the start, the end or the plain text a glob has, are only looked at, and their start and
    // end compared, a unit for four characters.
    expect(globWork(["src/**/*.generated.ts", "lib/**/*"], short)).toBe(2 * 128 * n + Math.ceil("src/.generated.ts".length / 4) * n + n);
    expect(globWork(["**/__tests__/**"], short)).toBe(128 * n + lookAt(short, 0, "__tests__/"));
    expect(globWork(["**/__tests__/**"], long)).toBe(128 * n + lookAt(long, 0, "__tests__/"));
  });

  it("charges what comparing long starts and ends and looking for long plain text cost, on paths of about 1,000 characters", () => {
    const letters = (i: number, n: number) => Array.from({ length: n }, (_, j) => ((i >> j) & 1 ? "e" : "o")).join("");
    const deep = "deeply_nested_folder_name/";
    const shapes: Array<{ repo: string[]; glob: (i: number) => string }> = [
      // A 412-character run in the middle that every path fails used to cost as much as a 12-character one.
      { repo: Array.from({ length: 4000 }, (_, i) => `src/ui/${deep.repeat(38)}feature${i % 10}/Widget${i}.tsx`), glob: (i) => `src/*${deep.repeat(8)}${letters(i, 12)}${deep.repeat(8)}*` },
      // A 250-character start every path has, then a 240-character run.
      { repo: Array.from({ length: 4000 }, (_, i) => `${"p".repeat(249)}/${deep.repeat(28)}feature${i % 10}/Widget${i}.tsx`), glob: (i) => `${"p".repeat(249)}/*${"q".repeat(228)}${letters(i, 12)}*` },
      // A 480-character start every path has and an end none has.
      { repo: Array.from({ length: 4000 }, (_, i) => `${"p".repeat(479)}/${deep.repeat(20)}Widget${i}.tsx`), glob: (i) => `${"p".repeat(479)}/*${letters(i, 12)}` },
      // Plain text that nearly matches at every character of the path, short and long.
      { repo: Array.from({ length: 4000 }, (_, i) => `src/${"a".repeat(1000)}/W${i}.ts`), glob: (i) => `src/${"?".repeat(i % 16)}*aaaab*` },
      { repo: Array.from({ length: 4000 }, (_, i) => `src/${"a".repeat(1000)}/W${i}.ts`), glob: (i) => `src/${"?".repeat(i % 16)}*${"a".repeat(15)}b*` },
    ];
    for (const { repo, glob } of shapes) {
      const graph = buildGraphFromFiles(files([...repo, "src/data/a.ts"]));
      const big = inferArchitecture(graph).architecture;
      const flat = JSON.parse(JSON.stringify(repo)) as string[];
      // As many distinct globs as fit the budget, which a form can hold, and at most 16 of one kind of shape.
      const fit: string[] = [];
      let work = 0;
      for (let i = 0; fit.length < 478 && i < 4096; i++) {
        const g = glob(i);
        if (fit.includes(g)) continue;
        work += globWork([g], flat);
        if (work > 0.98 * MAX_GLOB_WORK) break;
        fit.push(g);
      }
      expect(globWork(fit, flat)).toBeLessThanOrEqual(MAX_GLOB_WORK);
      const cpu = process.cpuUsage();
      const r = applyEdits(big, { ignore: fit }, flat);
      expect(r.ok).toBe(true);
      checkArchitecture(r.ok ? r.architecture : big, graph);
      const used = process.cpuUsage(cpu);
      // These took 10 to 21 s of CPU at the full budget before, against about 1.5 s for the shapes the budget was made for.
      expect((used.user + used.system) / 1000).toBeLessThan(4000);
    }
  });

  it("charges looking for a glob's plain text by the length of the paths, so that globs ruled out by it stay near a second", () => {
    const letters = (i: number, n: number) => Array.from({ length: n }, (_, j) => ((i >> j) & 1 ? "e" : "o")).join("");
    const repo = Array.from({ length: 7700 }, (_, i) => `src/ui/components/feature${i % 10}/sub${i % 7}/Widget${i}.tsx`);
    const big = inferArchitecture(buildGraphFromFiles(files([...repo, "src/data/a.ts"]))).architecture;
    // A thousand globs that every file passes but for the plain text in the middle used to fit, and took two seconds.
    for (const shape of [(i: number) => `src/?${letters(i, 12)}?`, (i: number) => `src/**${letters(i, 12)}**`]) {
      const r = applyEdits(big, { ignore: Array.from({ length: 1000 }, (_, i) => shape(i)) }, repo);
      expect(r.ok ? [] : r.errors[0]).toMatch(/would take too long to match against the 7700 source files/);
    }
    // As many as fit are matched, and then checked, in about a second each.
    const shape = (i: number) => `src/*${letters(i, 12)}*.tsx`;
    const globs: string[] = [];
    for (let work = globWork([shape(0)], repo); work <= 0.98 * MAX_GLOB_WORK; work += globWork([shape(globs.length)], repo)) globs.push(shape(globs.length));
    expect(globs.length).toBeGreaterThan(300);
    let started = Date.now();
    const r = applyEdits(big, { ignore: globs }, repo);
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    started = Date.now();
    checkArchitecture(r.ok ? r.architecture : big, buildGraphFromFiles(files([...repo, "src/data/a.ts"])));
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("reads each ignored glob once in a check, so that long globs the budget lets through do not cost their length for each file", () => {
    const letters = (i: number, n: number) => Array.from({ length: n }, (_, j) => ((i >> j) & 1 ? "e" : "o")).join("");
    const repo = Array.from({ length: 4000 }, (_, i) => `src/ui/components/feature${i % 10}/sub${i % 7}/Widget${i}.tsx`);
    const graph = buildGraphFromFiles(files([...repo, "src/data/a.ts", "src/data/b.ts"], `import "../ui/components/feature0/sub0/Widget0";`));
    const big = inferArchitecture(graph).architecture;
    // 120 globs of 490 characters that every file rules out by their plain text cost little to match once compiled.
    const globs = Array.from({ length: 120 }, (_, i) => `src/*${letters(i, 9)}${"q".repeat(480)}*`);
    expect(globWork(globs, repo)).toBeLessThan(MAX_GLOB_WORK / 4);
    const r = applyEdits(big, { ignore: [...globs, "src/ui/components/feature1/**"] }, repo);
    expect(r.ok).toBe(true);
    const arch = r.ok ? r.architecture : big;
    // Read again for every file, the same check took 8 seconds, and as long for each list of what could not be read.
    const started = Date.now();
    const result = checkArchitecture(arch, graph);
    const unchecked = uncheckedPaths(graph, ["src/ui/components/feature1/sub1/Widget1.tsx", "src/zz.ts"], arch.ignore);
    expect(Date.now() - started).toBeLessThan(1500);
    // What is ignored is still ignored, and an ignored file that is not read is fine while nothing leads to it.
    expect(result.violations.some((v) => v.file.includes("/feature1/"))).toBe(false);
    expect(unchecked).toEqual(["src/zz.ts"]);
  });

  it("leaves room for the globs people write, on 9,000 files", () => {
    const repo = Array.from({ length: 9000 }, (_, i) => `src/features/f${i % 60}/${i % 10 ? "" : "__tests__/"}components/Widget${i}${i % 10 === 1 ? ".generated" : ""}.ts`);
    const per = (g: string) => Math.floor(MAX_GLOB_WORK / globWork([g], repo));
    // With a tenth of the files named so, about 40 to 50 such globs fit; hundreds that name a folder; about ten that every file is read through.
    expect(per("**/*.generated.ts")).toBeGreaterThan(40);
    expect(per("**/__tests__/**")).toBeGreaterThan(40);
    expect(per("src/legacy/**")).toBeGreaterThan(400);
    expect(per("src/**/*.ts")).toBeGreaterThanOrEqual(10);
  });

  it("needs a rule that names a rejected module switched off", () => {
    const withDep: Architecture = {
      ...draft,
      rules: [...draft.rules, { id: "D1", type: "deny_dependency", from: "data", to: "ui", severity: "block", description: "d", rationale: "r" }],
    };
    expect(applyEdits(withDep, { modules: { ui: { reject: true } } }, paths)).toEqual({
      ok: false,
      errors: ['Rule "D1" names module "ui", which is rejected. Switch the rule off or keep the module.'],
    });
    expect(applyEdits(withDep, { modules: { ui: { reject: true } }, rules: { D1: { off: true } } }, paths).ok).toBe(true);
  });

  it("cannot add rules, exceptions or anything else", () => {
    const sneaky = {
      exceptions: [{ rule: "LAYER01", file: "**", owner: "x", reason: "y", expires: "2099-01-01" }],
      rules: { LAYER01: { severity: "warn", type: "max_file_lines", max: 1e9, extra: true } },
      modules: { ui: { rename: "ui", paths: ["src/ui/**"], description: "<script>", extra: 1 } },
      version: 2,
    } as never;
    const a = arch(sneaky);
    expect(a.exceptions).toEqual([]);
    expect(a.version).toBe(1);
    expect(a.rules.find((r) => r.id === "LAYER01")).toEqual({ ...draft.rules[0], severity: "warn" });
    expect(a.modules.ui).toEqual(draft.modules.ui);
    expect(a.rules).toHaveLength(draft.rules.length);
  });
});
