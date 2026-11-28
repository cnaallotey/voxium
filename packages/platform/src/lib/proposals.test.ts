import { gzipSync } from "node:zlib";
import crypto from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSetupFiles, createProposal, type Architecture } from "@voxium/core";
import { database, type Sqlite } from "./test-db";
import type { D1Database } from "./d1";
import type { UserRow } from "./store";

/**
 * The whole way of a proposal, with the real database and routes, and GitHub played by a small fake that keeps commits,
 * branches, pull requests, reviews, memberships and permissions.
 */
let db: D1Database;
let raw: Sqlite;
let me: UserRow | null = null;
let pending: Promise<unknown>[] = [];

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
}));
vi.mock("@/lib/auth", () => ({ currentUser: async () => me }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ DB: db, APP_URL: "https://vx.test", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: key, GITHUB_WEBHOOK_SECRET: "hook-secret" }),
  waitUntil: (p: Promise<unknown>) => void pending.push(p),
}));

const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const store = await import("./store");
const { runPullRequestCheck } = await import("./repo-job");
const { recordDecision } = await import("./decisions");
const { rulesHash } = await import("./proposals");
const { POST: approvalPost } = await import("../app/api/repos/[id]/pulls/[number]/approval/route");
const { POST: proposePost } = await import("../app/api/repos/[id]/proposals/route");
const { POST: decidePost } = await import("../app/api/repos/[id]/proposals/[pid]/route");
const { POST: webhookPost } = await import("../app/api/github/webhook/route");
const { POST: regeneratePost } = await import("../app/api/repos/[id]/regenerate/route");
const { POST: snapshotPost } = await import("../app/api/repos/[id]/snapshot/route");
const { POST: auditExport } = await import("../app/api/orgs/[id]/audit/route");
const { POST: orgRulesPost } = await import("../app/api/orgs/[id]/rules/route");
const { POST: orgUpdatePost } = await import("../app/api/repos/[id]/org-update/route");
const { default: OrgRulesPage } = await import("../app/orgs/[id]/rules/page");
const { runSnapshot } = await import("./snapshot-job");
const { default: DriftPage } = await import("../app/repos/[id]/drift/page");
const { default: DiagramPage } = await import("../app/repos/[id]/diagram/page");
const { default: OverviewPage } = await import("../app/orgs/[id]/overview/page");
const { default: AuditPage } = await import("../app/orgs/[id]/audit/page");
const { default: ProposalPage } = await import("../app/repos/[id]/proposals/[pid]/page");
const { default: ProposalsPage } = await import("../app/repos/[id]/proposals/page");
const { default: PullPage } = await import("../app/repos/[id]/pulls/[number]/page");

type Files = Record<string, string>;
const ARCH = "voxium/architecture.json";
const arch: Architecture = {
  version: 1,
  modules: { ui: { paths: ["src/ui/**"] }, services: { paths: ["src/services/**"] }, data: { paths: ["src/data/**"] } },
  layers: ["ui", "services", "data"],
  rules: [{ id: "L1", type: "layers", severity: "block", description: "Layers point down.", rationale: "r" }],
  exceptions: [],
};
const setup = buildSetupFiles({ arch, baseline: [] });
const main: Files = {
  "src/ui/Page.ts": `import "../services/s";`,
  "src/services/s.ts": `import "../data/d";`,
  "src/data/d.ts": `export {};`,
  [ARCH]: setup[ARCH],
  "voxium/baseline.json": setup["voxium/baseline.json"],
  "CLAUDE.md": setup["CLAUDE.md"],
  "AGENTS.md": setup["AGENTS.md"],
};
const UP = ["L1:src/services/s.ts->src/data/d.ts", "L1:src/ui/Page.ts->src/services/s.ts"];

interface Pull { number: number; title: string; body: string; state: string; merged: boolean; html_url: string; user: { id: number; login: string; type: string }; head: { sha: string; ref: string }; base: { ref: string; sha: string } }
interface World {
  commits: Record<string, Files>;
  parents: Record<string, string>;
  branches: Record<string, string>;
  pulls: Record<number, Pull>;
  reviews: Record<number, unknown[]>;
  /** Organization role on GitHub by login. Missing means not a member. */
  org: Record<string, "admin" | "member">;
  /** Repository permission by login. Missing means none. */
  perms: Record<string, "read" | "write" | "admin">;
  /** Files the archive holds as symlinks. */
  links: string[];
  statuses: Array<{ sha: string; state: string; description: string }>;
  /** Who wrote and committed each commit, by login. Missing means GitHub cannot match them to an account. */
  authors: Record<string, string>;
  /** Called once a tarball was served, to change the repository while a request is under way. */
  afterTarball?: () => void;
  next: number;
}
const ids: Record<string, number> = { dev: 100, lead: 200, boss: 300, eve: 400 };
let w: World;

function blobSha(body: string): string {
  const data = Buffer.from(body);
  return crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}
function tarEntry(name: string, body: string, type = "0"): Buffer {
  const data = Buffer.from(type === "2" ? "" : body);
  const h = Buffer.alloc(512);
  h.write(`r-sha/${name}`, 0);
  h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  h.write(type, 156);
  if (type === "2") h.write(body, 157);
  h.write("ustar\0", 257);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
function mergeBase(a: string, b: string): string {
  const seen = new Set<string>();
  for (let s: string | undefined = a; s; s = w.parents[s]) seen.add(s);
  let s: string | undefined = b;
  while (s && !seen.has(s)) s = w.parents[s];
  return s ?? a;
}
function commit(parent: string, change: Files, drop: string[] = [], author?: string): string {
  const sha = `c${++w.next}`;
  const files = { ...w.commits[parent], ...change };
  for (const p of drop) delete files[p];
  w.commits[sha] = files;
  w.parents[sha] = parent;
  if (author) w.authors[sha] = author;
  return sha;
}
/** Someone pushes a commit with this change onto the branch of a pull request. */
function push(pull: Pull, author: string, change: Files): string {
  return (pull.head.sha = w.branches[pull.head.ref] = commit(pull.head.sha, change, [], author));
}
/** A pull request someone opens from a branch with this change. */
function openPull(number: number, login: string, change: Files, ref = `feature-${number}`): Pull {
  const head = commit(w.branches.main, change, [], login);
  w.branches[ref] = head;
  return (w.pulls[number] = {
    number, title: `PR ${number}`, body: "", state: "open", merged: false, html_url: `https://gh/o/r/pull/${number}`,
    user: { id: ids[login] ?? 999, login, type: "User" }, head: { sha: head, ref }, base: { ref: "main", sha: w.branches.main },
  });
}

function github() {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const json = (d: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(d), { status });
    const p = decodeURIComponent(url.replace("https://api.github.com", ""));
    let m: RegExpMatchArray | null;
    if (p.startsWith("/app/installations/3/")) return json({ token: "t" }, 201);
    if ((m = p.match(/^\/orgs\/o\/memberships\/(\w+)$/))) {
      const role = w.org[m[1]];
      return role ? json({ state: "active", role, user: { id: ids[m[1]] } }) : json({}, 404);
    }
    if (p.startsWith("/orgs/o/members?")) return json(Object.keys(w.org).slice(0, 2).map((l) => ({ id: ids[l] })));
    if (!p.startsWith("/repos/o/r/")) return json({ message: `unexpected ${p}` }, 500);
    const r = p.slice("/repos/o/r".length);
    if ((m = r.match(/^\/collaborators\/(\w+)\/permission$/))) {
      const perm = w.perms[m[1]];
      return perm ? json({ permission: perm, user: { id: ids[m[1]] } }) : json({}, 404);
    }
    if ((m = r.match(/^\/git\/ref\/heads\/(.+)$/))) return w.branches[m[1]] ? json({ object: { sha: w.branches[m[1]] } }) : json({}, 404);
    if ((m = r.match(/^\/git\/commits\/(\w+)$/))) return json({ tree: { sha: `tree-${m[1]}` } });
    if (method === "POST" && r === "/git/trees") {
      const sha = `t${++w.next}`;
      w.commits[sha] = { ...w.commits[body.base_tree.replace("tree-", "")], ...Object.fromEntries(body.tree.map((t: any) => [t.path, t.content])) };
      return json({ sha }, 201);
    }
    if (method === "POST" && r === "/git/commits") {
      const sha = `c${++w.next}`;
      w.commits[sha] = w.commits[body.tree];
      w.parents[sha] = body.parents[0];
      w.authors[sha] = "voxium[bot]";
      return json({ sha }, 201);
    }
    if (method === "POST" && r === "/git/refs") {
      const name = body.ref.replace("refs/heads/", "");
      if (w.branches[name]) return json({ message: "Reference already exists" }, 422);
      w.branches[name] = body.sha;
      return json({}, 201);
    }
    if (method === "PATCH" && (m = r.match(/^\/git\/refs\/heads\/(.+)$/))) {
      w.branches[m[1]] = body.sha;
      return json({});
    }
    if (method === "GET" && r.startsWith("/pulls?")) return json([]);
    if (method === "POST" && r === "/pulls") {
      const number = ++w.next;
      w.pulls[number] = {
        number, title: body.title, body: body.body, state: "open", merged: false, html_url: `https://gh/o/r/pull/${number}`,
        user: { id: 999, login: "voxium[bot]", type: "Bot" }, head: { sha: w.branches[body.head], ref: body.head }, base: { ref: body.base, sha: w.branches[body.base] },
      };
      return json({ number, html_url: `https://gh/o/r/pull/${number}` }, 201);
    }
    if ((m = r.match(/^\/pulls\/(\d+)$/))) return w.pulls[+m[1]] ? json(w.pulls[+m[1]]) : json({}, 404);
    if (r.match(/^\/pulls\/\d+\/files/)) return json([]);
    if ((m = r.match(/^\/pulls\/(\d+)\/commits\?/))) {
      const pull = w.pulls[+m[1]];
      const stop = mergeBase(w.branches[pull.base.ref], pull.head.sha);
      const out = [];
      for (let c: string | undefined = pull.head.sha; c && c !== stop; c = w.parents[c]) {
        const who = w.authors[c] ? { id: ids[w.authors[c]] ?? 999, login: w.authors[c] } : null;
        out.unshift({ sha: c, author: who, committer: who });
      }
      return json(out);
    }
    if ((m = r.match(/^\/pulls\/(\d+)\/reviews\?/))) return json(w.reviews[+m[1]] ?? []);
    if (method === "POST" && r.match(/^\/pulls\/\d+\/reviews$/)) return json({ id: ++w.next });
    if ((m = r.match(/^\/compare\/(\w+)\.\.\.(\w+)/))) return json({ merge_base_commit: { sha: mergeBase(m[1], m[2]) } });
    if ((m = r.match(/^\/contents\/(.+)\?ref=(\w+)$/))) {
      const text = w.commits[m[2]]?.[m[1]];
      return text === undefined ? json({}, 404) : new Response(text);
    }
    if ((m = r.match(/^\/git\/trees\/(\w+)/))) {
      // A symlink's blob is where it points, which stays the same when the file it points to changes.
      return json({ truncated: false, tree: Object.entries(w.commits[m[1]]).map(([path, c]) => ({ path, type: "blob", sha: blobSha(w.links.includes(path) ? `link:${path}` : c) })) });
    }
    if ((m = r.match(/^\/tarball\/(\w+)/))) {
      const entries = Object.entries(w.commits[m[1]]).map(([f, c]) => (w.links.includes(f) ? tarEntry(f, "../../../etc/passwd", "2") : tarEntry(f, c)));
      const after = w.afterTarball;
      w.afterTarball = undefined;
      after?.();
      return new Response(gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
    }
    if ((m = r.match(/^\/statuses\/(\w+)$/))) {
      w.statuses.push({ sha: m[1], ...body });
      return json({}, 201);
    }
    if (method === "POST" && r.match(/^\/issues\/\d+\/comments$/)) return json({ id: ++w.next }, 201);
    if (r.match(/^\/(issues|pulls)\/comments\/\d+$/)) return json({}, method === "DELETE" ? 204 : 200);
    return json({ message: `unexpected ${method} ${p}` }, 500);
  });
}

