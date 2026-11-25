import { gzipSync } from "node:zlib";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSetup } from "./analysis";
import { currentApprovals } from "./approval";
import { closedPrFrom, prEventFrom } from "./webhook";

const roles: Record<number, string> = {};
let own: { github_id: number; login: string; reason: string; for: object } | null = null;
let decisions: any[] = [];
let account: object = {};
const saved: unknown[] = [];
const SETUP_URL = "https://gh/o/r/pull/1";
let repoState = { status: "active", setup_pr_url: SETUP_URL as string | null };
const setups: unknown[] = [];
let saveFails = false;
let beginFails = false;
const runs = new Map<string, number>();

vi.mock("./env", () => ({
  getEnv: () => ({ DB: {}, APP_URL: "https://vx.test", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: key }),
}));
vi.mock("./store", () => ({
  getRepoByGithubId: async (_db: unknown, id: number) => (id === 77 ? { id: 5, org_id: 9, ...repoState } : null),
  getOrg: async () => ({ id: 9, installation_id: 3, account_id: 50, account_login: "o", account_type: "Organization", ...account }),
  getRoleByGithubUser: async (_db: unknown, id: number) => roles[id] ?? null,
  beginCheck: async (_db: unknown, id: number, sha: string, context: string) => {
    if (beginFails) throw new Error("db down");
    const k = `${id} ${sha} ${context}`;
    runs.set(k, (runs.get(k) ?? 0) + 1);
    return runs.get(k);
  },
  isLatestCheck: async (_db: unknown, id: number, sha: string, context: string, run: number) => runs.get(`${id} ${sha} ${context}`) === run,
  getSelfApproval: async (_db: unknown, pull: object) => (own && JSON.stringify(own.for) === JSON.stringify(pull) ? own : null),
  saveDecision: async (_db: unknown, d: object) => void decisions.push(d),
  setRepoSetup: async (_db: unknown, id: number, status: string, url: string | null) => void setups.push([id, status, url]),
  saveAnalysis: async (_db: unknown, a: unknown) => {
    if (saveFails) throw new Error("db down");
    saved.push(a);
  },
}));

const { runPullRequestCheck, statusContext, updateSetupStatus } = await import("./repo-job");
const { recordDecision, renderDecision } = await import("./decisions");
const { cleanReason } = await import("./self-approval");
const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function blobSha(body: string): string {
  const data = Buffer.from(body);
  return crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

function tarEntry(name: string, body: string): Buffer {
  const data = Buffer.from(body);
  const h = Buffer.alloc(512);
  h.write(`r-sha/${name}`, 0);
  h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  h.write("0", 156);
  h.write("ustar\0", 257);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

type Files = Record<string, string>;
interface World {
  branches: Record<string, string>; // branch to sha
  commits: Record<string, Files>; // sha to files
  mergeBase: string;
  reviews?: unknown[];
  writers?: string[];
  /** Organization membership of the reviewer "lead". Null means not a member. */
  lead?: { id: number; role: string; state: string } | null;
  /** Ids of the organization's members. */
  members?: number[];
  exportIgnore?: string[]; // left out of the tarball, as .gitattributes can do
  /** Contents the archive holds instead of the committed ones, as .gitattributes can do. */
  altered?: Files;
  truncated?: boolean;
  /** Called when a tarball is requested, to hold a run back. */
  onTarball?: () => Promise<void>;
}

let statuses: Array<{ sha: string; context: string; state: string; description: string }>;

function github(w: World) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status });
    const p = decodeURIComponent(url.replace("https://api.github.com", ""));
    let m: RegExpMatchArray | null;
    if (p.startsWith("/app/installations/")) return json({ token: "t" }, 201);
    if ((m = p.match(/\/git\/ref\/heads\/(.+)$/))) return w.branches[m[1]] ? json({ object: { sha: w.branches[m[1]] } }) : json({}, 404);
    if (p.includes("/compare/")) return json({ merge_base_commit: { sha: w.mergeBase } });
    if ((m = p.match(/\/contents\/(.+)\?ref=(.+)$/))) {
      const text = w.commits[m[2]]?.[m[1]];
      return text === undefined ? json({}, 404) : new Response(text);
    }
    if ((m = p.match(/\/git\/trees\/(\w+)/))) {
      return json({ truncated: w.truncated ?? false, tree: Object.entries(w.commits[m[1]]).map(([path, c]) => ({ path, type: "blob", sha: blobSha(c) })) });
    }
    if ((m = p.match(/\/tarball\/(\w+)/))) {
      await w.onTarball?.();
      const files = Object.entries(w.commits[m[1]]).filter(([f]) => !w.exportIgnore?.includes(f));
      return new Response(gzipSync(Buffer.concat([...files.map(([f, c]) => tarEntry(f, w.altered?.[f] ?? c)), Buffer.alloc(1024)])));
    }
    if (p.includes("/reviews")) return json(w.reviews ?? []);
    if ((m = p.match(/\/collaborators\/(\w+)\/permission/))) {
      return json({ permission: w.writers?.includes(m[1]) ? "write" : "read", user: { id: 200 } });
    }
    if (p.startsWith("/orgs/o/members?")) return w.members ? json(w.members.slice(0, 2).map((id) => ({ id }))) : json({}, 403);
    if (p.startsWith("/orgs/o/memberships/lead")) {
      const lead = w.lead === undefined ? { id: 200, role: "member", state: "active" } : w.lead;
      return lead ? json({ role: lead.role, state: lead.state, user: { id: lead.id } }) : json({}, 404);
    }
    if ((m = p.match(/\/statuses\/(\w+)/))) {
      statuses.push({ sha: m[1], ...JSON.parse(String(init.body)) });
      return json({}, 201);
    }
    return json({ message: `unexpected ${p}` }, 500);
  });
}

