import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const ARCH = "voxium/architecture.json";
const arch = (rules: object[]) =>
  JSON.stringify({ version: 1, modules: { ui: { paths: ["src/ui/**"] } }, layers: ["ui"], rules, exceptions: [] });
const strict = arch([{ id: "LAYER01", type: "layers", severity: "block", description: "d", rationale: "r" }]);

const fresh = () => ({
  user: { id: 1, github_id: 1, login: "ann" } as object | null,
  role: "owner" as string | null,
  level: "write" as string | null,
  standing: "owner" as string,
  standings: {} as Record<string, string>,
  alone: true,
  type: "Organization",
  down: false,
  pull: { number: 4, title: "Loosen <b>rules</b>", state: "open", merged: false, html_url: "https://gh/pull/4", user: { id: 1, login: "ann" }, head: { sha: "head" }, base: { ref: "main", sha: "m" } } as any,
  head: arch([]),
  approval: null as object | null,
  own: null as object | null,
  people: [{ user_id: 1, github_id: 1, login: "ann", role: "owner", state: "active" }, { user_id: 2, github_id: 2, login: "bob", role: "member", state: "active" }] as any[],
  decisions: [] as any[],
  tree: [] as string[],
});
let state = fresh();
let saved: any[] = [];
let withdrawn: any[] = [];
let checks: any[] = [];
let audits: any[] = [];
let leaders: any[] = [];
let opened: any[] = [];

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
}));
vi.mock("@/lib/auth", () => ({ currentUser: async () => state.user }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ DB: {}, APP_URL: "https://vx.test" }), waitUntil: () => {} }));
vi.mock("@/lib/access", async (original) => ({
  ...(await original<typeof import("./access")>()),
  githubRepoLevel: async () => state.level,
  githubStanding: async (_t: string, _o: object, u: { login: string }) => state.standings[u.login] ?? state.standing,
}));
vi.mock("@/lib/github", () => ({
  getInstallationToken: async () => {
    if (state.down) throw new Error("github down");
    return "t";
  },
  getPull: async () => state.pull,
  isOnlyMember: async () => state.alone,
  getBranchSha: async () => "sha",
  listTree: async () => new Map(state.tree.map((p) => [p, "x"])),
  createSetupPr: async (_t: string, _r: string, _b: string, files: object, pr: object) => {
    opened.push({ files, pr });
    return { url: "https://gh/pull/8", number: 8 };
  },
}));
vi.mock("@/lib/repo-job", () => ({
  readRules: async () => ({ base: { [ARCH]: strict }, mergeBase: { [ARCH]: strict }, head: { [ARCH]: state.head } }),
  findApprover: async () => state.approval,
  runPullRequestCheck: async (ev: object) => void checks.push(ev),
}));
vi.mock("@/lib/store", () => ({
  getRepo: async () => ({ id: 5, org_id: 9, github_repo_id: 77, full_name: "acme/secret", default_branch: "main" }),
  getOrg: async () => ({ id: 9, installation_id: 3, account_login: "acme", account_type: state.type }),
  getRole: async () => state.role,
  listAnalyses: async () => [],
  listPeople: async () => state.people,
  listDecisions: async () => state.decisions,
  getSelfApproval: async () => state.own,
  saveSelfApproval: async (_db: unknown, pull: object, userId: number, reason: string) => void saved.push({ ...pull, userId, reason }),
  withdrawSelfApproval: async (_db: unknown, ...a: unknown[]) => void withdrawn.push(a),
  setTeamLeader: async (_db: unknown, ...a: unknown[]) => { leaders.push(a); return true; },
  audit: async (_db: unknown, ...a: unknown[]) => void audits.push(a),
}));

const { POST: approvalPost } = await import("../app/api/repos/[id]/pulls/[number]/approval/route");
const { POST: rolesPost } = await import("../app/api/orgs/[id]/roles/route");
const { POST: decisionsPost } = await import("../app/api/repos/[id]/decisions/route");
const { default: PullPage } = await import("../app/repos/[id]/pulls/[number]/page");
const { default: PeoplePage } = await import("../app/orgs/[id]/page");

type Handler = (req: never, ctx: never) => Promise<Response>;
async function post(handler: unknown, params: object, form: Record<string, string>, origin: string | null = "https://vx.test"): Promise<URL> {
  const data = new FormData();
  for (const [k, v] of Object.entries(form)) data.set(k, v);
  const req = { headers: new Headers(origin === null ? {} : { origin }), formData: async () => data };
  const res = await (handler as Handler)(req as never, { params: Promise.resolve(params) } as never);
  return new URL(res.headers.get("location")!);
}
const good = { action: "approve", sha: "head", base: "main", reason: "We are splitting billing out" };
const approve = (over: Record<string, string> = {}, origin?: string | null, number = "4") =>
  post(approvalPost, { id: "5", number }, { ...good, ...over }, origin);