let repoId = 0;
const users: Record<string, UserRow> = {};
const as = (login: string | null) => void (me = login ? users[login] : null);

beforeEach(async () => {
  ({ db, raw } = database());
  pending = [];
  w = { commits: { m1: main }, parents: {}, branches: { main: "m1" }, pulls: {}, reviews: {}, org: { boss: "admin", lead: "member", dev: "member" }, perms: { boss: "admin", lead: "write", dev: "write", eve: "read" }, links: [], statuses: [], authors: {}, next: 10 };
  github();
  const org = await store.upsertOrg(db, { installation_id: 3, account_id: 50, account_login: "o", account_type: "Organization" });
  await store.upsertRepos(db, org.id, [{ id: 77, full_name: "o/r", default_branch: "main", private: true }, { id: 78, full_name: "o/other", default_branch: "main", private: true }]);
  repoId = (await store.getRepoByGithubId(db, 77))!.id;
  for (const [login, github_id] of Object.entries(ids)) {
    users[login] = await store.upsertUser(db, { github_id, login, name: null, avatar_url: null });
    if (login !== "eve") await store.syncMembership(db, users[login].id, org.id, login === "boss" ? "owner" : "member");
  }
  await store.setTeamLeader(db, users.lead.id, org.id, true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};
type Handler = (req: never, ctx: never) => Promise<Response>;
/** A form posted as a browser posts it from a Voxium page. */
async function post(handler: unknown, params: object, form: Record<string, string>, origin = "https://vx.test", type = "application/x-www-form-urlencoded"): Promise<URL> {
  const req = new Request("https://vx.test/api", { method: "POST", headers: { origin, "content-type": type }, body: new URLSearchParams(form).toString() });
  const res = await (handler as Handler)(req as never, { params: Promise.resolve(params) } as never);
  await settle();
  return new URL(res.headers.get("location")!);
}
const check = (pull: Pull) =>
  runPullRequestCheck({
    installationId: 3, repoId: 77, fullName: "o/r", defaultBranch: "main", number: pull.number, authorId: pull.user.id,
    authorLogin: pull.user.login, headSha: pull.head.sha, baseRef: pull.base.ref, headRef: pull.head.ref,
  });
const last = (sha: string) => w.statuses.filter((s) => s.sha === sha && s.state !== "pending").at(-1);
const proposals = () => raw.prepare("SELECT * FROM proposals ORDER BY id").all() as any[];
const audits = () => (raw.prepare("SELECT action FROM audit_log ORDER BY id").all() as any[]).map((a) => a.action);
const decide = (pid: number | string, form: Record<string, string>, origin?: string) => post(decidePost, { id: String(repoId), pid: String(pid) }, form, origin);
const approve = (pull: Pull, reason = "Agreed in the architecture review", sha = pull.head.sha) =>
  post(approvalPost, { id: String(repoId), number: String(pull.number) }, { action: "approve", sha, base: pull.base.ref, reason });
const propose = (form: Record<string, string>) => post(proposePost, { id: String(repoId) }, { title: "Flip the layers", summary: "Data on top", rationale: "We read it the other way round", ...form });
const exception = { rule: "L1", file: "src/data/legacy.ts", owner: "dev", reason: "Until the move", expires: "2099-01-01" };
const file = (title = "Allow legacy data code to use ui", over: object = { exception }) => JSON.stringify(createProposal({ title, summary: "One exception", rationale: "The move takes a month", ...over }));
const html = async (page: Promise<JSX.Element>) => renderToStaticMarkup(await page);

describe("a proposal in a file, from an agent to the decision log", () => {
  it("is imported once, opened as Voxium's pull request, approved only in Voxium, and logged with who asked", async () => {
    const carrier = openPull(4, "dev", { "voxium/proposals/legacy.json": file() });
    await check(carrier);
    expect(last(carrier.head.sha)).toMatchObject({ state: "success" });
    await check(carrier);
    expect(proposals()).toMatchObject([{ source: "pr", requester_login: "dev", requester_github_id: 100, requester_user_id: users.dev.id, status: "pending", title: "Allow legacy data code to use ui" }]);
    const [{ id }] = proposals();

    // The requester is a member, so cannot decide.
    as("dev");
    expect((await decide(id, { action: "open_pr" })).searchParams.get("error")).toMatch(/Owner or Team Leader/);
    as("lead");
    const opened = await decide(id, { action: "open_pr" });
    const pull = Object.values(w.pulls).find((p) => p.user.type === "Bot")!;
    expect(opened.pathname).toBe(`/repos/${repoId}/pulls/${pull.number}`);
    expect(pull.head.ref).toBe(`voxium/proposal-${id}`);
    expect(JSON.parse(w.commits[pull.head.sha][ARCH]).exceptions).toEqual([exception]);
    expect(proposals()[0]).toMatchObject({ status: "pr_open", pr_number: pull.number, decided_by: "lead" });

    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure", description: expect.stringMatching(/needs Team Leader approval/) });

    // A GitHub review does not count, even from a Team Leader with write access.
    w.reviews[pull.number] = [{ user: { id: 200, login: "lead", type: "User" }, state: "APPROVED", commit_id: pull.head.sha, body: "lgtm" }];
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure" });
    expect(await html(PullPage({ params: Promise.resolve({ id: String(repoId), number: String(pull.number) }), searchParams: Promise.resolve({}) }))).toContain("GitHub reviews do not count");

    // An approval for another commit than the one on GitHub is refused.
    expect((await approve(pull, undefined, "c1")).searchParams.get("error")).toMatch(/changed while you were reading/);
    expect((await approve(pull)).searchParams.get("error")).toBeNull();
    expect(last(pull.head.sha)).toMatchObject({ state: "success", description: expect.stringMatching(/approved by lead/) });

    // Someone who lost write access no longer counts.
    w.perms.lead = "read";
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure" });
    w.perms.lead = "write";

    // A push after the approval needs a new one.
    const before = pull.head.sha;
    pull.head.sha = w.branches[pull.head.ref] = commit(before, { "src/ui/extra.ts": "export {};" });
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure" });
    pull.head.sha = w.branches[pull.head.ref] = before;
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "success" });

    await recordDecision({
      installationId: 3, repoId: 77, fullName: "o/r", defaultBranch: "main", merged: true, url: pull.html_url, number: pull.number, title: pull.title,
      authorId: 999, headSha: pull.head.sha, baseSha: "m1", baseRef: "main", mergedBy: "boss", closedAt: "2026-11-26T10:00:00Z",
    });
    const [decision] = await store.listDecisions(db, 77);
    expect(decision).toMatchObject({ kind: "approved", approved_by: "lead", proposed_by: "dev", reason: "Agreed in the architecture review", merged_by: "boss" });
    expect(decision.changes.join()).toContain("Adds exception to L1 for src/data/legacy.ts");
    expect(proposals()[0].status).toBe("merged");
    expect(audits()).toEqual(["proposal_imported", "proposal_pr", "proposal_approved"]);
  });

  it("is not imported from someone who cannot write, without a login, or when it is not a valid proposal", async () => {
    await check(openPull(4, "eve", { "voxium/proposals/a.json": file() }));
    const noLogin = openPull(5, "dev", { "voxium/proposals/b.json": file() });
    await runPullRequestCheck({ installationId: 3, repoId: 77, fullName: "o/r", defaultBranch: "main", number: 5, authorId: 100, headSha: noLogin.head.sha, baseRef: "main" });
    const junk = {
      "voxium/proposals/big.json": JSON.stringify({ ...JSON.parse(file("Big")), padding: "x".repeat(70_000) }),
      "voxium/proposals/deep.json": `${"[".repeat(3000)}${"]".repeat(3000)}`,
      "voxium/proposals/broken.json": "{",
      "voxium/proposals/approved.json": JSON.stringify({ title: "t", summary: "s", rationale: "r", change: { approve: true } }),
      "voxium/proposals/nested/x.json": file(),
      "voxium/proposals/../escape.json": file(),
      "voxium/proposals/link.json": file(),
    };
    w.links = ["voxium/proposals/link.json"];
    await check(openPull(6, "dev", junk));
    // Into another branch than the default one.
    const side = openPull(7, "dev", { "voxium/proposals/side.json": file() });
    side.base.ref = "dev";
    w.branches.dev = "m1";
    await check(side);
    expect(proposals()).toEqual([]);
  });

  it("is read at most twenty at a time, and never changes the verdict", async () => {
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`voxium/proposals/p${String(i).padStart(2, "0")}.json`, file(`Proposal ${i}`)]));
    const pull = openPull(4, "dev", { ...many, "src/data/d.ts": `import "../ui/Page";` });
    await check(pull);
    expect(proposals()).toHaveLength(20);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure" });
    const clean = openPull(5, "dev", { "voxium/proposals/x.json": file("Another") });
    raw.exec("DROP TABLE proposals");
    await check(clean);
    expect(last(clean.head.sha)).toMatchObject({ state: "success" });
  });
});