const code: Files = {
  "src/ui/Page.ts": `import "../services/s";`,
  "src/services/s.ts": `import "../data/d";`,
  "src/data/d.ts": `export {};`,
};
const bad: Files = { ...code, "src/data/d.ts": `import "../ui/Page";` };
const setup = prepareSetup(code).setupFiles;
const ARCH = "voxium/architecture.json";
const rules: Files = { [ARCH]: setup[ARCH], "voxium/baseline.json": setup["voxium/baseline.json"] };
const weak: Files = { ...rules, [ARCH]: JSON.stringify({ ...JSON.parse(rules[ARCH]), rules: [] }) };

const ev = {
  installationId: 3, repoId: 77, fullName: "o/r", defaultBranch: "main", number: 4, authorId: 100, headSha: "head", baseRef: "main",
};
const last = () => statuses.filter((s) => s.state !== "pending").at(-1);

beforeEach(() => {
  statuses = [];
  saved.length = 0;
  setups.length = 0;
  own = null;
  decisions = [];
  account = {};
  repoState = { status: "active", setup_pr_url: SETUP_URL };
  saveFails = false;
  beginFails = false;
  runs.clear();
  for (const k of Object.keys(roles)) delete roles[Number(k)];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("pull request check", () => {
  it("reports clean and violating PRs on voxium/rules", async () => {
    github({ branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...code, ...rules } }, mergeBase: "m" });
    await runPullRequestCheck(ev);
    expect(last()).toMatchObject({ sha: "head", context: "voxium/rules", state: "success" });
    expect(saved).toHaveLength(1);

    github({ branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...bad, ...rules } }, mergeBase: "m" });
    await runPullRequestCheck(ev);
    expect(last()).toMatchObject({ context: "voxium/rules", state: "failure" });
  });

  it("a PR against a weak branch cannot touch the voxium/rules status of the same commit", async () => {
    const w: World = {
      branches: { main: "m", "attacker/scratch": "s" },
      commits: { m: { ...code, ...rules }, s: { ...code, ...weak }, head: { ...bad, ...rules } },
      mergeBase: "m",
    };
    github(w);
    await runPullRequestCheck(ev);
    await runPullRequestCheck({ ...ev, number: 5, baseRef: "attacker/scratch" });
    const onRules = statuses.filter((s) => s.context === "voxium/rules");
    expect(onRules.at(-1)!.state).toBe("failure");
    expect(onRules.some((s) => s.state === "success")).toBe(false);
    expect(statuses.at(-1)!.context).toBe("voxium/rules (attacker/scratch)");
    expect(statusContext("release/1", "main")).toBe("voxium/rules (release/1)");
  });

  it("fails when the PR deletes or weakens the rules, until a Team Leader approves this commit", async () => {
    const { [ARCH]: _gone, ...noArch } = rules;
    for (const headRules of [noArch, weak]) {
      const w: World = { branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...code, ...headRules } }, mergeBase: "m" };
      github(w);
      await runPullRequestCheck(ev);
      expect(last()).toMatchObject({ state: "failure" });

      roles[200] = "team_leader";
      github({ ...w, writers: ["lead"], reviews: [{ user: { id: 200, login: "lead", type: "User" }, state: "APPROVED", commit_id: "head" }] });
      await runPullRequestCheck(ev);
      expect(last()).toMatchObject({ state: "success" });
      expect(last()!.description).toMatch(/approved by lead/);
    }
  });

  it.each([
    ["a member", "member", ["lead"], "head"],
    ["someone unknown to the org", null, ["lead"], "head"],
    ["a Team Leader without write access", "team_leader", [], "head"],
    ["a Team Leader on an older commit", "team_leader", ["lead"], "older"],
  ])("does not accept approval from %s", async (_n, role, writers, commit) => {
    if (role) roles[200] = role;
    github({
      branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...code, ...weak } }, mergeBase: "m", writers,
      reviews: [{ user: { id: 200, login: "lead", type: "User" }, state: "APPROVED", commit_id: commit }],
    });
    await runPullRequestCheck(ev);
    expect(last()).toMatchObject({ state: "failure" });
  });

  it.each([
    ["a Team Leader who left the organization", "team_leader", null],
    ["a Team Leader whose invitation is pending", "team_leader", { id: 200, role: "member", state: "pending" }],
    ["someone who took over a Team Leader's old login", "team_leader", { id: 201, role: "member", state: "active" }],
    ["a stored Owner who is no longer an organization admin", "owner", { id: 200, role: "member", state: "active" }],
  ])("rechecks GitHub and does not accept approval from %s", async (_n, role, lead) => {
    roles[200] = role;
    github({
      branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...code, ...weak } }, mergeBase: "m", writers: ["lead"], lead,
      reviews: [{ user: { id: 200, login: "lead", type: "User" }, state: "APPROVED", commit_id: "head" }],
    });
    await runPullRequestCheck(ev);
    expect(last()).toMatchObject({ state: "failure" });
  });

  it("ignores approvals when the repo belongs to another installation", async () => {
    roles[200] = "owner";
    github({
      branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...code, ...weak } }, mergeBase: "m", writers: ["lead"],
      reviews: [{ user: { id: 200, login: "lead", type: "User" }, state: "APPROVED", commit_id: "head" }],
    });
    await runPullRequestCheck({ ...ev, installationId: 999 });
    expect(last()).toMatchObject({ state: "failure" });
  });

  it("does not pass when a file is hidden from the tarball or the tree is incomplete", async () => {
    const w: World = { branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...bad, ...rules } }, mergeBase: "m" };
    github({ ...w, exportIgnore: ["src/data/d.ts"] });
    await runPullRequestCheck(ev);
    expect(last()).toMatchObject({ state: "error" });
    expect(last()!.description).toMatch(/src\/data\/d\.ts/);

    github({ ...w, commits: { ...w.commits, head: { ...code, ...rules } }, truncated: true });
    await runPullRequestCheck(ev);
    expect(last()).toMatchObject({ state: "error" });
  });

  it("does not pass when the archive holds other contents than the commit", async () => {
    github({
      branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...bad, ...rules } }, mergeBase: "m",
      altered: { "src/data/d.ts": "export {};" }, // what the scanner would see
    });
    await runPullRequestCheck(ev);
    expect(last()).toMatchObject({ state: "error" });
    expect(last()!.description).toMatch(/src\/data\/d\.ts/);
  });

  it("accepts archives that only converted line endings", async () => {
    const crlf = Object.fromEntries(Object.entries(code).map(([f, c]) => [f, `${c}\n\n`]));
    github({
      branches: { main: "m" }, commits: { m: { ...crlf, ...rules }, head: { ...crlf, ...rules } }, mergeBase: "m",
      altered: Object.fromEntries(Object.entries(crlf).map(([f, c]) => [f, c.replace(/\n/g, "\r\n")])),
    });
    await runPullRequestCheck(ev);
    expect(last()).toMatchObject({ state: "success" });
  });

  it("a slow older run cannot replace a newer verdict", async () => {
    roles[200] = "team_leader";
    const approval = [{ user: { id: 200, login: "lead", type: "User" }, state: "APPROVED", commit_id: "head" }];
    const w: World = { branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...code, ...weak } }, mergeBase: "m", writers: ["lead"] };
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let reached = () => {};
    const downloading = new Promise<void>((r) => (reached = r));
    github({ ...w, reviews: approval, onTarball: async () => { reached(); await held; } });
    const slow = runPullRequestCheck(ev); // saw the approval
    await downloading;
    const slowFetch = globalThis.fetch;
    github({ ...w, reviews: [{ ...approval[0], state: "DISMISSED" }] });
    await runPullRequestCheck({ ...ev, reviewerId: 200 });
    expect(last()).toMatchObject({ state: "failure" });
    vi.stubGlobal("fetch", slowFetch); // the slow run still sees its approval
    release();
    await slow;
    expect(last()).toMatchObject({ state: "failure" });
    expect(saved).toHaveLength(1);
  });

  it("leaves the status alone for reviews that cannot change it", async () => {
    const w: World = { branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...code, ...weak } }, mergeBase: "m" };
    github(w);
    await runPullRequestCheck({ ...ev, reviewerId: 999 }); // nobody here
    expect(statuses).toEqual([]);

    roles[200] = "team_leader";
    github({ ...w, commits: { ...w.commits, head: { ...code, ...rules } } }); // nothing to approve
    await runPullRequestCheck({ ...ev, reviewerId: 200 });
    expect(statuses).toEqual([]);

    github(w);
    await runPullRequestCheck({ ...ev, reviewerId: 200 });
    expect(last()).toMatchObject({ state: "failure" });
  });

  it("does not leave an earlier pass in place when a check cannot start", async () => {
    beginFails = true;
    github({ branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...code, ...rules } }, mergeBase: "m" });
    await runPullRequestCheck(ev);
    expect(last()).toMatchObject({ state: "error" });
  });

  it("keeps the verdict when results cannot be stored, and errors when GitHub fails", async () => {
    saveFails = true;
    github({ branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...code, ...rules } }, mergeBase: "m" });
    await runPullRequestCheck(ev);
    expect(last()).toMatchObject({ state: "success" });

    github({ branches: {}, commits: {}, mergeBase: "m" });
    await runPullRequestCheck(ev);
    expect(last()).toMatchObject({ state: "error" });
  });

  it("says nothing when the base branch is not set up", async () => {
    github({ branches: { main: "m" }, commits: { m: code, head: { ...code, ...rules } }, mergeBase: "m" });
    await runPullRequestCheck(ev);
    expect(statuses).toEqual([]);
  });
});

