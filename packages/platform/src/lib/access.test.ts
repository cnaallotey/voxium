import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "./d1";
import type { Env } from "./env";
import { githubRepoLevel, githubStanding, resolveRole } from "./access";
import { syncAccess } from "./sign-in";
import { database, migrations } from "./test-db";
import { beginCheck, getSelfApproval, listDecisions, listPeople, saveDecision, saveSelfApproval, setTeamLeader, syncMembership, withdrawSelfApproval, removeRepos, type Decision, getRole, getStoredRole, isLatestCheck, listMemberships, listOrgsForUser, listReposForUser, upsertOrg, upsertRepos, upsertUser, type UserRow } from "./store";

const here = path.dirname(fileURLToPath(import.meta.url));
const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

interface Repo { id: number; full_name: string; default_branch: string; private: boolean; permissions?: object }
interface Install { id: number; app_id?: number; suspended_at?: string | null; account: { id: number; login: string; type: string }; repos: Repo[] }
interface World {
  installations: Install[];
  /** "org/login" to membership. */
  members?: Record<string, { id: number; role: string; state?: string }>;
  fail?: string;
}

/** Put a role on record directly. */
async function setMembership(to: D1Database, userId: number, orgId: number, role: string): Promise<void> {
  await to.prepare("INSERT INTO memberships (user_id, org_id, role) VALUES (?, ?, ?) ON CONFLICT(user_id, org_id) DO UPDATE SET role = excluded.role, state = 'active'").bind(userId, orgId, role).run();
}

function github(w: World) {
  vi.stubGlobal("fetch", async (url: string) => {
    const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status });
    const p = url.replace("https://api.github.com", "");
    if (w.fail && p.includes(w.fail)) return json({ message: "boom" }, 502);
    let m: RegExpMatchArray | null;
    if (p.startsWith("/app/installations/")) return json({ token: "t" }, 201);
    if (p.startsWith("/user/installations?")) return json({ installations: w.installations.map((i) => ({ app_id: 1, suspended_at: null, ...i })) });
    if ((m = p.match(/^\/user\/installations\/(\d+)\/repositories/))) {
      const page = Number(new URL(url).searchParams.get("page"));
      return json({ repositories: w.installations.find((i) => i.id === Number(m![1]))!.repos.slice((page - 1) * 100, page * 100) });
    }
    if ((m = p.match(/^\/orgs\/(\w+)\/memberships\/(\w+)/))) {
      const found = w.members?.[`${m[1]}/${m[2]}`];
      return found ? json({ state: "active", ...found, user: { id: found.id } }) : json({}, 404);
    }
    return json({ message: `unexpected ${p}` }, 500);
  });
}

const repo = (id: number, name: string, permissions: object = { pull: true }): Repo => ({
  id, full_name: `acme/${name}`, default_branch: "main", private: true, permissions,
});
const acme = (repos: Repo[], over: Partial<Install> = {}): Install => ({ id: 10, account: { id: 500, login: "acme", type: "Organization" }, repos, ...over });

let db: D1Database;
let raw: Sqlite;
let env: Env;
let user: UserRow;
const orgId = async () => (await upsertOrg(db, { installation_id: 10, account_id: 500, account_login: "acme", account_type: "Organization" })).id;
const visible = async (u = user) => (await listReposForUser(db, u.id, await orgId())).map((r) => `${r.full_name}:${r.level}`);