describe("a proposal made in Voxium", () => {
  const flipped = JSON.stringify({ ...arch, layers: ["data", "services", "ui"] });

  it("changes the layers, accepts the debt it names, and is green once someone else approves it", async () => {
    as("lead");
    const made = await propose({ kind: "architecture", architecture: flipped, acceptDebt: "on", against: await rulesHash(main[ARCH]) });
    const [p] = proposals();
    expect(made.pathname).toBe(`/repos/${repoId}/proposals/${p.id}`);
    expect(p).toMatchObject({ source: "web", requester_login: "lead", status: "pending" });

    as("boss");
    const page = await html(ProposalPage({ params: Promise.resolve({ id: String(repoId), pid: String(p.id) }), searchParams: Promise.resolve({}) }));
    expect(page).toContain("Changes the layers from ui &gt; services &gt; data to data &gt; services &gt; ui");
    expect(page).toContain("Open a pull request");
    await decide(p.id, { action: "open_pr" });
    const pull = Object.values(w.pulls).find((x) => x.user.type === "Bot")!;
    expect(pull.body).toContain("Accepts 2 violation(s)");
    for (const id of UP) expect(pull.body).toContain(`* \`${id}\``);
    expect(JSON.parse(w.commits[pull.head.sha]["voxium/baseline.json"]).violations).toEqual(UP);
    expect(w.commits[pull.head.sha]["CLAUDE.md"]).toMatch(/1\. `data`/);

    // The requester is a Team Leader, but not alone, so cannot approve their own change.
    as("lead");
    expect((await approve(pull)).searchParams.get("error")).toMatch(/You asked for this change/);
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure" });
    as("boss");
    await approve(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "success", description: expect.stringMatching(/approved by boss/) });
  });

  it("is refused when the rules changed while it was written, or since", async () => {
    as("lead");
    expect((await propose({ kind: "architecture", architecture: flipped, against: "old" })).searchParams.get("error")).toMatch(/rules changed/);
    await propose({ kind: "architecture", architecture: flipped, against: await rulesHash(main[ARCH]) });
    w.branches.main = commit("m1", { [ARCH]: JSON.stringify({ ...arch, ignore: ["gen/**"] }) });
    as("boss");
    expect((await decide(proposals()[0].id, { action: "open_pr" })).searchParams.get("error")).toMatch(/rules changed since/);
    expect(Object.keys(w.pulls)).toEqual([]);
  });

  /** The fields the editor sends for the current rules, unchanged, with changes on top. */
  const editor = async (change: Record<string, string | null> = {}) => {
    const f: Record<string, string> = { kind: "edits", against: await rulesHash(main[ARCH]), "r0.on": "on", "r0.severity": "block" };
    Object.entries(arch.modules).forEach(([name, def], i) => Object.assign(f, { [`m${i}.keep`]: "on", [`m${i}.name`]: name, [`m${i}.paths`]: def.paths.join("\n") }));
    arch.layers.forEach((_, i) => (f[`l${i}.pos`] = String(i + 1)));
    for (const [k, v] of Object.entries(change)) v === null ? delete f[k] : (f[k] = v);
    return f;
  };

  it("can be written with the editor of the setup review", async () => {
    as("dev");
    const html = renderToStaticMarkup(await ProposalsPage({ params: Promise.resolve({ id: String(repoId) }), searchParams: Promise.resolve({}) }));
    expect(html).toContain('id="edit"');
    expect(html).toContain('name="m0.keep"');
    expect((await propose(await editor())).searchParams.get("error")).toMatch(/Change something/);
    await propose(await editor({ "l0.pos": "3", "l2.pos": "1", "m1.name": "logic" }));
    const [p] = proposals();
    const change = JSON.parse(p.change_json!);
    expect(change.architecture.layers).toEqual(["data", "logic", "ui"]);
    expect(Object.keys(change.architecture.modules)).toEqual(["ui", "logic", "data"]);
    expect(change.against).toBe(await rulesHash(main[ARCH]));
  });

  it.each<[string, Record<string, string | null>, RegExp]>([
    ["an exception", { exceptions: "[]" }, /fields the editor does not send/],
    ["a rule the rules do not have", { "r1.on": "on" }, /fields the editor does not send/],
    ["a module path that takes in everything", { "m0.paths": "**" }, /must start with a folder name/],
    ["nothing left to check", { "m0.keep": null, "m1.keep": null, "m2.keep": null, "r0.on": null }, /No file would be in any module/],
    ["rules that changed since", { against: "old" }, /rules changed/],
  ])("from the editor is refused with %s", async (_n, change, error) => {
    as("dev");
    expect((await propose(await editor(change))).searchParams.get("error")).toMatch(error);
    expect(proposals()).toEqual([]);
  });

  it("from the editor refuses globs that would keep the server busy, from a member who can only read, before matching them", async () => {
    w.perms.dev = "read";
    const many = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`src/ui/f${i % 40}/c${i}.ts`, "export {};"]));
    w.branches.main = commit("m1", many);
    as("dev");
    const started = Date.now();
    const crafted = Array.from({ length: 300 }, (_, i) => `src/${"*a".repeat(245)}${i}*.ts`).join("\n");
    expect((await propose(await editor({ ignore: crafted }))).searchParams.get("error")).toMatch(/at most 16 wildcards/);
    const fewer = Array.from({ length: 256 }, (_, i) => `src/${Array.from({ length: 8 }, (_, j) => ((i >> j) & 1 ? "?*" : "*?")).join("/")}.ts`).join("\n");
    expect((await propose(await editor({ ignore: fewer }))).searchParams.get("error")).toMatch(/would take too long to match against the 3003 source files/);
    // One glob sent a thousand times would be matched a thousand times.
    const same = Array(1000).fill(`src/**/${"*/".repeat(13)}*`).join("\n");
    expect((await propose(await editor({ ignore: same }))).searchParams.get("error")).toMatch(/is listed twice/);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(proposals()).toEqual([]);
  });

  it("from the editor refuses globs too large to be a proposal before listing or matching a file", async () => {
    w.perms.dev = "read";
    as("dev");
    const fetched: string[] = [];
    const fake = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (fetched.push(String(url)), fake(url, init)));
    // 150 globs of 480 characters fit the form but make an architecture of over 64 KB, which used to be found out only
    // after they were matched against every file of the repository.
    const long = Array.from({ length: 150 }, (_, i) => `src/*${"deeply_nested_folder_name/".repeat(18)}${i}*`).join("\n");
    expect((await propose(await editor({ ignore: long }))).searchParams.get("error")).toMatch(/larger than 64 KB/);
    expect(fetched.filter((u) => u.includes("/git/trees/"))).toEqual([]);
    expect(proposals()).toEqual([]);
  });

  it("is refused when the form is larger than any the pages send, or not a plain form", async () => {
    as("dev");
    const huge = await propose({ kind: "debt", summary: "x".repeat(300 * 1024) });
    expect(huge.searchParams.get("error")).toMatch(/too large or not sent from Voxium/);
    const multipart = await post(proposePost, { id: String(repoId) }, { kind: "debt", title: "t", summary: "s", rationale: "r" }, "https://vx.test", "multipart/form-data; boundary=x");
    expect(multipart.searchParams.get("error")).toMatch(/too large or not sent from Voxium/);
    expect(proposals()).toEqual([]);
  });

  it.each<[string, Record<string, string>]>([
    ["an invalid architecture", { kind: "architecture", architecture: JSON.stringify({ ...arch, layers: ["nope"] }) }],
    ["an architecture that is not JSON", { kind: "architecture", architecture: "{" }],
    ["an exception to a rule that does not exist", { kind: "exception", rule: "NOPE", file: "src/**", expires: "2099-01-01" }],
    ["an exception that has run out", { kind: "exception", rule: "L1", file: "src/**", expires: "2001-01-01" }],
    ["no title", { kind: "debt", title: "" }],
    ["an unknown kind", { kind: "merge" }],
  ])("is refused for %s", async (_n, form) => {
    as("dev");
    const against = await rulesHash(main[ARCH]);
    expect((await propose({ against, ...form })).searchParams.get("error")).toBeTruthy();
    expect(proposals()).toEqual([]);
  });

  it("can be made by anyone who can open the repository, and nobody else", async () => {
    as("dev");
    await propose({ kind: "debt" });
    as("eve");
    expect((await propose({ kind: "debt" })).searchParams.get("error")).toBe("Repository not found.");
    as("dev");
    await propose({ kind: "debt" });
    await post(proposePost, { id: String(repoId) }, { kind: "debt", title: "t", summary: "s", rationale: "r" }, "https://evil.test");
    expect(proposals()).toHaveLength(2);
    const list = await html(ProposalsPage({ params: Promise.resolve({ id: String(repoId) }), searchParams: Promise.resolve({}) }));
    expect(list).toContain("Flip the layers");
    expect(list).toContain('name="against"');
  });
});

