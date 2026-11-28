import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  user: { id: 1, github_id: 1, login: "ann" } as object | null,
  role: "team_leader" as string | null,
  level: "write" as string | null,
  standing: "member",
  down: false,
  tree: ["src/ui/a.ts", "src/data/d.ts"],
  cli: undefined as string | undefined,
  sha: "sha",
  code: { "src/ui/a.ts": `import "../data/d";`, "src/data/d.ts": "" } as Record<string, string>,
  prFails: false,
};
let draftRow: { repo_id: number; user_id: number | null; commit_sha: string; draft_json: string; updated_at: string } | null = null;
const audits: Array<[string, string | undefined]> = [];
let analyses: object[] = [];
let inference: object | null = null;
let repos: object[] = [];
let orgs: object[] = [];
const opened: Array<Record<string, string>> = [];
const prs: Array<{ title: string; body: string; baseSha?: string }> = [];
let body = "";
const repoStatus: string[] = [];
let memberships: object[] = [];
/** Who the organization has on record, for the owners in the suggested CODEOWNERS. */
const people = [
  { login: "lead", role: "team_leader", state: "active" },
  { login: "boss", role: "owner", state: "active" },
  { login: "dev", role: "member", state: "active" },
  { login: "gone", role: "team_leader", state: "gone" },
  // Not a login GitHub gives out, which must not fail the setup.
  { login: "odd login\n/ @evil", role: "team_leader", state: "active" },
];

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
}));
vi.mock("@/lib/auth", () => ({ currentUser: async () => state.user }));
vi.mock("@/lib/env", () => ({ waitUntil: () => {}, getEnv: () => ({ DB: {}, APP_URL: "https://vx.test", GITHUB_APP_SLUG: "vx", VOXIUM_CLI_PACKAGE: state.cli }) }));
vi.mock("@/lib/access", async (original) => ({
  ...(await original<typeof import("./access")>()),
  githubRepoLevel: async () => state.level,
  githubStanding: async () => state.standing,
}));
vi.mock("@/lib/github", () => ({
  getInstallationToken: async () => {
    if (state.down) throw new Error("github down");
    return "t";
  },
  getBranchSha: async () => state.sha,
  listTree: async () => new Map(state.tree.map((p) => [p, "sha"])),
  getFileAtRef: async (_t: string, _r: string, p: string) => `# existing ${p}\n`,
  fetchTarball: async () => null,
  createSetupPr: async (_t: string, _r: string, _b: string, files: Record<string, string>, pr: { title: string; body: string; baseSha?: string }) => {
    if (state.prFails) throw new Error("GitHub create tree failed: 422");
    opened.push(files);
    prs.push(pr);
    body = pr.body;
    return { url: "https://gh/pr/1", number: 1 };
  },
}));
vi.mock("@/lib/tar", () => ({ readTarGz: async () => ({ ...state.code }) }));
vi.mock("@/lib/store", () => ({
  getRepo: async () => ({ id: 5, org_id: 9, full_name: "acme/secret", default_branch: "main" }),
  getOrg: async () => ({ id: 9, installation_id: 3 }),
  getRole: async () => state.role,
  listAnalyses: async () => analyses,
  latestInference: async () => inference,
  getSetupDraft: async () => draftRow && { ...draftRow },
  saveSetupDraft: async (_db: unknown, d: { repo_id: number; user_id: number | null; commit_sha: string; draft_json: string }) => {
    draftRow = { ...d, updated_at: "2026-11-27 12:00:00" };
  },
  updateSetupDraft: async (_db: unknown, _id: number, was: string, now: string) => {
    if (draftRow?.draft_json !== was) return false;
    draftRow = { ...draftRow, draft_json: now };
    return true;
  },
  listDecisions: async () => [],
  saveAnalysis: async () => {},
  setRepoSetup: async (_db: unknown, _id: number, status: string) => void repoStatus.push(status),
  listOrgsForUser: async () => orgs,
  listReposForUser: async () => repos,
  listMemberships: async () => memberships,
  listPeople: async () => people,
  latestOrgRuleSet: async () => null,
  newestSnapshots: async () => ({ any: null, complete: null }),
  audit: async (_db: unknown, _o: unknown, _u: unknown, action: string, detail?: string) => void audits.push([action, detail]),
}));