beforeEach(async () => {
  ({ db, raw } = database());
  env = { DB: db, GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: key } as Env;
  user = await upsertUser(db, { github_id: 1, login: "ann", name: null, avatar_url: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("roles at sign in", () => {
  it("does not make the first person to sign in an Owner", async () => {
    github({ installations: [acme([repo(1, "web")])], members: { "acme/ann": { id: 1, role: "member" } } });
    await syncAccess(env, user, "u");
    expect(await getRole(db, user.id, await orgId())).toBe("member");
  });

  it("makes organization admins Owner, and takes it back when they lose it", async () => {
    const w: World = { installations: [acme([repo(1, "web")])], members: { "acme/ann": { id: 1, role: "admin" } } };
    github(w);
    await syncAccess(env, user, "u");
    expect(await getRole(db, user.id, await orgId())).toBe("owner");

    github({ ...w, members: { "acme/ann": { id: 1, role: "member" } } });
    await syncAccess(env, user, "u");
    expect(await getRole(db, user.id, await orgId())).toBe("member");
    expect(raw.prepare("SELECT detail FROM audit_log WHERE action = 'role_changed' ORDER BY id").all().map((r: any) => r.detail)).toEqual([
      "none to owner",
      "owner to member",
    ]);
  });

  it("on a personal account only the account holder is Owner", async () => {
    const personal = (id: number): Install => ({ id: 20, account: { id, login: "bob", type: "User" }, repos: [repo(2, "lib")] });
    github({ installations: [personal(2)] });
    await syncAccess(env, user, "u"); // a collaborator
    expect((await listOrgsForUser(db, user.id))[0].role).toBe("member");

    const bob = await upsertUser(db, { github_id: 2, login: "bob", name: null, avatar_url: null });
    await syncAccess(env, bob, "u");
    expect((await listOrgsForUser(db, bob.id))[0].role).toBe("owner");
  });

  it("keeps Team Leaders while they are members, and drops the role when they leave", async () => {
    await setMembership(db, user.id, await orgId(), "team_leader");
    const w: World = { installations: [acme([repo(1, "web")])], members: { "acme/ann": { id: 1, role: "member" } } };
    github(w);
    await syncAccess(env, user, "u");
    expect(await getRole(db, user.id, await orgId())).toBe("team_leader");
    github({ ...w, members: {} }); // now only an outside collaborator
    await syncAccess(env, user, "u");
    expect(await getRole(db, user.id, await orgId())).toBe("member");
  });

  it("takes away owners granted under the old rule when the migration runs", async () => {
    const old = database(["0001_init.sql"]);
    old.raw.exec("INSERT INTO users(github_id,login) VALUES(1,'a'); INSERT INTO orgs(installation_id,account_login,account_type) VALUES(1,'o','User'); INSERT INTO memberships VALUES(1,1,'owner');");
    old.raw.exec(fs.readFileSync(path.join(migrations, "0002_access.sql"), "utf8"));
    expect(old.raw.prepare("SELECT role FROM memberships").all()).toMatchObject([{ role: "member" }]);
  });

  it("resolves roles from standing", () => {
    expect(resolveRole("owner", "member")).toBe("owner");
    expect(resolveRole("member", "owner")).toBe("member");
    expect(resolveRole("outside", "team_leader")).toBe("member");
  });
});

describe("repo visibility", () => {
  it("shows each person only the repos they can open on GitHub, with their level", async () => {
    // The org has a private repo that ann cannot open.
    await upsertRepos(db, await orgId(), [repo(1, "web"), repo(2, "secret"), repo(3, "api"), repo(4, "infra")]);
    github({
      installations: [acme([repo(1, "web"), repo(3, "api", { push: true, pull: true }), repo(4, "infra", { admin: true, push: true })])],
      members: { "acme/ann": { id: 1, role: "member" } },
    });
    await syncAccess(env, user, "u");
    expect(await visible()).toEqual(["acme/api:write", "acme/infra:admin", "acme/web:read"]);

    const zed = await upsertUser(db, { github_id: 9, login: "zed", name: null, avatar_url: null });
    expect(await visible(zed)).toEqual([]);
  });

  it("removes repos and whole organizations as access goes away", async () => {
    const members = { "acme/ann": { id: 1, role: "member" } };
    github({ installations: [acme([repo(1, "web"), repo(2, "api")])], members });
    await syncAccess(env, user, "u");
    github({ installations: [acme([repo(1, "web")])], members });
    await syncAccess(env, user, "u");
    expect(await visible()).toEqual(["acme/web:read"]);

    github({ installations: [] });
    await syncAccess(env, user, "u");
    expect(await visible()).toEqual([]);
    expect(await listOrgsForUser(db, user.id)).toEqual([]);
    expect(raw.prepare("SELECT count(*) AS n FROM repo_access").all()).toMatchObject([{ n: 0 }]);
  });

  it("treats suspended installations and other apps as no access", async () => {
    github({ installations: [acme([repo(1, "web")], { suspended_at: "2026-01-01" }), acme([repo(2, "x")], { id: 11, app_id: 99 })] });
    await syncAccess(env, user, "u");
    expect(await listOrgsForUser(db, user.id)).toEqual([]);
  });

  it("handles more repos than one batch holds", async () => {
    const many = Array.from({ length: 120 }, (_, i) => repo(i + 1, `r${i}`));
    many.push(many[0]); // repeated across pages
    github({ installations: [acme(many)], members: { "acme/ann": { id: 1, role: "member" } } });
    await syncAccess(env, user, "u");
    await syncAccess(env, user, "u");
    expect(await visible()).toHaveLength(120);
  });

  it("fails closed when GitHub cannot answer", async () => {
    const w: World = { installations: [acme([repo(1, "web")])], members: { "acme/ann": { id: 1, role: "admin" } } };
    github(w);
    await syncAccess(env, user, "u");
    expect(await visible()).toHaveLength(1);

    github({ ...w, fail: "/memberships/" });
    await syncAccess(env, user, "u");
    expect(await visible()).toEqual([]);
    expect(await getRole(db, user.id, await orgId())).toBeNull();
    expect(await listMemberships(db, user.id)).toMatchObject([{ account_login: "acme", state: "error" }]);

    github(w);
    await syncAccess(env, user, "u");
    expect(await getRole(db, user.id, await orgId())).toBe("owner");

    github({ ...w, fail: "/user/installations?" });
    await expect(syncAccess(env, user, "u")).rejects.toThrow(/list installations/);
  });
});

describe("temporary loss of access", () => {
  const w: World = { installations: [acme([repo(1, "web")])], members: { "acme/ann": { id: 1, role: "member" } } };

  it.each([
    ["the app is suspended", { ...w, installations: [acme([repo(1, "web")], { suspended_at: "2026-01-01" })] }],
    ["GitHub leaves the org out, as without an SSO session", { ...w, installations: [] }],
    ["GitHub cannot answer", { ...w, fail: "/memberships/" }],
  ])("gives nothing while %s, and the Team Leader role back afterwards", async (_n, broken) => {
    await setMembership(db, user.id, await orgId(), "team_leader");
    github(w);
    await syncAccess(env, user, "u");
    github(broken);
    await syncAccess(env, user, "u");
    await syncAccess(env, user, "u");
    expect(await getRole(db, user.id, await orgId())).toBeNull();
    expect(await visible()).toEqual([]);
    expect(await listOrgsForUser(db, user.id)).toEqual([]);
    expect(await getStoredRole(db, user.id, await orgId())).toBe("team_leader");

    github(w);
    await syncAccess(env, user, "u");
    expect(await getRole(db, user.id, await orgId())).toBe("team_leader");
  });

  it("does not give it back when the person left meanwhile", async () => {
    await setMembership(db, user.id, await orgId(), "team_leader");
    github({ ...w, installations: [] });
    await syncAccess(env, user, "u");
    github({ ...w, members: {} });
    await syncAccess(env, user, "u");
    expect(await getRole(db, user.id, await orgId())).toBe("member");
  });

  it("records the problem for someone who signs in for the first time", async () => {
    github({ ...w, fail: "/memberships/" });
    await syncAccess(env, user, "u");
    expect(await listMemberships(db, user.id)).toMatchObject([{ account_login: "acme", state: "error" }]);
    expect(await listOrgsForUser(db, user.id)).toEqual([]);
  });
});

describe("check ordering", () => {
  it("only the newest run of a commit and status counts", async () => {
    const a = await beginCheck(db, 7, "sha", "voxium/rules");
    const b = await beginCheck(db, 7, "sha", "voxium/rules");
    const other = await beginCheck(db, 7, "sha", "voxium/rules (dev)");
    expect(await isLatestCheck(db, 7, "sha", "voxium/rules", a)).toBe(false);
    expect(await isLatestCheck(db, 7, "sha", "voxium/rules", b)).toBe(true);
    expect(await isLatestCheck(db, 7, "sha", "voxium/rules (dev)", other)).toBe(true);
    raw.exec("UPDATE check_runs SET updated_at = datetime('now', '-8 days')");
    await beginCheck(db, 8, "new", "voxium/rules");
    expect(raw.prepare("SELECT count(*) AS n FROM check_runs").all()).toMatchObject([{ n: 1 }]);
  });
});

describe("GitHub answers", () => {
  const org = { account_id: 500, account_login: "acme", account_type: "Organization" };
  const ann = { github_id: 1, login: "ann" };
  const reply = (body: unknown, status = 200) => vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));

  it("does not trust a login that now belongs to someone else", async () => {
    reply({ state: "active", role: "admin", user: { id: 2 } });
    expect(await githubStanding("t", org, ann)).toBe("outside");
    reply({ permission: "admin", user: { id: 2 } });
    expect(await githubRepoLevel("t", "acme/web", ann)).toBeNull();
  });

  it("maps membership and permission, and throws when it may not ask", async () => {
    reply({ state: "pending", role: "admin", user: { id: 1 } });
    expect(await githubStanding("t", org, ann)).toBe("outside");
    reply({ permission: "none", user: { id: 1 } });
    expect(await githubRepoLevel("t", "acme/web", ann)).toBeNull();
    reply({ permission: "write", user: { id: 1 } });
    expect(await githubRepoLevel("t", "acme/web", ann)).toBe("write");
    reply({ message: "Resource not accessible by integration" }, 403);
    await expect(githubStanding("t", org, ann)).rejects.toThrow();
    await expect(githubRepoLevel("t", "acme/web", ann)).rejects.toThrow();
    expect(await githubStanding("t", { ...org, account_type: "User", account_id: null }, ann)).toBe("outside");
  });
});

describe("GitHub App credentials", () => {
  it("land next to the script, which is git ignored, whatever folder it runs from", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vx app ")); // a space, to exercise the entry point check
    const script = path.join(dir, "convert-manifest.mjs");
    fs.copyFileSync(path.join(here, "../../github-app/convert-manifest.mjs"), script);
    const stub = path.join(dir, "stub.mjs");
    fs.writeFileSync(stub, `globalThis.fetch = async () => new Response(JSON.stringify({ id: 1, slug: "s", client_id: "c", client_secret: "top-a", webhook_secret: "top-b", pem: "PEM\\nKEY\\n" }));`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vx-cwd-"));
    const printed = execFileSync(process.execPath, ["--import", pathToFileURL(stub).href, script, "code12345"], { cwd, stdio: "pipe" }).toString();
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(fs.readdirSync(path.join(dir, "out")).sort()).toEqual(["secrets.json", "vars.env"]);
    const file = path.join(dir, "out/secrets.json");
    const secrets = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(secrets).toEqual({
      GITHUB_CLIENT_SECRET: "top-a", GITHUB_WEBHOOK_SECRET: "top-b", GITHUB_APP_PRIVATE_KEY: "PEM\nKEY\n",
      SESSION_SECRET: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, "out/vars.env"), "utf8")).toBe("GITHUB_APP_ID=1\nGITHUB_APP_SLUG=s\nGITHUB_CLIENT_ID=c\n");
    expect(printed).not.toMatch(new RegExp(`top-|PEM|${secrets.SESSION_SECRET}`));
    expect(fs.readFileSync(path.join(here, "../../.gitignore"), "utf8")).toContain("github-app/out");
  });

  it("can go straight into .dev.vars, keeping what is there and leaving nothing else behind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vx-dev-"));
    const script = path.join(dir, "convert-manifest.mjs");
    fs.copyFileSync(path.join(here, "../../github-app/convert-manifest.mjs"), script);
    const stub = path.join(dir, "stub.mjs");
    fs.writeFileSync(stub, `globalThis.fetch = async (u) => { if (!String(u).includes("code12345")) return new Response("", { status: 404 }); return new Response(JSON.stringify({ id: 1, slug: "s", client_id: "c", client_secret: "x", webhook_secret: "y", pem: "-----BEGIN RSA PRIVATE KEY-----\\nAA==\\n-----END RSA PRIVATE KEY-----\\n" })); };`);
    const file = path.join(dir, ".dev.vars");
    const run = (...args: string[]) => execFileSync(process.execPath, ["--import", pathToFileURL(stub).href, script, ...args], { stdio: "pipe" }).toString();
    fs.writeFileSync(file, "# mine\nAPP_URL=http://localhost:4000\nGITHUB_CLIENT_ID=old\nSESSION_SECRET=keep-this\n", { mode: 0o644 });
    const printed = run("code12345", "--dev-vars", file);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toBe(
      "# mine\nAPP_URL=http://localhost:4000\nSESSION_SECRET=keep-this\nGITHUB_APP_ID=1\nGITHUB_APP_SLUG=s\nGITHUB_CLIENT_ID=c\n" +
        'GITHUB_CLIENT_SECRET=x\nGITHUB_WEBHOOK_SECRET=y\nGITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\nAA==\\n-----END RSA PRIVATE KEY-----"\n',
    );
    expect(printed).not.toMatch(/BEGIN|keep-this/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dir, "out"))).toBe(false);

    const fresh = path.join(dir, "fresh.vars");
    run("--dev-vars", "code12345"); // default location, flag first
    expect(fs.existsSync(path.join(dir, "../.dev.vars"))).toBe(true);
    fs.rmSync(path.join(dir, "../.dev.vars"));
    fs.writeFileSync(fresh, "SESSION_SECRET=change-me-to-a-long-random-string\n");
    run("code12345", "--dev-vars", fresh);
    expect(fs.readFileSync(fresh, "utf8")).toMatch(/SESSION_SECRET=[0-9a-f]{64}/);
  });
});