describe("deciding on a proposal", () => {
  async function pendingOne(): Promise<number> {
    as("dev");
    await propose({ kind: "exception", rule: "L1", file: "src/data/legacy.ts", expires: "2099-01-01", title: "<b>Legacy</b> # heading" });
    as("lead");
    return proposals()[0].id;
  }

  it("rejecting needs a reason and writes audit", async () => {
    const id = await pendingOne();
    expect((await decide(id, { action: "reject", reason: "no" })).searchParams.get("error")).toMatch(/reason/);
    expect(proposals()[0].status).toBe("pending");
    await decide(id, { action: "reject", reason: "We are removing that folder instead" });
    expect(proposals()[0]).toMatchObject({ status: "rejected", decided_by: "lead", decided_reason: "We are removing that folder instead" });
    expect(audits()).toEqual(["proposal_created", "proposal_rejected"]);
    expect((await decide(id, { action: "reject", reason: "Again, for the record" })).searchParams.get("error")).toMatch(/Only a pending/);
    expect((await decide(id, { action: "open_pr" })).searchParams.get("error")).toMatch(/not pending/);
  });

  it("is only for Owners and Team Leaders with write access, from Voxium, for this repo's proposals", async () => {
    const id = await pendingOne();
    const tries: Array<[string | null, string | number, string?]> = [
      ["dev", id], ["eve", id], [null, id], ["lead", id, "https://evil.test"], ["lead", `${id}/../${id}`], ["lead", "../1"], ["lead", "-1"],
    ];
    for (const [who, pid, origin] of tries) {
      as(who);
      await decide(pid, { action: "reject", reason: "Not this one, sorry" }, origin);
    }
    w.perms.lead = "read";
    as("lead");
    await decide(id, { action: "reject", reason: "Not this one, sorry" });
    w.perms.lead = "write";
    // Another repo's id finds nothing.
    const other = (await store.getRepoByGithubId(db, 78))!.id;
    await post(decidePost, { id: String(other), pid: String(id) }, { action: "reject", reason: "Not this one, sorry" });
    expect(proposals()[0].status).toBe("pending");
  });

  it("never reuses a branch someone else prepared", async () => {
    const id = await pendingOne();
    w.branches[`voxium/proposal-${id}`] = "m1";
    expect((await decide(id, { action: "open_pr" })).searchParams.get("error")).toMatch(/exists already/);
    expect(Object.keys(w.pulls)).toEqual([]);
    expect(proposals()[0]).toMatchObject({ status: "pending", pr_number: null });
  });

  it("keeps people's text out of headings and the agent rules", async () => {
    const id = await pendingOne();
    await decide(id, { action: "open_pr" });
    const pull = Object.values(w.pulls)[0];
    expect(pull.body).toContain("**\\<b\\>Legacy\\</b\\> \\# heading**");
    expect(w.commits[pull.head.sha]["CLAUDE.md"]).not.toContain("Legacy</b>");
  });

  it("is rejected when its pull request is closed without merging", async () => {
    const id = await pendingOne();
    await decide(id, { action: "open_pr" });
    const pull = Object.values(w.pulls)[0];
    await recordDecision({
      installationId: 3, repoId: 77, fullName: "o/r", defaultBranch: "main", merged: false, url: pull.html_url, number: pull.number, title: pull.title,
      authorId: 999, headSha: pull.head.sha, baseSha: "m1", baseRef: "main", mergedBy: null, closedAt: "2026-11-26T10:00:00Z",
    });
    expect(proposals()[0]).toMatchObject({ status: "rejected", decided_reason: "Its pull request was closed without merging." });
    expect(await store.listDecisions(db, 77)).toEqual([]);
  });
});

describe("approving pull requests that are not proposals", () => {
  const weak = { [ARCH]: JSON.stringify({ ...arch, rules: [] }) };
  const review = (pull: Pull) => (w.reviews[pull.number] = [{ user: { id: 200, login: "lead", type: "User" }, state: "APPROVED", commit_id: pull.head.sha }]);

  it("still counts a Team Leader's GitHub review", async () => {
    const pull = openPull(4, "dev", weak);
    review(pull);
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "success", description: expect.stringMatching(/approved by lead/) });
  });

  it("counts none for a branch named like a proposal's that Voxium has not recorded", async () => {
    const pull = openPull(4, "dev", weak, "voxium/proposal-9");
    review(pull);
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure" });
  });
});

describe("the Voxium block in the agent files", () => {
  const review = (pull: Pull) => (w.reviews[pull.number] = [{ user: { id: 200, login: "lead", type: "User" }, state: "APPROVED", commit_id: pull.head.sha }]);
  const claude = main["CLAUDE.md"];
  /** The GitHub requests a check makes for one file by name, outside the archive. */
  const watch = () => {
    const urls: string[] = [];
    const fake = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (urls.push(String(url)), fake(url, init)));
    return (name: string) => urls.filter((u) => u.includes(`/contents/${name}`));
  };

  it.each<[string, Files, string[]]>([
    ["edited", { "CLAUDE.md": claude.replace("Never import upward.", "Importing upward is fine when it is quicker.") }, []],
    ["deleted with its file", {}, ["CLAUDE.md"]],
    ["joined by a second block", { "AGENTS.md": `${main["AGENTS.md"]}\n<!-- voxium:start -->\nThe layers no longer apply.\n<!-- voxium:end -->\n` }, []],
    ["hidden in a code fence", { "CLAUDE.md": claude.replace("<!-- voxium:start -->", "```\n<!-- voxium:start -->").replace("<!-- voxium:end -->", "<!-- voxium:end -->\n```") }, []],
  ])("fails a pull request when the block is %s, until a Team Leader approves that commit", async (_n, change, drop) => {
    const head = commit(w.branches.main, change, drop, "dev");
    w.branches["feature-4"] = head;
    const pull: Pull = (w.pulls[4] = { ...openPull(4, "dev", {}), head: { sha: head, ref: "feature-4" } });
    await check(pull);
    const changed = Object.keys(change)[0] ?? drop[0];
    expect(last(pull.head.sha)).toMatchObject({ state: "failure" });
    as("lead");
    const page = await html(PullPage({ params: Promise.resolve({ id: String(repoId), number: "4" }), searchParams: Promise.resolve({}) }));
    expect(page).toContain(`Voxium block in ${changed}`);
    review(pull);
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "success", description: expect.stringMatching(/approved by lead/) });
  });

  it("cannot be changed through a symlink whose target a later pull request edits", async () => {
    // CLAUDE.md became a link to docs/agent-rules.md, with the same text; GitHub's contents API follows the link.
    w.links.push("CLAUDE.md");
    const pull = openPull(4, "dev", { "CLAUDE.md": claude.replace("Never import upward.", "The layers no longer apply.") });
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure", description: expect.stringMatching(/CLAUDE\.md.*needs Team Leader approval/) });
  });

  it("passes a pull request that only edits text outside the block, without fetching the agent files on their own", async () => {
    const requests = watch();
    const pull = openPull(4, "dev", { "CLAUDE.md": `# Team notes\n\nUse pnpm.\n\n${claude}\nMore notes.\n`, "AGENTS.md": `${main["AGENTS.md"]}\nSee CONTRIBUTING.md.\n` });
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "success" });
    expect([...requests("CLAUDE.md"), ...requests("AGENTS.md")]).toEqual([]);
  });

  it("leaves alone a block that is merely out of date, as long as the pull request does not touch it", async () => {
    // The rules on main changed without the agent files being regenerated.
    w.branches.main = commit("m1", { [ARCH]: JSON.stringify({ ...arch, layers: ["data", "services", "ui"] }) });
    const pull = openPull(4, "dev", { "CLAUDE.md": `${claude}\nMore notes.\n` });
    await check(pull);
    expect(last(pull.head.sha)).not.toMatchObject({ description: expect.stringMatching(/approv/i) });
    as("lead");
    expect((await html(PullPage({ params: Promise.resolve({ id: String(repoId), number: "4" }), searchParams: Promise.resolve({}) })))).not.toContain("Voxium block");
  });
});