const { POST } = await import("../app/api/repos/[id]/setup/route");
const { POST: DRAFT } = await import("../app/api/repos/[id]/setup/draft/route");
const { default: SetupPage } = await import("../app/repos/[id]/setup/page");
const { default: RepoPage } = await import("../app/repos/[id]/page");
const { default: Dashboard } = await import("../app/dashboard/page");
const { draftHash } = await import("./setup");
const { renderToStaticMarkup } = await import("react-dom/server");
const params = { params: Promise.resolve({ id: "5" }) };
const page = { ...params, searchParams: Promise.resolve({}) };
const request = (origin: string | null = "https://vx.test") => ({ headers: new Headers(origin === null ? {} : { origin }) }) as never;
const location = (res: Response) => new URL(res.headers.get("location")!);
const ARCH = "voxium/architecture.json";
const BASELINE = "voxium/baseline.json";

/** A form sent from the review page, as a browser sends it. */
function form(fields: Array<[string, string]> | URLSearchParams, origin: string | null = "https://vx.test", type = "application/x-www-form-urlencoded") {
  const headers: Record<string, string> = { "content-type": type };
  if (origin !== null) headers.origin = origin;
  return new Request("https://vx.test/api/repos/5/setup", { method: "POST", headers, body: new URLSearchParams(fields).toString() }) as never;
}

/** The fields the review page sends for the stored draft when nothing is changed, with changes on top. */
async function fields(change: (f: Map<string, string>) => void = () => {}): Promise<Array<[string, string]>> {
  const draft = JSON.parse(draftRow!.draft_json);
  const f = new Map<string, string>([["draft", await draftHash(draftRow!)]]);
  Object.entries(draft.architecture.modules as Record<string, { paths: string[] }>).forEach(([name, def], i) => {
    f.set(`m${i}.keep`, "on");
    f.set(`m${i}.name`, name);
    f.set(`m${i}.paths`, def.paths.join("\r\n"));
  });
  (draft.architecture.layers as string[]).forEach((_, i) => f.set(`l${i}.pos`, String(i + 1)));
  (draft.architecture.rules as Array<{ severity: string }>).forEach((r, i) => {
    f.set(`r${i}.on`, "on");
    f.set(`r${i}.severity`, r.severity);
  });
  f.set("ignore", (draft.architecture.ignore ?? []).join("\n"));
  change(f);
  return [...f];
}

const makeDraft = async (req = request()) => location(await DRAFT(req, params));
const submit = async (req?: never) => location(await POST(req ?? form(await fields()), params));
/** Infer, then send the draft as it is: what the button did in one step before there was a review. */
const setup = async () => {
  const to = await makeDraft();
  return draftRow ? submit() : to;
};