describe("roles on record", () => {
  const role = async () => getStoredRole(db, user.id, await orgId());

  it("follow GitHub, and keep Team Leader only for members", async () => {
    const org = await orgId();
    expect(await syncMembership(db, user.id, org, "outside")).toBe("member");
    expect(await setTeamLeader(db, user.id, org, true)).toBe(true);
    expect(await syncMembership(db, user.id, org, "member")).toBe("team_leader");
    expect(await syncMembership(db, user.id, org, "owner")).toBe("owner");
    expect(await syncMembership(db, user.id, org, "member")).toBe("member");
    await setTeamLeader(db, user.id, org, true);
    expect(await syncMembership(db, user.id, org, "outside")).toBe("member");
  });

  it("a sign in that overlaps a demotion cannot bring Team Leader back", async () => {
    const org = await orgId();
    await syncMembership(db, user.id, org, "member");
    await setTeamLeader(db, user.id, org, true);
    expect(await role()).toBe("team_leader"); // what a sign in read before...
    await setTeamLeader(db, user.id, org, false); // ...the Owner took it away
    expect(await syncMembership(db, user.id, org, "member")).toBe("member");
  });

  it("cannot make or unmake an Owner, or a stranger", async () => {
    const org = await orgId();
    await syncMembership(db, user.id, org, "owner");
    expect(await setTeamLeader(db, user.id, org, true)).toBe(false);
    expect(await setTeamLeader(db, user.id, org, false)).toBe(false);
    expect(await role()).toBe("owner");
    const zed = await upsertUser(db, { github_id: 9, login: "zed", name: null, avatar_url: null });
    expect(await setTeamLeader(db, zed.id, org, true)).toBe(false);
    expect((await listPeople(db, org)).map((p) => p.login)).toEqual([user.login]);
  });
});