describe("the Voxium block of a proposal's pull request", () => {
  it("names the version a GitLab job pins, as the check expects it, when there is no workflow", async () => {
    const gitlab = buildSetupFiles({ arch, baseline: [], cliPackage: "voxium@1.2.3" });
    w.branches.main = commit("m1", { "voxium/gitlab-ci.yml": gitlab["voxium/gitlab-ci.yml"], "CLAUDE.md": gitlab["CLAUDE.md"], "AGENTS.md": gitlab["AGENTS.md"] });
    const pull = await openedByBoss();
    expect(w.commits[pull.head.sha]["CLAUDE.md"]).toContain("npx --yes voxium@1.2.3 check");
    as("lead");
    const page = await html(PullPage({ params: Promise.resolve({ id: String(repoId), number: String(pull.number) }), searchParams: Promise.resolve({}) }));
    expect(page).not.toContain("Voxium block");
  });
});

describe("regenerating the generated files", () => {
  const regenerate = () => post(regeneratePost, { id: String(repoId) }, {});

  it("opens a pull request on voxium/sync with only the files that differ, for an Owner or Team Leader with write access", async () => {
    // People's own text outside the block stays.
    w.branches.main = commit("m1", { "CLAUDE.md": `# Team notes\n\n${main["CLAUDE.md"]}` });
    for (const who of ["dev", "eve", null]) {
      as(who);
      const res = await regenerate();
      expect(res.pathname, String(who)).not.toMatch(/pull/);
    }
    expect(Object.keys(w.pulls)).toEqual([]);
    as("lead");
    const res = await regenerate();
    const pull = botPull();
    expect(res.href).toBe(pull.html_url);
    expect(pull.head.ref).toBe("voxium/sync");
    const files = w.commits[pull.head.sha];
    const changed = Object.keys(files).filter((p) => files[p] !== w.commits[w.branches.main][p]).sort();
    // The Cursor rules were not there yet, and the suggested CODEOWNERS now names the Owners and Team Leaders.
    expect(changed).toEqual([".cursor/rules/voxium.mdc", "voxium/CODEOWNERS.suggested"]);
    expect(files["voxium/CODEOWNERS.suggested"]).toContain("/voxium/ @boss @lead\n");
    expect(files["CLAUDE.md"]).toContain("# Team notes");
    expect(pull.body).toContain("`.cursor/rules/voxium.mdc`");
    expect(audits()).toContain("regenerate_pr");
    // Its own pull request needs no approval, since it only brings the blocks up to date.
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "success" });
    expect(last(pull.head.sha)!.description).not.toMatch(/approv/i);
    // Once merged, there is nothing left to do.
    w.branches.main = pull.head.sha;
    expect((await regenerate()).searchParams.get("error")).toMatch(/up to date/);
  });

  it("never rewrites the rules, and is refused where Voxium is not set up", async () => {
    w.branches.main = commit("m1", { "voxium/baseline.json": JSON.stringify({ violations: ["L1:x"] }) });
    as("boss");
    await regenerate();
    const files = w.commits[botPull().head.sha];
    expect(files[ARCH]).toBe(main[ARCH]);
    expect(files["voxium/baseline.json"]).toBe(JSON.stringify({ violations: ["L1:x"] }));
    w.branches.main = commit("m1", {}, [ARCH]);
    expect((await regenerate()).searchParams.get("error")).toMatch(/not set up/);
  });
});

const botPull = () => Object.values(w.pulls).find((p) => p.user.type === "Bot")!;
const closed = (pull: Pull, merged: boolean) =>
  recordDecision({
    installationId: 3, repoId: 77, fullName: "o/r", defaultBranch: "main", merged, url: pull.html_url, number: pull.number, title: pull.title,
    authorId: 999, headSha: pull.head.sha, baseSha: w.branches.main, baseRef: "main", mergedBy: merged ? "boss" : null, closedAt: "2026-11-26T10:00:00Z",
  });
/** dev asks for an exception in Voxium and boss opens its pull request. */
async function openedByBoss(requester = "dev"): Promise<Pull> {
  as(requester);
  await propose({ kind: "exception", rule: "L1", file: "src/data/legacy.ts", expires: "2099-01-01" });
  as("boss");
  await decide(proposals()[0].id, { action: "open_pr" });
  return botPull();
}

describe("who may approve the pull request of a proposal", () => {
  it("not whoever changed the rules on its branch, and nobody while they differ from what Voxium wrote", async () => {
    const pull = await openedByBoss();
    const written = w.commits[pull.head.sha][ARCH];
    push(pull, "lead", { [ARCH]: JSON.stringify({ ...arch, rules: [] }) });
    as("lead");
    expect((await approve(pull)).searchParams.get("error")).toMatch(/not the ones Voxium wrote/);
    // An approval stored for that commit some other way does not count at the check either.
    await store.saveSelfApproval(db, { repoId, number: pull.number, headSha: pull.head.sha, baseRef: "main" }, users.lead.id, "Agreed in review", "proposal");
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure" });
    as("boss");
    expect((await approve(pull)).searchParams.get("error")).toMatch(/not the ones Voxium wrote/);
    expect(audits()).not.toContain("proposal_approved");

    // With the rules Voxium wrote back, code pushed onto the branch is checked under them, and the approval counts.
    push(pull, "lead", { [ARCH]: written, "src/ui/extra.ts": "export {};" });
    as("lead");
    expect((await approve(pull)).searchParams.get("error")).toBeNull();
    expect(last(pull.head.sha)).toMatchObject({ state: "success", description: expect.stringMatching(/approved by lead/) });
  });

  it("not whoever put a proposal file into someone else's pull request", async () => {
    const carrier = openPull(4, "dev", { "src/ui/x.ts": "export {};" });
    push(carrier, "lead", { "voxium/proposals/weak.json": file("Drop the rules", { architecture: { ...arch, rules: [] } }) });
    await check(carrier);
    expect(proposals()).toMatchObject([{ requester_login: "dev", co_requesters: "[200]" }]);
    as("boss");
    await decide(proposals()[0].id, { action: "open_pr" });
    const pull = botPull();
    as("lead");
    expect((await approve(pull)).searchParams.get("error")).toMatch(/You asked for this change/);
    await store.saveSelfApproval(db, { repoId, number: pull.number, headSha: pull.head.sha, baseRef: "main" }, users.lead.id, "Agreed in review", "proposal");
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure" });
    as("boss");
    expect((await approve(pull)).searchParams.get("error")).toBeNull();
    expect(last(pull.head.sha)).toMatchObject({ state: "success", description: expect.stringMatching(/approved by boss/) });
  });

  it("imports nothing when GitHub cannot name everyone who made a commit of the pull request", async () => {
    const carrier = openPull(4, "dev", { "src/ui/x.ts": "export {};" });
    carrier.head.sha = w.branches[carrier.head.ref] = commit(carrier.head.sha, { "voxium/proposals/a.json": file() });
    await check(carrier);
    expect(proposals()).toEqual([]);
    expect(last(carrier.head.sha)).toMatchObject({ state: "success" });
  });

  it("only an Owner or Team Leader, even with write access", async () => {
    const pull = await openedByBoss("lead");
    as("dev");
    expect((await approve(pull)).searchParams.get("error")).toMatch(/Only an Owner or Team Leader/);
    await store.saveSelfApproval(db, { repoId, number: pull.number, headSha: pull.head.sha, baseRef: "main" }, users.dev.id, "Agreed in review", "proposal");
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure" });
  });

  it("only into the default branch", async () => {
    const pull = await openedByBoss();
    w.branches.dev = "m1";
    pull.base.ref = "dev";
    as("lead");
    expect((await approve(pull)).searchParams.get("error")).toMatch(/not into the default branch/);
  });
});