describe("approvals", () => {
  const r = (id: number, state: string, commit = "h", type = "User") => ({ user: { id, login: `u${id}`, type }, state, commit_id: commit });
  const ids = (reviews: ReturnType<typeof r>[]) => currentApprovals(reviews, "h", 1).map((a) => a.id);

  it("counts only each person's latest verdict on this commit", () => {
    expect(ids([r(2, "APPROVED")])).toEqual([2]);
    expect(ids([r(2, "APPROVED"), r(2, "COMMENTED")])).toEqual([2]);
    expect(ids([r(2, "APPROVED"), r(2, "CHANGES_REQUESTED")])).toEqual([]);
    expect(ids([r(2, "DISMISSED")])).toEqual([]);
    expect(ids([r(2, "APPROVED", "old")])).toEqual([]);
  });

  it("never counts the author or a bot", () => {
    expect(ids([r(1, "APPROVED"), r(3, "APPROVED", "h", "Bot")])).toEqual([]);
  });
});

describe("webhook events", () => {
  const body = {
    installation: { id: 3 },
    repository: { id: 77, full_name: "o/r", default_branch: "main" },
    pull_request: { number: 4, state: "open", user: { id: 100 }, head: { sha: "head" }, base: { ref: "main" } },
  };

  it("checks pushes, base changes and reviews, and ignores the rest", () => {
    expect(prEventFrom("pull_request", { ...body, action: "synchronize" })).toEqual(ev);
    expect(prEventFrom("pull_request", { ...body, action: "edited", changes: { base: {} } })).toEqual(ev);
    expect(prEventFrom("pull_request", { ...body, action: "edited", changes: {} })).toBeNull();
    const review = (action: string, state: string, over = {}) =>
      prEventFrom("pull_request_review", { ...body, action, review: { state, user: { id: 200 } }, ...over });
    expect(review("dismissed", "dismissed")).toEqual({ ...ev, reviewerId: 200 });
    expect(review("submitted", "approved")).toEqual({ ...ev, reviewerId: 200 });
    expect(review("submitted", "changes_requested")).toEqual({ ...ev, reviewerId: 200 });
    expect(review("submitted", "commented")).toBeNull();
    expect(review("edited", "approved")).toBeNull();
    expect(review("submitted", "approved", { pull_request: { ...body.pull_request, state: "closed" } })).toBeNull();
    expect(prEventFrom("issue_comment", { ...body, action: "created" })).toBeNull();
  });
});

