import { gzipSync } from "node:zlib";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSetup } from "./analysis";
import { currentApprovals } from "./approval";
import { closedPrFrom, prEventFrom } from "./webhook";

const roles: Record<number, string> = {};
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
  getOrg: async () => ({ id: 9, installation_id: 3, account_id: 50, account_login: "o", account_type: "Organization" }),
  getRoleByGithubUser: async (_db: unknown, id: number) => roles[id] ?? null,
  beginCheck: async (_db: unknown, id: number, sha: string, context: string) => {
    if (beginFails) throw new Error("db down");
    const k = `${id} ${sha} ${context}`;
    runs.set(k, (runs.get(k) ?? 0) + 1);
    return runs.get(k);
  },
  isLatestCheck: async (_db: unknown, id: number, sha: string, context: string, run: number) => runs.get(`${id} ${sha} ${context}`) === run,
  setRepoSetup: async (_db: unknown, id: number, status: string, url: string | null) => void setups.push([id, status, url]),
  saveAnalysis: async (_db: unknown, a: unknown) => {
    if (saveFails) throw new Error("db down");
    saved.push(a);
  },
}));

const { runPullRequestCheck, statusContext, updateSetupStatus } = await import("./repo-job");
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
  const closed = (over = {}) => ({ installationId: 3, repoId: 77, fullName: "o/r", defaultBranch: "main", merged: true, url: SETUP_URL as string | null, ...over });
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
      pull_request: { number: 1, state: "closed", merged: true, html_url: SETUP_URL, user: { id: 100 }, head: { sha: "head" }, base: { ref: "main" } },
    };
    expect(closedPrFrom("pull_request", body)).toEqual(closed());
    expect(closedPrFrom("pull_request", { ...body, pull_request: { ...body.pull_request, merged: false } })).toEqual(closed({ merged: false }));
    expect(closedPrFrom("pull_request", { ...body, pull_request: { ...body.pull_request, base: { ref: "dev" } } })).toBeNull();
    expect(closedPrFrom("pull_request", { ...body, action: "opened" })).toBeNull();
    expect(closedPrFrom("pull_request_review", body)).toBeNull();
    expect(prEventFrom("pull_request", body)).toBeNull();
  });
});