describe("opening the pull request of a proposal", () => {
  it("puts it on the commit it was planned on, so nothing merged meanwhile is undone", async () => {
    as("dev");
    await propose({ kind: "exception", rule: "L1", file: "src/data/legacy.ts", expires: "2099-01-01" });
    w.afterTarball = () => void (w.branches.main = commit("m1", { [ARCH]: JSON.stringify({ ...arch, ignore: ["gen/**"] }) }));
    as("boss");
    await decide(proposals()[0].id, { action: "open_pr" });
    const pull = botPull();
    expect(w.branches.main).not.toBe("m1");
    expect(w.parents[pull.head.sha]).toBe("m1");
    expect(JSON.parse(w.commits[pull.head.sha][ARCH]).exceptions).toHaveLength(1);
  });

  it("accepts only debt the new rules make, and names what already failed on the default branch", async () => {
    w.branches.main = commit("m1", { "src/data/d.ts": `import "../ui/Page";` });
    const before = w.commits[w.branches.main]["voxium/baseline.json"];
    const extra = { rule: "L1", file: "src/ui/zzz.ts", owner: "dev", reason: "r", expires: "2099-01-01" };
    as("dev");
    await propose({ kind: "architecture", architecture: JSON.stringify({ ...arch, exceptions: [extra] }), acceptDebt: "on", against: await rulesHash(main[ARCH]) });
    as("boss");
    await decide(proposals()[0].id, { action: "open_pr" });
    const pull = botPull();
    expect(w.commits[pull.head.sha]["voxium/baseline.json"]).toBe(before);
    expect(pull.body).not.toContain("### Accepted debt");
    expect(pull.body).toContain("### Already failing");
    expect(pull.body).toContain("* `L1:src/data/d.ts->src/ui/Page.ts`");
  });

  it("does not accept what already fails when the proposal renames the rule", async () => {
    w.branches.main = commit("m1", { "src/data/d.ts": `import "../ui/Page";` });
    const before = w.commits[w.branches.main]["voxium/baseline.json"];
    const renamed = { ...arch, rules: arch.rules.map((r, i) => (i === 0 ? { ...r, id: "L1-layers" } : r)) };
    as("dev");
    await propose({ kind: "architecture", architecture: JSON.stringify(renamed), acceptDebt: "on", against: await rulesHash(main[ARCH]) });
    as("boss");
    await decide(proposals()[0].id, { action: "open_pr" });
    const pull = botPull();
    expect(w.commits[pull.head.sha]["voxium/baseline.json"]).toBe(before);
    expect(pull.body).not.toContain("that these rules make new");
    expect(pull.body).toContain("### Already failing");
    expect(pull.body).toContain("* `L1-layers:src/data/d.ts->src/ui/Page.ts`");
  });

  it("keeps an exception on one line with nothing invisible", async () => {
    as("dev");
    await propose({ kind: "exception", rule: "L1", file: "src/\u202estd.ycagel/**", expires: "2099-01-01", rationale: "why\u202e\u0007 it\nis needed" });
    expect(JSON.parse(proposals()[0].change_json).exception).toMatchObject({ file: "src/std.ycagel/**", reason: "why it is needed" });
  });

  it("keeps the exceptions of a whole architecture on one line with nothing invisible", async () => {
    const dirty = { rule: "L1", file: "src/\u202ests.ycagel/**", owner: "dev\u0007", reason: "why\u202e\u0007 it is needed", expires: "2099-01-01" };
    as("dev");
    await propose({ kind: "architecture", architecture: JSON.stringify({ ...arch, exceptions: [dirty] }), against: await rulesHash(main[ARCH]) });
    expect(proposals()[0].change_json).not.toMatch(/[\u202e\u0007]|\\u202e|\\u0007/i);
    as("boss");
    await decide(proposals()[0].id, { action: "open_pr" });
    const pull = botPull();
    const written = w.commits[pull.head.sha][ARCH];
    expect(written).not.toMatch(/[\u202e\u0007]|\\u202e|\\u0007/i);
    expect(JSON.parse(written).exceptions).toEqual([{ ...dirty, file: "src/sts.ycagel/**", owner: "dev", reason: "why it is needed" }]);
    expect(pull.body).toContain("for src/sts.ycagel/\\*\\* until 2099-01-01 (owner dev: why it is needed)");
  });
});

describe("a reopened pull request of a proposal", () => {
  function reopen(pull: Pull) {
    const body = JSON.stringify({
      action: "reopened", installation: { id: 3 }, repository: { id: 77, full_name: "o/r", default_branch: "main" },
      pull_request: { number: pull.number, state: "open", user: pull.user, head: pull.head, base: pull.base },
    });
    const sig = `sha256=${crypto.createHmac("sha256", "hook-secret").update(body).digest("hex")}`;
    const headers = new Headers({ "x-github-event": "pull_request", "x-hub-signature-256": sig });
    return (webhookPost as unknown as Handler)({ headers, text: async () => body } as never, {} as never).then(settle);
  }

  it("opens the proposal again, and a merge after that is what the proposal says", async () => {
    const pull = await openedByBoss();
    await closed(pull, false);
    expect(proposals()[0]).toMatchObject({ status: "rejected", decided_reason: "Its pull request was closed without merging." });
    await reopen(pull);
    expect(proposals()[0]).toMatchObject({ status: "pr_open", decided_reason: null });
    as("lead");
    expect((await approve(pull)).searchParams.get("error")).toBeNull();
    await closed(pull, true);
    expect(proposals()[0]).toMatchObject({ status: "merged", decided_reason: null });
    expect(await store.listDecisions(db, 77)).toMatchObject([{ kind: "approved", approved_by: "lead", proposed_by: "dev" }]);
  });

  it("is merged even when the reopening was never heard of", async () => {
    const pull = await openedByBoss();
    await closed(pull, false);
    await closed(pull, true);
    expect(proposals()[0]).toMatchObject({ status: "merged", decided_reason: null });
  });
});

describe("the proposals table", () => {
  it("imports an edited proposal file again, as a new proposal", async () => {
    const carrier = openPull(4, "dev", { "voxium/proposals/legacy.json": file() });
    await check(carrier);
    push(carrier, "dev", { "voxium/proposals/legacy.json": file("Allow legacy data code, edited") });
    await check(carrier);
    expect(proposals().map((p) => p.title)).toEqual(["Allow legacy data code to use ui", "Allow legacy data code, edited"]);
  });

  it("claims only a pending proposal without a pull request, and finds proposals only in their own repo", async () => {
    as("dev");
    await propose({ kind: "debt" });
    await propose({ kind: "debt" });
    await propose({ kind: "debt" });
    const [a, b, c] = proposals().map((p) => p.id as number);
    expect(await store.claimProposal(db, a, "lead")).toBe(true);
    expect(await store.claimProposal(db, a, "boss")).toBe(false);
    expect(await store.rejectProposal(db, b, "lead", "Not now, thanks")).toBe(true);
    expect(await store.claimProposal(db, b, "boss")).toBe(false);
    raw.exec(`UPDATE proposals SET pr_number = 9 WHERE id = ${c}`);
    expect(await store.claimProposal(db, c, "boss")).toBe(false);
    const other = (await store.getRepoByGithubId(db, 78))!.id;
    expect(await store.getProposal(db, repoId, a)).toMatchObject({ id: a });
    expect(await store.getProposal(db, other, a)).toBeNull();
  });
});