const html = async () =>
  renderToStaticMarkup(await PullPage({ params: Promise.resolve({ id: "5", number: "4" }), searchParams: Promise.resolve({}) }));

beforeEach(() => {
  state = fresh();
  saved = []; withdrawn = []; checks = []; audits = []; leaders = []; opened = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("approving your own pull request", () => {
  it("saves it for the commit and base shown, logs it and checks again", async () => {
    expect((await approve()).pathname).toBe("/repos/5/pulls/4");
    expect(saved).toEqual([{ repoId: 5, number: 4, headSha: "head", baseRef: "main", userId: 1, reason: good.reason }]);
    expect(audits).toEqual([[9, 1, "self_approved", "https://gh/pull/4 head"]]);
    expect(checks).toMatchObject([{ installationId: 3, repoId: 77, number: 4, authorId: 1, headSha: "head", baseRef: "main" }]);
  });

  it.each<[string, (s: typeof state) => void]>([
    ["is not signed in", (s) => void (s.user = null)],
    ["has no role", (s) => void (s.role = null)],
    ["is a member", (s) => void Object.assign(s, { role: "member", standing: "member" })],
    ["is a Team Leader", (s) => void Object.assign(s, { role: "team_leader", standing: "member" })],
    ["is a stored Owner who is no longer an admin", (s) => void (s.standing = "member")],
    ["has left", (s) => void (s.standing = "outside")],
    ["is not alone in the organization", (s) => void (s.alone = false)],
    ["can only read the repo", (s) => void (s.level = "read")],
    ["cannot open the repo", (s) => void (s.level = null)],
    ["did not write the pull request", (s) => void (s.pull.user = { id: 2, login: "bob" })],
    ["is looking at a closed pull request", (s) => void (s.pull.state = "closed")],
    ["is looking at one that does not exist", (s) => void (s.pull = null)],
    ["is looking at one that leaves the rules alone", (s) => void (s.head = strict)],
    ["cannot be checked because GitHub is down", (s) => void (s.down = true)],
  ])("is refused when the person %s", async (_n, change) => {
    change(state);
    expect((await approve()).searchParams.get("error")).toBeTruthy();
    expect(saved).toEqual([]);
    expect(checks).toEqual([]);
  });

  it.each<[string, Record<string, string>]>([
    ["another commit than the one shown", { sha: "older" }],
    ["no commit", { sha: "" }],
    ["another base branch", { base: "dev" }],
    ["no reason", { reason: "" }],
    ["an empty looking reason", { reason: "............" }],
    ["an unknown action", { action: "merge" }],
  ])("is refused for %s", async (_n, over) => {
    expect((await approve(over)).searchParams.get("error")).toBeTruthy();
    expect(saved).toEqual([]);
  });

  it.each([null, "null", "http://localhost:4000", "https://evil.test"])("is refused when the form comes from %j", async (origin) => {
    await approve({}, origin);
    await approve({ action: "withdraw" }, origin);
    expect([saved, withdrawn]).toEqual([[], []]);
  });

  it.each(["4/../../x", "-1", "1e3", ""])("ignores %j as a pull request number", async (number) => {
    await approve({}, undefined, number);
    expect(saved).toEqual([]);
  });

  it("can be withdrawn, which checks again", async () => {
    await approve({ action: "withdraw" });
    expect(withdrawn).toEqual([[5, 4, 1]]);
    expect(checks).toHaveLength(1);
    state.level = null;
    expect((await approve({ action: "withdraw" })).search).not.toContain("secret");
    expect(withdrawn).toHaveLength(1);
  });
});

describe("pull request page", () => {
  it("shows what changes and the form only to someone who may use it", async () => {
    const text = await html();
    expect(text).toContain("Removes rule LAYER01");
    expect(text).toContain('name="sha" value="head"');
    expect(text).toContain("Loosen &lt;b&gt;rules&lt;/b&gt;");
    for (const change of [{ alone: false }, { standing: "member" }, { level: "read" }, { pull: { ...state.pull, user: { id: 2, login: "bob" } } }, { head: strict }]) {
      state = Object.assign(fresh(), change);
      expect(await html()).not.toContain("<form");
    }
  });

  it("shows an approval, and lets only its giver withdraw it", async () => {
    state.approval = { kind: "self_approved", login: "ann", reason: "<i>why</i>" };
    state.own = { id: 1 };
    expect(await html()).toContain("Withdraw");
    expect(await html()).toContain("&lt;i&gt;why");
    state.pull.user = { id: 2, login: "bob" };
    expect(await html()).not.toContain("<form");
  });

  it("stays hidden from people without access", async () => {
    for (const change of [{ level: null }, { role: null }, { down: true }, { pull: null }]) {
      state = Object.assign(fresh(), change);
      await expect(html()).rejects.toThrow("NOT_FOUND");
    }
    state = Object.assign(fresh(), { user: null });
    await expect(html()).rejects.toThrow("REDIRECT");
  });
});

describe("Team Leaders", () => {
  const set = (over: Record<string, string> = {}, origin?: string | null) => post(rolesPost, { id: "9" }, { user: "2", role: "team_leader", ...over }, origin);
  beforeEach(() => void (state.standings = { ann: "owner", bob: "member" }));

  it("are chosen by an Owner, and logged", async () => {
    expect((await set()).pathname).toBe("/orgs/9");
    await set({ role: "member" });
    expect(leaders).toEqual([[2, 9, true], [2, 9, false]]);
    expect(audits[0]).toEqual([9, 1, "role_changed", "bob (2) to team_leader"]);
  });

  it.each<[string, (s: typeof state) => void, Record<string, string>]>([
    ["by someone not signed in", (s) => void (s.user = null), {}],
    ["by a stored Owner who is no longer an admin", (s) => void (s.standings.ann = "member"), {}],
    ["by a Team Leader", (s) => void Object.assign(s, { role: "team_leader", standings: { ann: "member", bob: "member" } }), {}],
    ["by someone with no role", (s) => void (s.role = null), {}],
    ["while GitHub is down", (s) => void (s.down = true), {}],
    ["for someone outside the organization", (s) => void (s.standings.bob = "outside"), {}],
    ["for an admin, who is an Owner already", (s) => void (s.standings.bob = "owner"), {}],
    ["for a stranger", () => {}, { user: "77" }],
    ["on a personal account", (s) => void (s.type = "User"), {}],
    ["to Owner", () => {}, { role: "owner" }],
  ])("cannot be set %s", async (_n, change, over) => {
    change(state);
    expect((await set(over)).searchParams.get("error")).toBeTruthy();
    expect(leaders).toEqual([]);
  });

  it("cannot be set from another site", async () => {
    for (const o of [null, "null", "https://evil.test"]) await set({}, o);
    expect(leaders).toEqual([]);
  });

  it("can be removed after they left the organization", async () => {
    state.standings.bob = "outside";
    await set({ role: "member" });
    expect(leaders).toEqual([[2, 9, false]]);
  });

  it("have a page that only Owners can open", async () => {
    const page = () => PeoplePage({ params: Promise.resolve({ id: "9" }), searchParams: Promise.resolve({}) });
    expect(renderToStaticMarkup(await page())).toContain("Make Team Leader");
    state.type = "User";
    expect(renderToStaticMarkup(await page())).not.toContain("<form");
    state.standings.ann = "member";
    await expect(page()).rejects.toThrow("NOT_FOUND");
  });
});

describe("adding decisions to the repo", () => {
  const add = (origin?: string | null) => post(decisionsPost, { id: "5" }, {}, origin);
  const d = (n: number) => ({ github_repo_id: 77, pr_number: n, kind: "approved", title: "T", changes: ["c"], reason: "r", approved_by: "ann", merged_by: "ann", head_sha: "h", merged_at: "2026" });

  it("opens a pull request with only the missing ones", async () => {
    state.decisions = [d(4), d(6)];
    state.tree = ["voxium/decisions/pr-4.md"];
    expect((await add()).href).toBe("https://gh/pull/8");
    expect(Object.keys(opened[0].files)).toEqual(["voxium/decisions/pr-6.md"]);
    expect(opened[0].pr.branch).toBe("voxium/decisions");
  });

  it("does nothing without decisions, access or a form from here", async () => {
    await add();
    state.decisions = [d(4)];
    await add("https://evil.test");
    for (const change of [{ level: "read" }, { level: null }, { standing: "member" }, { role: "member", standing: "member" }, { down: true }, { user: null }]) {
      state = Object.assign(fresh(), { decisions: [d(4)] }, change);
      await add();
    }
    expect(opened).toEqual([]);
  });
});