beforeEach(() => {
  opened.length = 0;
  prs.length = 0;
  repoStatus.length = 0;
  audits.length = 0;
  memberships = [];
  analyses = [];
  inference = null;
  repos = [];
  orgs = [];
  draftRow = null;
  Object.assign(state, {
    tree: ["src/ui/a.ts", "src/data/d.ts"],
    user: { id: 1, github_id: 1, login: "ann" },
    role: "team_leader",
    level: "write",
    standing: "member",
    down: false,
    cli: undefined,
    sha: "sha",
    code: { "src/ui/a.ts": `import "../data/d";`, "src/data/d.ts": "" },
    prFails: false,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** Everyone who must not draft, see or send a setup, as changes to a Team Leader with write access. */
const OUTSIDERS: Array<[string, Partial<typeof state>]> = [
  ["not signed in", { user: null }],
  ["not in the organization", { role: null }],
  ["a member", { role: "member" }],
  ["a member who can write to the repo", { role: "member", level: "admin" }],
  ["a Team Leader who can only read the repo", { level: "read" }],
  ["a Team Leader with no access to the repo", { level: null }],
  ["a Team Leader who left the organization", { standing: "outside" }],
  ["a stored Owner who is no longer an admin", { role: "owner", standing: "member" }],
  ["someone GitHub cannot be asked about", { down: true }],
];
const ORIGINS = [null, "null", "https://evil.test", "http://vx.test", "https://vx.test:8443"];

describe("repo page", () => {
  it("opens for someone GitHub lets read the repo", async () => {
    state.level = "read";
    state.role = "member";
    expect(await RepoPage(page)).toBeTruthy();
  });

  it.each([
    ["has no access to the repo on GitHub", { level: null }],
    ["is not in the organization", { role: null }],
    ["cannot be checked because GitHub is down", { down: true }],
  ])("stays hidden, even from an Owner role, when the user %s", async (_n, change) => {
    Object.assign(state, { role: "owner" }, change);
    await expect(RepoPage(page)).rejects.toThrow("NOT_FOUND");
  });
});

describe("setup", () => {
  it("opens a pull request for a Team Leader with write access", async () => {
    expect((await setup()).pathname).toBe("/repos/5");
    expect(opened).toHaveLength(1);
    // The suggested CODEOWNERS names the organization's current Owners and Team Leaders, and nobody else.
    expect(opened[0]["voxium/CODEOWNERS.suggested"]).toContain("/voxium/ @boss @lead\n");
    expect(opened[0][".cursor/rules/voxium.mdc"]).toMatch(/^---\ndescription: .*\nalwaysApply: true\n---\n<!-- voxium:start -->/);
  });

  it.each(OUTSIDERS)("does nothing for someone who is %s", async (_n, change) => {
    const leader = { ...state };
    Object.assign(state, change);
    await makeDraft();
    expect(draftRow).toBeNull();
    // Nor with a draft a Team Leader made.
    Object.assign(state, leader);
    await makeDraft();
    const sent = await fields();
    Object.assign(state, change);
    const json = draftRow!.draft_json;
    await submit(form(sent));
    expect(opened).toEqual([]);
    expect(draftRow!.draft_json).toBe(json);
  });

  it.each(ORIGINS)("ignores a form sent from %j", async (origin) => {
    await makeDraft(request(origin));
    expect(draftRow).toBeNull();
    await makeDraft();
    await submit(form(await fields(), origin));
    expect(opened).toEqual([]);
  });

  it("works with unreadable files that nothing imports, and lists them for review", async () => {
    state.tree.push(".yarn/releases/yarn-4.5.0.cjs", "public/huge.min.js");
    await setup();
    expect(JSON.parse(opened[0][ARCH]).ignore).toEqual([".yarn/**", "public/huge.min.js"]);
    expect(body).toContain("`public/huge.min.js`");
  });

  it.each([undefined, ""])("adds nothing that runs code from npm while no CLI is published (%j)", async (cli) => {
    state.cli = cli;
    await setup();
    expect(Object.keys(opened[0])).not.toContain(".mcp.json");
    expect(Object.keys(opened[0])).not.toContain(".github/workflows/voxium.yml");
    expect(Object.values(opened[0]).join("\n")).not.toContain("npx");
    expect(body).toContain("`voxium/rules`");
  });

  it("pins the configured CLI, and refuses one that is not an exact version", async () => {
    state.cli = "voxium@1.2.3";
    await setup();
    expect(opened[0][".github/workflows/voxium.yml"]).toContain("npx --yes voxium@1.2.3 check");
    expect(body).toContain("`voxium@1.2.3`");
    state.cli = "voxium";
    expect((await submit()).search).toContain("VOXIUM_CLI_PACKAGE");
    expect(opened).toHaveLength(1);
  });

  it("never replaces rules that are already there", async () => {
    state.tree.push(ARCH);
    expect((await setup()).pathname).toBe("/repos/5");
    expect(opened).toEqual([]);
    expect(draftRow).toBeNull();
    expect(repoStatus).toEqual(["active"]);
  });

  it("keeps an existing CLAUDE.md that is missing from the archive", async () => {
    state.tree.push("CLAUDE.md");
    await setup();
    expect(opened[0]["CLAUDE.md"]).toContain("# existing CLAUDE.md");
  });

  it("does not reveal private repo names to people without access", async () => {
    for (const change of [{ level: null }, { down: true }, { role: null }]) {
      Object.assign(state, change);
      expect((await makeDraft()).search).not.toContain("secret");
      expect((await submit(form([]))).search).not.toContain("secret");
    }
  });
});

describe("setup draft", () => {
  it("stores the inference with confidence, violation counts and notes, and sends the person to review it", async () => {
    expect((await makeDraft()).pathname).toBe("/repos/5/setup");
    expect(draftRow).toMatchObject({ repo_id: 5, user_id: 1, commit_sha: "sha" });
    const draft = JSON.parse(draftRow!.draft_json);
    expect(draft.architecture.layers).toEqual(["ui", "data"]);
    expect(draft.proposals.map((p: { kind: string }) => p.kind)).toEqual(expect.arrayContaining(["module", "layer", "rule"]));
    expect(draft.violations).toMatchObject({ LAYER01: 0 });
    // Analysis output only: never the contents of a file.
    expect(draftRow!.draft_json).not.toContain(`import "../data/d"`);
    expect(audits).toContainEqual(["setup_drafted", "acme/secret at sha"]);
    expect(opened).toEqual([]);
  });

  it("refuses to draft when code it cannot leave out cannot be read, as setup did", async () => {
    state.code = { "src/ui/a.ts": `import "../data/d";`, "src/data/d.ts": `import "./gen";`, "src/data/gen.ts": "`" };
    state.tree = Object.keys(state.code);
    expect((await makeDraft()).search).toContain("cannot+be+read");
    expect(draftRow).toBeNull();
  });

  it("sends a form without a draft to the review page", async () => {
    const to = await submit(form([["draft", "x"]]));
    expect(to.pathname).toBe("/repos/5/setup");
    expect(opened).toEqual([]);
  });
});

describe("setup review page", () => {
  const render = async () => renderToStaticMarkup(await SetupPage(page));

  it("shows modules, order, rules and ignore with confidence, violations and notes as a form without scripts", async () => {
    state.tree.push("public/huge.min.js");
    expect(await render()).toContain("Infer the architecture");
    await makeDraft();
    const html = await render();
    for (const text of ['name="m0.keep"', 'name="l1.pos"', 'name="r0.severity"', 'name="ignore"', "public/huge.min.js", "violation(s) in the current code", "%</span>", `value="${await draftHash(draftRow!)}"`]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("<script");
  });

  it.each(OUTSIDERS.filter(([n]) => n !== "not signed in"))("stays hidden from someone who is %s", async (_n, change) => {
    await makeDraft();
    Object.assign(state, change);
    await expect(SetupPage(page)).rejects.toThrow("NOT_FOUND");
  });

  it("sends someone who is not signed in to sign in", async () => {
    state.user = null;
    await expect(SetupPage(page)).rejects.toThrow("REDIRECT /api/auth/login");
  });

  it("escapes names from the repository", async () => {
    await makeDraft();
    const draft = JSON.parse(draftRow!.draft_json);
    draft.architecture.modules.ui.description = "<img src=x onerror=alert(1)>";
    draft.summary.notes.push("<script>alert(1)</script>");
    draftRow!.draft_json = JSON.stringify(draft);
    const html = await render();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("setup with edits", () => {
  const files = () => opened.at(-1)!;
  const arch = () => JSON.parse(files()[ARCH]);
  const baseline = () => JSON.parse(files()[BASELINE]).violations;

  beforeEach(() => {
    state.code = { "src/ui/a.ts": `import "../data/d";`, "src/ui/b.ts": "", "src/data/d.ts": `import "../ui/a";`, "src/lib/x.ts": "" };
    state.tree = Object.keys(state.code);
  });

  it("applies rejected modules, a new order and new paths to the files and the baseline", async () => {
    await makeDraft();
    const draft = JSON.parse(draftRow!.draft_json);
    const layers: string[] = draft.architecture.layers;
    expect(layers.indexOf("ui")).toBeLessThan(layers.indexOf("data"));
    await submit();
    expect(baseline()).toEqual(["CYCLE01:data+ui", "LAYER01:src/data/d.ts->src/ui/a.ts"]);

    const [ui, data] = [layers.indexOf("ui"), layers.indexOf("data")];
    await submit(form(await fields((f) => {
      f.set(`l${ui}.pos`, String(data + 1));
      f.set(`l${data}.pos`, String(ui + 1));
    })));
    expect(arch().layers.indexOf("data")).toBeLessThan(arch().layers.indexOf("ui"));
    expect(baseline()).toEqual(["CYCLE01:data+ui", "LAYER01:src/ui/a.ts->src/data/d.ts"]);

    const i = Object.keys(draft.architecture.modules).indexOf("data");
    await submit(form(await fields((f) => f.delete(`m${i}.keep`))));
    expect(Object.keys(arch().modules)).not.toContain("data");
    expect(baseline()).toEqual([]);

    const u = Object.keys(draft.architecture.modules).indexOf("ui");
    await submit(form(await fields((f) => f.set(`m${u}.paths`, "src/ui/b.ts"))));
    expect(arch().modules.ui.paths).toEqual(["src/ui/b.ts"]);
    expect(baseline()).toEqual([]);
    expect(opened).toHaveLength(4);
    expect(audits.filter(([a]) => a === "setup_reviewed").map(([, d]) => JSON.parse(d!))).toEqual([
      { repo: "acme/secret", accepted: 3 + 1 + 4 + 0, edited: 0, rejected: 0 },
      { repo: "acme/secret", accepted: 3 + 4, edited: 1, rejected: 0 },
      { repo: "acme/secret", accepted: 2 + 1 + 4, edited: 0, rejected: 1 },
      { repo: "acme/secret", accepted: 2 + 1 + 4, edited: 1, rejected: 0 },
    ]);
    // Each edit wrote other rules.
    expect(new Set(opened.map((o) => o[ARCH])).size).toBe(4);
  });

  it("works out the baseline at the tip of the default branch when it moved since the draft", async () => {
    await makeDraft();
    state.sha = "newer";
    state.code = { ...state.code, "src/data/e.ts": `import "../ui/b";` };
    state.tree = Object.keys(state.code);
    await submit();
    expect(baseline()).toEqual(["CYCLE01:data+ui", "LAYER01:src/data/d.ts->src/ui/a.ts", "LAYER01:src/data/e.ts->src/ui/b.ts"]);
    expect(JSON.parse(draftRow!.draft_json).submitted).toMatchObject({ by: "ann", sha: "newer" });
    // The pull request goes on the commit the baseline was worked out on, not on whatever the branch points at by then.
    expect(prs.map((p) => p.baseSha)).toEqual(["newer"]);
  });

  it("refuses to open the pull request when the default branch gained code that cannot be read since the draft", async () => {
    await makeDraft();
    state.code = { ...state.code, "src/data/d.ts": `import "./gen";`, "src/data/gen.ts": "`" };
    state.tree = Object.keys(state.code);
    const to = await submit();
    expect(to.pathname).toBe("/repos/5/setup");
    expect(to.searchParams.get("error")).toMatch(/cannot be read.*src\/data\/gen\.ts/);
    expect(opened).toEqual([]);
    expect(JSON.parse(draftRow!.draft_json).errors[0]).toMatch(/cannot be read/);
    expect(audits.map(([a]) => a)).not.toContain("setup_pr");
  });

  it("says nothing was opened when GitHub fails to open the pull request, and takes the same form again", async () => {
    await makeDraft();
    const before = draftRow!.draft_json;
    const sent = await fields();
    state.prFails = true;
    const to = await submit(form(sent));
    expect(to.pathname).toBe("/dashboard");
    expect(to.searchParams.get("error")).toMatch(/Setup failed/);
    expect(draftRow!.draft_json).toBe(before);
    expect(JSON.parse(draftRow!.draft_json).submitted).toBeUndefined();
    expect(renderToStaticMarkup(await SetupPage(page))).not.toContain("opened the setup pull request");
    expect(repoStatus).toEqual([]);
    expect(audits.map(([a]) => a)).not.toContain("setup_reviewed");
    state.prFails = false;
    expect((await submit(form(sent))).pathname).toBe("/repos/5");
    expect(opened).toHaveLength(1);
    expect(renderToStaticMarkup(await SetupPage(page))).toContain("ann opened the setup pull request from this draft");
  });

  it("opens one pull request when the same draft is sent twice at once", async () => {
    await makeDraft();
    const sent = await fields();
    const both = await Promise.all([submit(form(sent)), submit(form(sent))]);
    expect(opened).toHaveLength(1);
    expect(both.map((to) => to.pathname).sort()).toEqual(["/repos/5", "/repos/5/setup"]);
    expect(both.find((to) => to.pathname === "/repos/5/setup")!.searchParams.get("error")).toMatch(/draft changed since you opened it/);
    expect(audits.filter(([a]) => a === "setup_pr")).toHaveLength(1);
  });

  it("overwrites nothing when rules appeared on the default branch since the draft", async () => {
    await makeDraft();
    state.tree.push(ARCH);
    const to = await submit();
    expect(to.pathname).toBe("/repos/5");
    expect(to.searchParams.get("error")).toMatch(/nothing was changed/);
    expect(opened).toEqual([]);
    expect(repoStatus).toEqual(["active"]);
  });

  it("refuses a form for a draft that changed since it was shown, and the second of two people sending the same draft", async () => {
    await makeDraft();
    const stale = await fields();
    await makeDraft();
    draftRow!.draft_json = draftRow!.draft_json.replace('"files":4', '"files":5');
    expect((await submit(form(stale))).searchParams.get("error")).toMatch(/draft changed since you opened it/);
    expect(opened).toEqual([]);
    const both = await fields();
    await submit(form(both));
    expect((await submit(form(both))).searchParams.get("error")).toMatch(/draft changed since you opened it/);
    expect(opened).toHaveLength(1);
  });

  it.each<[string, (f: Map<string, string>) => void]>([
    ["an extra rule", (f) => f.set("r9.on", "on")],
    ["an exception", (f) => f.set("exceptions", `[{"rule":"LAYER01","file":"**"}]`)],
    ["meta of a module", (f) => f.set("m0.description", "x")],
    ["a module path that takes in everything", (f) => f.set("m0.paths", "**")],
    ["a severity that is not offered", (f) => f.set("r0.severity", "off")],
    ["a layer place out of range", (f) => f.set("l0.pos", "0")],
    ["a module named like a path", (f) => f.set("m0.name", "../x")],
  ])("refuses a form with %s", async (_n, change) => {
    await makeDraft();
    const to = await submit(form(await fields(change)));
    expect(to.pathname).toBe("/repos/5/setup");
    expect(to.searchParams.get("error")).toBeTruthy();
    expect(opened).toEqual([]);
  });

  it("refuses a field sent twice, a body that is too large and one that is not a plain form", async () => {
    await makeDraft();
    const twice = [...(await fields()), ["m0.keep", "on"] as [string, string]];
    expect((await submit(form(twice))).searchParams.get("error")).toMatch(/fields the editor does not send/);
    const huge = await fields((f) => f.set("ignore", "x/".repeat(140_000)));
    expect((await submit(form(huge))).searchParams.get("error")).toMatch(/too large/);
    expect((await submit(form(await fields(), undefined, "multipart/form-data; boundary=x"))).searchParams.get("error")).toMatch(/too large or not sent/);
    expect(opened).toEqual([]);
  });

  it("refuses to ignore everything, and keeps the edits to show them again", async () => {
    await makeDraft();
    const to = await submit(form(await fields((f) => f.set("ignore", "**"))));
    expect(to.searchParams.get("error")).toMatch(/No file would be in any module/);
    expect(opened).toEqual([]);
    const draft = JSON.parse(draftRow!.draft_json);
    expect(draft.edits).toEqual({ ignore: ["**"] });
    expect(draft.errors[0]).toMatch(/No file would be in any module/);
    expect(renderToStaticMarkup(await SetupPage(page))).toContain("No file would be in any module");
  });

  it("asks to confirm warnings it showed, and opens the pull request once they are confirmed", async () => {
    await makeDraft();
    const to = await submit(form(await fields((f) => f.set("ignore", "src/ui/**\nsrc/data/**"))));
    expect(to.searchParams.get("error")).toMatch(/warnings/);
    expect(opened).toEqual([]);
    const html = renderToStaticMarkup(await SetupPage(page));
    expect(html).toContain("&quot;ui&quot; has no files");
    expect(html).toContain('name="confirm"');
    // A confirmation counts only for the warnings the page showed.
    const other = async () =>
      form(
        await fields((f) => {
          f.set("ignore", "src/lib/**");
          f.set("confirm", "on");
        }),
      );
    expect((await submit(await other())).searchParams.get("error")).toMatch(/warnings/);
    expect(opened).toEqual([]);
    await submit(await other());
    expect(opened).toHaveLength(1);
    expect(arch().ignore).toEqual(["src/lib/**"]);
    expect(body).toContain("Please check:");
    expect(body).toContain('* Module "lib" has no files');
  });
});

describe("repo page", () => {
  it("shows the latest inference however many checks came after it", async () => {
    analyses = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, kind: "pr_check", pr_number: i, created_at: "x", summary_json: JSON.stringify({ state: "success", description: "ok", newViolations: [] }) }));
    inference = { id: 1, kind: "inference", summary_json: JSON.stringify({ confidence: 0.9, layers: ["ui"], modules: { ui: ["src/ui/**"] }, notes: [], existingViolations: 0, files: 2 }) };
    const html = renderToStaticMarkup(await RepoPage(page));
    expect(html).toContain("Inferred architecture");
    expect(html).toContain("Review the setup");
  });
});

describe("dashboard", () => {
  it("infers a draft for review instead of opening the pull request at once", async () => {
    orgs = [{ id: 9, account_login: "acme", role: "team_leader" }];
    repos = [
      { id: 5, full_name: "acme/a", status: "connected", level: "write" },
      { id: 6, full_name: "acme/b", status: "setup_pr_open", level: "write", setup_pr_url: "https://gh/pr/1" },
    ];
    const html = renderToStaticMarkup(await Dashboard({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('action="/api/repos/5/setup/draft"');
    expect(html).toContain('href="/repos/6/setup"');
    expect(html).not.toContain('action="/api/repos/5/setup"');
  });

  it("says when access could not be read instead of asking to install the app again", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const page = async () => renderToStaticMarkup(await Dashboard({ searchParams: Promise.resolve({}) }));
    expect(await page()).toContain("Install the GitHub App");
    memberships = [{ org_id: 9, account_login: "acme", role: "member", state: "error" }];
    expect(await page()).toContain("could not read your access to acme");
    expect(await page()).not.toContain("Install the GitHub App");
  });
});