describe("drift history", () => {
  const target = { installationId: 3, repoId: 77, fullName: "o/r", defaultBranch: "main" };
  let clock = new Date();
  beforeEach(() => void (clock = new Date()));
  /** A minute and a second later each time, so that runs are not refused as too soon. */
  const later = () => (clock = new Date(clock.getTime() + 61_000));
  const snap = (now = later()) => runSnapshot(target, undefined, () => now);
  const snapshots = () => raw.prepare("SELECT * FROM snapshots ORDER BY created_at, id").all() as any[];
  const page = (p: (x: never) => Promise<JSX.Element>, search: object = {}) =>
    html(p({ params: Promise.resolve({ id: String(repoId) }), searchParams: Promise.resolve(search) } as never));
  const merge = (change: Files, drop: string[] = []) => (w.branches.main = commit(w.branches.main, change, drop));
  const mergedWebhook = (number: number) => {
    const body = JSON.stringify({
      action: "closed", installation: { id: 3 }, repository: { id: 77, full_name: "o/r", default_branch: "main" },
      pull_request: { number, state: "closed", merged: true, title: "t", user: { id: 100, login: "dev" }, head: { sha: w.branches.main, ref: "f" }, base: { ref: "main", sha: "m1" }, merged_by: { login: "boss" } },
    });
    const sig = `sha256=${crypto.createHmac("sha256", "hook-secret").update(body).digest("hex")}`;
    const headers = new Headers({ "x-github-event": "pull_request", "x-hub-signature-256": sig });
    return (webhookPost as unknown as Handler)({ headers, text: async () => body } as never, {} as never).then(settle);
  };

  it("takes a snapshot after each merge, shows the trend, and keeps one for the same commit", async () => {
    merge({ "src/data/up.ts": `import "../ui/Page";` });
    await mergedWebhook(5);
    expect(snapshots()).toHaveLength(1);
    // Within the minute nothing runs again, however many merges there are.
    merge({ "src/data/up2.ts": `import "../ui/Page";` });
    await mergedWebhook(6);
    expect(snapshots()).toHaveLength(1);
    expect(await snap()).toBe("saved");
    expect(snapshots().map((r) => r.new_count)).toEqual([1, 2]);
    // The same commit again is the same snapshot.
    expect(await snap()).toBe("saved");
    expect(snapshots()).toHaveLength(2);
    as("dev");
    const drift = await page(DriftPage);
    expect(drift).toContain("<polyline");
    expect(drift).toContain("new violations from 1 to 2, over 2 analyses");
  });

  it("does not let a run that finishes late pass for newer data", async () => {
    const fake = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("/tarball/") && !held) {
        held = true;
        await gate;
      }
      return fake(url, init);
    });
    const older = later();
    const first = runSnapshot(target, undefined, () => older);
    while (!held) await new Promise((r) => setTimeout(r, 1));
    const old = w.branches.main;
    merge({ "src/data/up.ts": `import "../ui/Page";` });
    expect(await snap()).toBe("saved");
    release();
    expect(await first).toBe("saved");
    const rows = snapshots();
    expect(rows.map((r) => r.commit_sha)).toEqual([old, w.branches.main]);
    expect(rows.at(-1).new_count).toBe(1);
    // As the pages read them: in the order the runs started, the late one first.
    expect((await store.listSnapshots(db, repoId)).map((r) => r.commit_sha)).toEqual([old, w.branches.main]);
    const newest = await store.newestSnapshots(db, repoId);
    expect([newest.any?.commit_sha, newest.complete?.commit_sha]).toEqual([w.branches.main, w.branches.main]);
  });

  it("marks what could not be read as incomplete, and leaves it out of the trend", async () => {
    await snap();
    merge({ "src/services/broken.ts": "import '../ui/Page'; `" });
    await snap();
    merge({}, ["src/services/broken.ts"]);
    await snap();
    expect(snapshots().map((r) => r.complete)).toEqual([1, 0, 1]);
    as("dev");
    const drift = await page(DriftPage);
    expect(drift).toContain("incomplete");
    expect(drift).toContain("over 2 analyses");
    expect((drift.match(/<polyline points="([^"]*)"/) ?? [])[1].split(" ")).toHaveLength(2);
  });

  it("is only for a repo Voxium knows under that installation, and its default branch", async () => {
    expect(await runSnapshot({ ...target, installationId: 999 }, undefined, later)).toBe("unknown_repo");
    expect(await runSnapshot({ ...target, defaultBranch: "release" }, undefined, later)).toBe("unknown_repo");
    expect(snapshots()).toEqual([]);
    const { closedPrFrom } = await import("./webhook");
    expect(closedPrFrom("pull_request", { action: "closed", installation: { id: 3 }, repository: { id: 77, full_name: "o/r", default_branch: "main" }, pull_request: { number: 1, merged: true, user: { id: 1 }, head: { sha: "x" }, base: { ref: "release" } } } as never)).toBeNull();
  });

  it("can be asked for by an Owner or Team Leader with write access, once a minute, and is audited", async () => {
    const analyse = () => post(snapshotPost, { id: String(repoId) }, {});
    as("dev");
    expect((await analyse()).searchParams.get("error")).toMatch(/Only an Owner or Team Leader/);
    as("lead");
    expect((await analyse()).searchParams.get("error")).toBeNull();
    expect(snapshots()).toHaveLength(1);
    expect((await analyse()).searchParams.get("error")).toMatch(/less than a minute ago/);
    expect(audits().filter((a) => a === "snapshot_run")).toHaveLength(1);
  });

  it("draws the modules and the imports the snapshot has, escaping names, with the table", async () => {
    const tricky = { ...arch, modules: { ...arch.modules, '<img src=x onerror="alert(1)">': { paths: ["src/x/**"] } } };
    merge({ [ARCH]: JSON.stringify(tricky), "src/x/a.ts": `import "../ui/Page";`, "src/data/up.ts": `import "../ui/Page";` });
    await snap();
    as("dev");
    const diagram = await page(DiagramPage);
    expect(diagram).not.toContain("<img");
    expect(diagram).toContain("&lt;img src=x");
    const data = JSON.parse(snapshots()[0].snapshot_json);
    const rows = [...diagram.matchAll(/<tr><td><a [^>]*><code>([^<]*)<\/code><\/a><\/td><td><a [^>]*><code>([^<]*)<\/code><\/a><\/td><td>(\d+)<\/td>/g)].map((m) => `${m[1]}>${m[2]}:${m[3]}`);
    const unescape = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    expect(rows.map(unescape).sort()).toEqual(data.edges.map((e: any) => `${e.from}>${e.to}:${e.imports}`).sort());
    expect(diagram).toContain("✕ 1");
    expect(diagram).toMatch(/<title id="diagram-title">\d+ modules and \d+ imports/);
    const focused = await page(DiagramPage, { module: "data" });
    expect(focused).toContain("Showing the imports of <code>data</code>");
    expect(focused).not.toMatch(/<code>services<\/code><\/a><\/td><td><a [^>]*><code>ui</);
  });

  it("shows nothing of a repo to someone who cannot open it, in any page, count or export", async () => {
    await snap();
    // eve can read the repo on GitHub but is not in the organization; dev may open o/r and not o/other.
    as("eve");
    await expect(page(DriftPage)).rejects.toThrow("NOT_FOUND");
    await expect(page(DiagramPage)).rejects.toThrow("NOT_FOUND");
    const orgId = (raw.prepare("SELECT id FROM orgs").all() as any[])[0].id;
    const overview = (who: string) => (as(who), html(OverviewPage({ params: Promise.resolve({ id: String(orgId) }) })));
    await expect(overview("eve")).rejects.toThrow("NOT_FOUND");
    await store.replaceRepoAccess(db, users.dev.id, orgId, [{ id: 77, permissions: { push: true } }]);
    const seen = await overview("dev");
    expect(seen).toContain("o/r");
    expect(seen).not.toContain("o/other");
    // Only an Owner opens the audit log or exports it.
    const auditPage = (who: string) => (as(who), html(AuditPage({ params: Promise.resolve({ id: String(orgId) }), searchParams: Promise.resolve({}) })));
    await expect(auditPage("lead")).rejects.toThrow("NOT_FOUND");
    await expect(auditPage("dev")).rejects.toThrow("NOT_FOUND");
    as("lead");
    const refused = await post(auditExport, { id: String(orgId) }, { format: "csv" });
    expect(refused.pathname).toBe("/dashboard");
    expect(audits()).not.toContain("audit_exported");
  });

  it("exports the audit log for an Owner as CSV a spreadsheet reads as text, and logs the export", async () => {
    const orgId = (raw.prepare("SELECT id FROM orgs").all() as any[])[0].id;
    for (const detail of ['=HYPERLINK("https://evil")', "+1", "-2", "@SUM(A1)", "\tx", "\rx", 'a "quoted", text'])
      await store.audit(db, orgId, users.dev.id, "proposal_created", detail);
    as("boss");
    const req = new Request("https://vx.test/api", { method: "POST", headers: { origin: "https://vx.test", "content-type": "application/x-www-form-urlencoded" }, body: "format=csv" });
    const res = await (auditExport as unknown as Handler)(req as never, { params: Promise.resolve({ id: String(orgId) }) } as never);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const csv = await res.text();
    for (const cell of [`"'=HYPERLINK(""https://evil"")"`, `"'+1"`, `"'-2"`, `"'@SUM(A1)"`, `"'\tx"`, `"'\rx"`, `"a ""quoted"", text"`]) expect(csv).toContain(cell);
    expect(csv.split("\r\n")[1]).toContain('"audit_exported"');
    expect(audits().filter((a) => a === "audit_exported")).toHaveLength(1);
    const audit = await html(AuditPage({ params: Promise.resolve({ id: String(orgId) }), searchParams: Promise.resolve({ action: "proposal_created" }) }));
    expect(audit).toContain("=HYPERLINK");
    expect(audit).not.toContain("audit_exported</code>");
    // A cross-site form exports nothing.
    expect((await post(auditExport, { id: String(orgId) }, { format: "csv" }, "https://evil.test")).pathname).toBe("/dashboard");
  });

  it("keeps the newest snapshots and checks, and nothing else is pruned", async () => {
    const repo = repoId;
    for (let i = 0; i < 405; i++) await store.saveSnapshot(db, { repo_id: repo, commit_sha: `s${i}`, complete: 1, new_count: 0, baseline_count: i, excepted_count: 0, warn_count: 0, snapshot_json: "null", created_at: `2026-01-01 00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}` });
    await store.saveAnalysis(db, { repo_id: repo, kind: "inference", summary: {} });
    for (let i = 0; i < 505; i++) await store.saveAnalysis(db, { repo_id: repo, kind: "pr_check", pr_number: i, commit_sha: `c${i}`, summary: { state: "success" } });
    const pull = openPull(4, "dev", { [ARCH]: JSON.stringify({ ...arch, rules: [] }) });
    as("boss");
    await approve(pull);
    const before = raw.prepare("SELECT COUNT(*) AS n FROM self_approvals").all() as any[];
    await store.pruneHistory(db, repo);
    const kept = raw.prepare("SELECT MIN(baseline_count) AS lo, COUNT(*) AS n FROM snapshots").all() as any[];
    expect(kept[0]).toEqual({ lo: 5, n: 400 });
    expect((raw.prepare("SELECT kind, COUNT(*) AS n, MIN(pr_number) AS lo FROM analyses GROUP BY kind ORDER BY kind").all() as any[])).toEqual([{ kind: "inference", n: 1, lo: null }, { kind: "pr_check", n: 500, lo: 5 }]);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM self_approvals").all()).toEqual(before);
    // Pages list the counts of every snapshot, but read the contents, up to 200 KB each, of the newest only.
    const listed = await store.listSnapshots(db, repo);
    expect(listed).toHaveLength(400);
    expect(listed.every((r) => !("snapshot_json" in r))).toBe(true);
  });
});