describe("setup status", () => {
  const OPEN = { status: "setup_pr_open", setup_pr_url: SETUP_URL };
  const closed = (over = {}) => ({ installationId: 3, repoId: 77, fullName: "o/r", defaultBranch: "main", merged: true, url: SETUP_URL as string | null, number: 1, title: "T", authorId: 100, headSha: "head", baseSha: "m", baseRef: "main", mergedBy: "ann", closedAt: "2026-01-01T00:00:00Z", ...over });
  const withRules = () => github({ branches: { main: "m" }, commits: { m: { ...code, ...rules } }, mergeBase: "m" });
  const withoutRules = () => github({ branches: { main: "m" }, commits: { m: code }, mergeBase: "m" });

  it("becomes active when a merge brings the rules into the default branch, whichever pull request it was", async () => {
    for (const [status, url] of [["setup_pr_open", SETUP_URL], ["connected", "https://gh/o/r/pull/9"]]) {
      setups.length = 0;
      repoState = { ...OPEN, status };
      withRules();
      await updateSetupStatus(closed({ url }));
      expect(setups).toEqual([[5, "active", SETUP_URL]]);
    }
  });

  it("stays as it is when the merge did not bring rules", async () => {
    repoState = OPEN;
    withoutRules();
    await updateSetupStatus(closed({ url: "https://gh/o/r/pull/9" }));
    expect(setups).toEqual([]);
  });

  it("goes back to not set up only when its own setup pull request is closed unmerged", async () => {
    withoutRules();
    repoState = OPEN;
    await updateSetupStatus(closed({ merged: false, url: "https://gh/o/r/pull/9" }));
    await updateSetupStatus(closed({ merged: false, url: null }));
    expect(setups).toEqual([]);
    await updateSetupStatus(closed({ merged: false }));
    expect(setups).toEqual([[5, "connected", null]]);
  });

  it("leaves an active repo, an unknown repo and another installation's repo alone", async () => {
    withRules();
    await updateSetupStatus(closed());
    await updateSetupStatus(closed({ merged: false }));
    repoState = OPEN;
    await updateSetupStatus(closed({ repoId: 78 }));
    await updateSetupStatus(closed({ installationId: 4 }));
    await updateSetupStatus(closed({ installationId: 4, merged: false }));
    expect(setups).toEqual([]);
  });

  it("does not throw when GitHub is down", async () => {
    repoState = OPEN;
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    await updateSetupStatus(closed());
    expect(setups).toEqual([]);
  });

  it("is also corrected by a check against the default branch, and only that one", async () => {
    repoState = OPEN;
    github({ branches: { main: "m", dev: "m" }, commits: { m: { ...code, ...rules }, head: { ...code, ...rules } }, mergeBase: "m" });
    await runPullRequestCheck({ ...ev, baseRef: "dev" });
    expect(setups).toEqual([]);
    await runPullRequestCheck(ev);
    expect(setups).toEqual([[5, "active", SETUP_URL]]);
    expect(last()).toMatchObject({ state: "success" });
  });

  it("follows closed pull requests into the default branch only", () => {
    const body = {
      action: "closed", installation: { id: 3 }, repository: { id: 77, full_name: "o/r", default_branch: "main" },
      pull_request: { number: 1, title: "T", state: "closed", merged: true, merged_by: { login: "ann" }, closed_at: "2026-01-01T00:00:00Z", html_url: SETUP_URL, user: { id: 100 }, head: { sha: "head" }, base: { ref: "main", sha: "m" } },
    };
    expect(closedPrFrom("pull_request", body)).toEqual(closed());
    expect(closedPrFrom("pull_request", { ...body, pull_request: { ...body.pull_request, merged: false } })).toEqual(closed({ merged: false }));
    expect(closedPrFrom("pull_request", { ...body, pull_request: { ...body.pull_request, base: { ref: "dev", sha: "m" } } })).toBeNull();
    expect(closedPrFrom("pull_request", { ...body, action: "opened" })).toBeNull();
    expect(closedPrFrom("pull_request_review", body)).toBeNull();
    expect(prEventFrom("pull_request", body)).toBeNull();
  });
});

