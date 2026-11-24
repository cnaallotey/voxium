import { gzipSync } from "node:zlib";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSetup } from "./analysis";
import { currentApprovals } from "./approval";
import { prEventFrom } from "./webhook";

const roles: Record<number, string> = {};
const saved: unknown[] = [];
let saveFails = false;

vi.mock("./env", () => ({
  getEnv: () => ({ DB: {}, APP_URL: "https://vx.test", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: key }),
}));
vi.mock("./store", () => ({
  getRepoByGithubId: async (_db: unknown, id: number) => (id === 77 ? { id: 5, org_id: 9 } : null),
  getOrg: async () => ({ id: 9, installation_id: 3 }),
  getRoleByGithubUser: async (_db: unknown, id: number) => roles[id] ?? null,
  saveAnalysis: async (_db: unknown, a: unknown) => {
    if (saveFails) throw new Error("db down");
    saved.push(a);
  },
}));

const { runPullRequestCheck, statusContext } = await import("./repo-job");
const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

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
  exportIgnore?: string[]; // left out of the tarball, as .gitattributes can do
  truncated?: boolean;
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
      return json({ truncated: w.truncated ?? false, tree: Object.keys(w.commits[m[1]]).map((path) => ({ path, type: "blob" })) });
    }
    if ((m = p.match(/\/tarball\/(\w+)/))) {
      const files = Object.entries(w.commits[m[1]]).filter(([f]) => !w.exportIgnore?.includes(f));
      return new Response(gzipSync(Buffer.concat([...files.map(([f, c]) => tarEntry(f, c)), Buffer.alloc(1024)])));
    }
    if (p.includes("/reviews")) return json(w.reviews ?? []);
    if ((m = p.match(/\/collaborators\/(\w+)\/permission/))) return json({ permission: w.writers?.includes(m[1]) ? "write" : "read" });
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
  saveFails = false;
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
    expect(prEventFrom("pull_request_review", { ...body, action: "dismissed" })).toEqual(ev);
    expect(prEventFrom("pull_request_review", { ...body, action: "submitted", pull_request: { ...body.pull_request, state: "closed" } })).toBeNull();
    expect(prEventFrom("issue_comment", { ...body, action: "created" })).toBeNull();
  });
});