describe("organization rule sets", () => {
  const noLodash = { id: "ORG-NO-LODASH", type: "deny_external", module: "*", packages: ["lodash"], severity: "block", description: "Use the standard library.", rationale: "Smaller bundles." };
  const orgId = () => (raw.prepare("SELECT id FROM orgs WHERE installation_id = 3").all() as any[])[0].id as number;
  const sets = () => raw.prepare("SELECT version, note FROM org_rule_sets ORDER BY version").all() as any[];
  const rules = (form: Record<string, string>, id = orgId()) => post(orgRulesPost, { id: String(id) }, form);
  const checkRules = (r: unknown[], note = "Agreed in the architecture guild") => rules({ action: "check", rules: JSON.stringify(r), note });
  const save = async () => {
    const d = (raw.prepare("SELECT * FROM org_rule_drafts").all() as any[])[0];
    const { draftHash } = await import("./org-rules");
    return rules({ action: "save", based_on: String(d.based_on), draft: await draftHash(d) });
  };
  const rulesPage = () => html(OrgRulesPage({ params: Promise.resolve({ id: String(orgId()) }), searchParams: Promise.resolve({}) }));

  it("saves a version after a preview, which changes no repository", async () => {
    as("lead");
    expect((await checkRules([{ ...noLodash, type: "layers" }])).searchParams.get("error")).toMatch(/layers rules cannot be organization rules/);
    expect((await checkRules([noLodash], "")).searchParams.get("error")).toMatch(/Write why/);
    expect((await checkRules([noLodash])).searchParams.get("error")).toBeNull();
    expect(await rulesPage()).toContain("Adds organization rule ORG-NO-LODASH from version 1 [block]: Use the standard library.");
    const before = { ...w.branches };
    expect((await save()).searchParams.get("error")).toBeNull();
    expect(sets()).toEqual([{ version: 1, note: "Agreed in the architecture guild" }]);
    expect(w.branches).toEqual(before);
    expect(Object.keys(w.pulls)).toEqual([]);
    expect(audits()).toContain("org_rules_saved");
    // Saving the same draft again is refused: it is gone.
    expect((await rules({ action: "save", based_on: "0", draft: "x" })).searchParams.get("error")).toMatch(/Check the rules first/);
  });

  it("refuses a version that gives an id another type, which would change what debt under it means", async () => {
    as("lead");
    await checkRules([noLodash]);
    await save();
    expect((await checkRules([{ id: "ORG-NO-LODASH", type: "max_file_lines", max: 500, severity: "block", description: "d", rationale: "r" }])).searchParams.get("error")).toMatch(/is a deny_external rule in version 1. A rule that checks something else needs a new id/);
  });

  it("gives two saves at once different versions, or refuses the second", async () => {
    as("lead");
    await checkRules([noLodash]);
    const d = (raw.prepare("SELECT * FROM org_rule_drafts").all() as any[])[0];
    const both = await Promise.all([1, 2].map(() => store.saveOrgRuleSet(db, { org_id: orgId(), based_on: 0, rules_json: d.rules_json, note: "n", updated_by: users.lead.id })));
    expect(both.sort()).toEqual([1, null].sort());
    // A draft made on version 0 cannot be saved now that version 1 exists.
    expect((await save()).searchParams.get("error")).toMatch(/Version 1 was saved since this draft was made/);
    expect(sets()).toHaveLength(1);
  });

  it("cannot be viewed or saved by a member, an outsider, a Team Leader who left, or for another organization", async () => {
    for (const who of ["dev", "eve"]) {
      as(who);
      await expect(rulesPage()).rejects.toThrow("NOT_FOUND");
      expect((await checkRules([noLodash])).pathname).toBe("/dashboard");
    }
    // Still a Team Leader in Voxium, but no longer in the organization on GitHub.
    delete w.org.lead;
    as("lead");
    await expect(rulesPage()).rejects.toThrow("NOT_FOUND");
    expect((await checkRules([noLodash])).pathname).toBe("/dashboard");
    w.org.lead = "member";
    const other = await store.upsertOrg(db, { installation_id: 4, account_id: 51, account_login: "elsewhere", account_type: "Organization" });
    expect((await checkRules([noLodash], "n n n").then(() => rules({ action: "check", rules: JSON.stringify([noLodash]), note: "nnn" }, other.id))).pathname).toBe("/dashboard");
    expect(raw.prepare("SELECT org_id FROM org_rule_drafts").all()).toEqual([{ org_id: orgId() }]);
  });

  it("reaches a repository only through its pull request, approved in Voxium by someone other than who asked", async () => {
    w.branches.main = commit(w.branches.main, { "src/services/s.ts": `import "../data/d"; import "lodash";` });
    as("lead");
    await checkRules([noLodash]);
    await save();
    // A member cannot ask, and a Team Leader without access to the repository finds nothing.
    as("dev");
    expect((await post(orgUpdatePost, { id: String(repoId) }, {})).searchParams.get("error")).toMatch(/Only an Owner or Team Leader/);
    delete w.perms.lead;
    as("lead");
    expect((await post(orgUpdatePost, { id: String(repoId) }, {})).pathname).toBe("/dashboard");
    expect(proposals()).toEqual([]);
    w.perms.lead = "write";
    const to = await post(orgUpdatePost, { id: String(repoId) }, { acceptDebt: "on" });
    expect(to.pathname).toMatch(/\/proposals\/\d+$/);
    const [p] = proposals();
    expect(p).toMatchObject({ requester_login: "lead", title: "Organization rules version 1" });
    // Opening its pull request shows what newly fails, which it accepts as debt here.
    await decide(p.id, { action: "open_pr" });
    const pull = botPull();
    const written = JSON.parse(w.commits[pull.head.sha][ARCH]);
    expect(written.rules.at(-1)).toEqual({ ...noLodash, org: { version: 1 } });
    expect(written.meta).toEqual({ orgRules: { org: "o", version: 1 } });
    expect(JSON.parse(w.commits[pull.head.sha]["voxium/baseline.json"]).violations).toEqual(["ORG-NO-LODASH:src/services/s.ts->lodash"]);
    expect(pull.body).toContain("ORG-NO-LODASH:src/services/s.ts->lodash");
    expect(w.commits[pull.head.sha]["CLAUDE.md"]).toContain("* ORG-NO-LODASH [block] (organization rule): Use the standard library.");
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure" });
    // lead asked for it, so lead cannot approve it; the Owner can.
    expect((await approve(pull)).searchParams.get("error")).toMatch(/You asked for this change/);
    as("boss");
    await approve(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "success" });
    // Asking again for the version it is getting is refused once it is merged.
    w.branches.main = pull.head.sha;
    as("lead");
    expect((await post(orgUpdatePost, { id: String(repoId) }, {})).searchParams.get("error")).toMatch(/has version 1 already/);
  });

  it("refuses a repository whose own rule has an organization rule's id", async () => {
    w.branches.main = commit(w.branches.main, { [ARCH]: JSON.stringify({ ...arch, rules: [...arch.rules, { ...noLodash, id: "ORG-NO-LODASH", module: "ui" }] }) });
    as("lead");
    await checkRules([noLodash]);
    await save();
    expect((await post(orgUpdatePost, { id: String(repoId) }, {})).searchParams.get("error")).toMatch(/has the id of an organization rule/);
    expect(proposals()).toEqual([]);
  });

  it("fails every pull request once an override has expired, until it is renewed or removed", async () => {
    const taken = { ...arch, rules: [...arch.rules, { ...noLodash, org: { version: 1 } }], overrides: [{ rule: "ORG-NO-LODASH", action: "disable", owner: "dev", reason: "for now", expires: "2020-01-01" }] };
    w.branches.main = commit(w.branches.main, { [ARCH]: JSON.stringify(taken), "voxium/baseline.json": JSON.stringify({ violations: [] }) });
    const pull = openPull(4, "dev", { "src/ui/Other.ts": "export {};" });
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure", description: expect.stringMatching(/1 expired exception\(s\) or override\(s\)/) });
  });

  it("names an override, and a rule newly marked as an organization's, for whoever approves", async () => {
    const taken = { ...arch, rules: [...arch.rules, { ...noLodash, org: { version: 1 } }], meta: { orgRules: { org: "o", version: 1 } } };
    w.branches.main = commit(w.branches.main, { [ARCH]: JSON.stringify(taken) });
    const sneaky = { ...taken, overrides: [{ rule: "ORG-NO-LODASH", action: "disable", owner: "dev", reason: "for now", expires: "2999-01-01" }] };
    const pull = openPull(4, "dev", { [ARCH]: JSON.stringify(sneaky) });
    await check(pull);
    expect(last(pull.head.sha)).toMatchObject({ state: "failure" });
    as("lead");
    const page = await html(PullPage({ params: Promise.resolve({ id: String(repoId), number: "4" }), searchParams: Promise.resolve({}) }));
    expect(page).toContain("Overrides organization rule ORG-NO-LODASH: turns it off until 2999-01-01 (owner dev: for now)");
  });
});