describe("solo approval", () => {
  // The author, id 200, is also the owner. "lead" is their login.
  const mine = { ...ev, authorId: 200 };
  const given = { github_id: 200, login: "lead", reason: "We are moving to features", for: { repoId: 5, number: 4, headSha: "head", baseRef: "main" } };
  const owner = { id: 200, role: "admin", state: "active" };
  const world = (over: Partial<World> = {}): World => ({
    branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...code, ...weak } }, mergeBase: "m",
    writers: ["lead"], lead: owner, members: [200], ...over,
  });

  it("lets a sole owner's reasoned approval of their own pull request count", async () => {
    roles[200] = "owner";
    github(world());
    await runPullRequestCheck(mine);
    expect(last()).toMatchObject({ state: "failure" });
    own = given;
    await runPullRequestCheck(mine);
    expect(last()).toMatchObject({ state: "success" });
    expect(last()!.description).toContain("approved by lead (own pull request)");
  });

  it("works for the holder of a personal account, and nobody else", async () => {
    roles[200] = "owner";
    own = given;
    account = { account_type: "User", account_id: 200 };
    github(world({ members: undefined }));
    await runPullRequestCheck(mine);
    expect(last()).toMatchObject({ state: "success" });
    account = { account_type: "User", account_id: 201 };
    await runPullRequestCheck(mine);
    expect(last()).toMatchObject({ state: "failure" });
    account = { account_type: "Mystery", account_id: 200 };
    await runPullRequestCheck(mine);
    expect(last()).toMatchObject({ state: "failure" });
  });

  it.each<[string, () => void, Partial<World>, object]>([
    ["someone else is in the organization", () => {}, { members: [200, 300] }, {}],
    ["the only member is someone else", () => {}, { members: [300] }, {}],
    ["they are no longer an admin", () => {}, { lead: { id: 200, role: "member", state: "active" } }, {}],
    ["they left", () => {}, { lead: null }, {}],
    ["someone took over their login", () => {}, { lead: { id: 201, role: "admin", state: "active" } }, {}],
    ["they lost write access", () => {}, { writers: [] }, {}],
    ["they have no role on record", () => void delete roles[200], {}, {}],
    ["it was for another commit", () => void (own = { ...given, for: { ...given.for, headSha: "older" } }), {}, {}],
    ["it was for another base branch", () => void (own = { ...given, for: { ...given.for, baseRef: "dev" } }), {}, {}],
    ["it was for another pull request", () => void (own = { ...given, for: { ...given.for, number: 9 } }), {}, {}],
    ["the pull request is someone else's", () => {}, {}, { authorId: 100 }],
  ])("stops counting when %s", async (_n, change, over, event) => {
    roles[200] = "owner";
    own = given;
    change();
    github(world(over));
    await runPullRequestCheck({ ...mine, ...event });
    expect(last()).toMatchObject({ state: "failure" });
  });

  it("is an error, never a pass, when GitHub cannot list the members", async () => {
    roles[200] = "owner";
    own = given;
    github(world({ members: undefined }));
    await runPullRequestCheck(mine);
    expect(last()).toMatchObject({ state: "error" });
  });

  it("needs a real reason", () => {
    for (const bad of [null, undefined, "", "ok", "          ", "..............", "a b c", "x".repeat(2001), {}]) expect(cleanReason(bad)).toBeNull();
    expect(cleanReason("  We split billing\r\ninto two modules\u0000 ")).toBe("We split billing\ninto two modules");
  });
});