describe("approvals and decisions on record", () => {
  it("an approval is for one commit into one branch, and its giver can take it back", async () => {
    const org = await orgId();
    await upsertRepos(db, org, [repo(1, "web")]);
    const pull = { repoId: 1, number: 4, headSha: "h", baseRef: "main" };
    await saveSelfApproval(db, pull, user.id, "because");
    expect(await getSelfApproval(db, pull)).toMatchObject({ github_id: user.github_id, reason: "because" });
    for (const other of [{ headSha: "x" }, { baseRef: "dev" }, { number: 5 }, { repoId: 2 }]) {
      expect(await getSelfApproval(db, { ...pull, ...other })).toBeNull();
    }
    await saveSelfApproval(db, pull, user.id, "better reason");
    expect((await getSelfApproval(db, pull))!.reason).toBe("better reason");
    const zed = await upsertUser(db, { github_id: 9, login: "zed", name: null, avatar_url: null });
    await withdrawSelfApproval(db, 1, 4, zed.id);
    expect(await getSelfApproval(db, pull)).not.toBeNull();
    await withdrawSelfApproval(db, 1, 4, user.id);
    expect(await getSelfApproval(db, pull)).toBeNull();
  });

  it("the log cannot be rewritten and outlives the repo being disconnected", async () => {
    const d: Decision = {
      github_repo_id: 1, pr_number: 4, kind: "unapproved", title: "T", changes: ["Removes rule X"], reason: null,
      approved_by: null, merged_by: "ann", head_sha: "h", merged_at: "2026-01-01T00:00:00Z",
    };
    await upsertRepos(db, await orgId(), [repo(1, "web")]);
    await saveDecision(db, d);
    await saveDecision(db, { ...d, kind: "approved", approved_by: "ann" });
    await removeRepos(db, [1]);
    expect(await listDecisions(db, 1)).toMatchObject([d]);
    expect(await listDecisions(db, 2)).toEqual([]);
  });
});