describe("decision log", () => {
  const merged = (over = {}) => ({
    installationId: 3, repoId: 77, fullName: "o/r", defaultBranch: "main", merged: true, url: null, number: 4, title: "Drop the rules",
    authorId: 100, headSha: "head", baseSha: "m", baseRef: "main", mergedBy: "ann", closedAt: "2026-01-01T00:00:00Z", ...over,
  });
  const change = (head: Files, m: Files = { ...code, ...rules }, over: Partial<World> = {}) =>
    github({ branches: { main: "after" }, commits: { m, head, after: head }, mergeBase: "m", ...over });

  it("records who approved a change and why", async () => {
    roles[200] = "team_leader";
    change({ ...code, ...weak }, undefined, {
      writers: ["lead"], reviews: [{ user: { id: 200, login: "lead", type: "User" }, state: "APPROVED", commit_id: "head", body: " Agreed on Monday " }],
    });
    await recordDecision(merged());
    expect(decisions).toMatchObject([{ github_repo_id: 77, pr_number: 4, kind: "approved", approved_by: "lead", reason: "Agreed on Monday", merged_by: "ann" }]);
    expect(decisions[0].changes.join()).toContain("Removes rule LAYER01");
  });

  it("records a solo approval with its reason", async () => {
    roles[200] = "owner";
    own = { github_id: 200, login: "lead", reason: "We are moving", for: { repoId: 5, number: 4, headSha: "head", baseRef: "main" } };
    change({ ...code, ...weak }, undefined, { writers: ["lead"], lead: { id: 200, role: "admin", state: "active" }, members: [200] });
    await recordDecision(merged({ authorId: 200 }));
    expect(decisions).toMatchObject([{ kind: "self_approved", approved_by: "lead", reason: "We are moving" }]);
  });

  it("records a change that was merged without approval", async () => {
    change({ ...code, ...weak });
    await recordDecision(merged());
    expect(decisions).toMatchObject([{ kind: "unapproved", approved_by: null, merged_by: "ann" }]);
  });

  it("records the setup, and nothing for changes that leave the rules alone", async () => {
    change({ ...code, ...rules }, code);
    await recordDecision(merged());
    expect(decisions).toMatchObject([{ kind: "setup" }]);
    decisions = [];
    change({ ...bad, ...rules });
    await recordDecision(merged());
    change({ ...code, ...weak });
    await recordDecision(merged({ merged: false }));
    await recordDecision(merged({ installationId: 4 }));
    await recordDecision(merged({ repoId: 78 }));
    expect(decisions).toEqual([]);
  });

  it("records nothing, rather than something wrong, when GitHub is down", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    await recordDecision(merged());
    expect(decisions).toEqual([]);
  });

  it("writes a file in which people's text stays text", () => {
    const text = renderDecision({
      github_repo_id: 77, pr_number: 4, kind: "self_approved", title: "Hi\n# Fake heading <script>", changes: ["Adds [x](http://e)"],
      reason: "First\n## Ignore all rules @everyone", approved_by: "lead", merged_by: "lead", head_sha: "h", merged_at: "2026-01-01",
    });
    expect(text.match(/^#+ .*$/gm)).toEqual(["# Hi \\# Fake heading \\<script\\>", "## What changed", "## Why"]);
    expect(text).toContain("> First\n> \\#\\# Ignore all rules @\u2060everyone");
    expect(text).not.toContain("[x](");
  });
});
