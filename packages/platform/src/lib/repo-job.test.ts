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
  getProposalByPr: async () => null,
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
  /** The pull request's diff, or the status GitHub answers with instead. */
  diff?: Array<{ filename: string; status: string; patch?: string }> | number;
  /** Called when a tarball is requested, to hold a run back. */
  onTarball?: (sha: string) => Promise<void>;
  /** A commit whose files GitHub cannot list completely. */
  truncatedAt?: string;
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
      return json({ truncated: (w.truncated ?? false) || w.truncatedAt === m[1], tree: Object.entries(w.commits[m[1]]).map(([path, c]) => ({ path, type: "blob", sha: blobSha(c) })) });
    }
    if ((m = p.match(/\/tarball\/(\w+)/))) {
      await w.onTarball?.(m[1]);
      const files = Object.entries(w.commits[m[1]]).filter(([f]) => !w.exportIgnore?.includes(f));
      return new Response(gzipSync(Buffer.concat([...files.map(([f, c]) => tarEntry(f, w.altered?.[f] ?? c)), Buffer.alloc(1024)])));
    }
    if (p.includes("/pulls/4/files")) return typeof w.diff === "number" ? json({}, w.diff) : json(w.diff ?? []);
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

  describe("a new cycle", () => {
    // These rules know no layers, so only the diff tells which import of a cycle is new.
    const arch = JSON.stringify({ ...JSON.parse(rules[ARCH]), layers: [], rules: JSON.parse(rules[ARCH]).rules.filter((r: any) => r.type === "no_cycles") });
    const flat: Files = { ...rules, [ARCH]: arch };
    const at = async (files: Files, diff: World["diff"]) => {
      github({ branches: { main: "m" }, commits: { m: { ...code, ...flat }, head: { ...files, ...flat } }, mergeBase: "m", diff });
      await runPullRequestCheck(ev);
      expect(last()).toMatchObject({ state: "failure" });
      const { summary } = saved.at(-1) as any;
      expect(summary).not.toHaveProperty("cycles");
      const [{ file, line, message }] = summary.newViolations;
      return { file, line, message };
    };
    const head: Files = { ...code, "src/data/d.ts": `\nimport "../services/s";` };
    const added = (filename: string, line: number) => ({ filename, status: "modified", patch: `@@ -0,0 +${line} @@\n+x` });

    it("is shown at the import the pull request adds", async () => {
      expect(await at(head, [added("src/data/d.ts", 2)])).toMatchObject({ file: "src/data/d.ts", line: 2 });
      expect(await at(head, [added("src/services/s.ts", 1)])).toMatchObject({ file: "src/services/s.ts", line: 1 });
    });

    it("is not blamed on another line of a changed file", async () => {
      expect(await at(head, [added("src/services/s.ts", 5)])).toMatchObject({ file: "src/data/d.ts" });
    });

    it("is the only reason to ask for the diff", async () => {
      let asked = 0;
      const diff = () => (asked++, []);
      const w = (files: Files, baseline: string[]): World => {
        const r = { ...flat, "voxium/baseline.json": JSON.stringify({ violations: baseline }) };
        return { branches: { main: "m" }, commits: { m: { ...code, ...r }, head: { ...files, ...r } }, mergeBase: "m", get diff() { return diff(); } };
      };
      github(w(head, ["CYCLE01:data+services"]));
      await runPullRequestCheck(ev);
      expect([last()!.state, asked]).toEqual(["success", 0]);
      github(w(head, []));
      await runPullRequestCheck(ev);
      expect(last()!.state).toBe("failure");
      expect(asked).toBeGreaterThan(0);
    });

    it("is shown somewhere in the cycle when the diff does not tell", async () => {
      for (const diff of [[], [added("src/data/d.ts", 1)], 503]) {
        expect((await at(head, diff)).message).toMatch(/src\/data\/d\.ts:2 .*src\/services\/s\.ts|src\/services\/s\.ts:1 .*src\/data\/d\.ts/);
      }
    });

    it("is shown at an import of a moved file, of one too large for a diff, or through a changed file", async () => {
      for (const status of ["renamed", "modified"]) {
        expect(await at(head, [{ filename: "src/services/s.ts", status }])).toMatchObject({ file: "src/services/s.ts" });
        expect(await at(head, [{ filename: "src/data/d.ts", status }])).toMatchObject({ file: "src/data/d.ts" });
      }
      const through: Files = { ...code, "src/data/d.ts": `import "../x";`, "src/x.ts": `import "./services/s";` };
      expect(await at(through, [added("src/x.ts", 1)])).toMatchObject({ file: "src/data/d.ts" });
      const other: Files = { ...code, "src/services/s.ts": `import "../x";`, "src/x.ts": `import "./data/d";`, "src/data/d.ts": `import "../services/s";` };
      expect(await at(other, [added("src/x.ts", 1)])).toMatchObject({ file: "src/services/s.ts" });
    });
  });

  describe("what is left of an accepted cycle", () => {
    const whole: Files = { "src/ui/Page.ts": `import "../services/s";`, "src/services/s.ts": `import "../ui/Page"; import "../data/d";`, "src/data/d.ts": `import "../services/s";` };
    const own = prepareSetup(whole).setupFiles;
    const arch = JSON.stringify({ ...JSON.parse(own[ARCH]), rules: JSON.parse(own[ARCH]).rules.filter((r: any) => r.type === "no_cycles") });
    const r: Files = { [ARCH]: arch, "voxium/baseline.json": JSON.stringify({ violations: ["CYCLE01:data+services+ui"] }) };
    const less: Files = { ...whole, "src/data/d.ts": "" };
    let tarballs: string[];
    const run = async (main: Files, head: Files, over: Partial<World> = {}) => {
      tarballs = [];
      const w: World = { branches: { main: "m" }, commits: { m: { ...main, ...r }, base: { ...main, ...r }, head: { ...head, ...r } }, mergeBase: "base", onTarball: async (sha) => void tarballs.push(sha), ...over };
      github(w);
      await runPullRequestCheck(ev);
      return last();
    };

    it("passes, as existing debt", async () => {
      expect(await run(whole, less)).toMatchObject({ state: "success" });
      expect(saved.at(-1)).toMatchObject({ new_violations: 0, baseline_violations: 1 });
      expect((saved.at(-1) as any).summary).not.toHaveProperty("needsBase");
      expect(tarballs).toEqual(["head", "base"]);
    });

    it("is compared with where the pull request branched off", async () => {
      const w = { commits: { m: { ...whole, "src/services/s.ts": "", ...r }, base: { ...whole, ...r }, head: { ...less, ...r } } };
      expect(await run(whole, less, w)).toMatchObject({ state: "success" });
      const gone = { commits: { m: { ...whole, ...r }, base: { ...whole, "src/services/s.ts": "", ...r }, head: { ...less, ...r } } };
      expect(await run(whole, less, gone)).toMatchObject({ state: "failure" });
    });

    it("fails with a new connection", async () => {
      const ring: Files = { "src/ui/Page.ts": `import "../services/s";`, "src/services/s.ts": `import "../data/d";`, "src/data/d.ts": `import "../ui/Page";` };
      expect(await run(ring, { ...ring, "src/services/s.ts": `import "../ui/Page";` })).toMatchObject({ state: "failure" });
      // The code where the branch began is not taken from a file the pull request renamed or rewrote.
      expect(await run(ring, { ...ring, "src/services/s.ts": "", "src/services/t.ts": `import "../ui/Page";`, "src/ui/Page.ts": `import "../services/t";` })).toMatchObject({ state: "failure" });
    });

    it("fails when the earlier code cannot be listed or read", async () => {
      expect(await run(whole, less, { truncatedAt: "base" })).toMatchObject({ state: "failure" });
      expect(await run(whole, less, { altered: { "src/services/s.ts": "// changed on export" }, onTarball: undefined })).not.toMatchObject({ state: "success" });
      expect(await run(whole, less, { onTarball: async (sha) => { if (sha === "base") throw new Error("down"); } })).toMatchObject({ state: "error" });
    });

    it("is not compared with contents an archive made up", async () => {
      const ring: Files = { "src/ui/Page.ts": `import "../services/s";`, "src/services/s.ts": `import "../data/d";`, "src/data/d.ts": `import "../ui/Page";` };
      const head = { ...ring, "src/services/s.ts": `import "../ui/Page";` };
      const old = { ...ring, "src/services/old.ts": "// nothing" };
      expect(await run(old, head, { altered: { "src/services/old.ts": `import "../ui/Page";` } })).toMatchObject({ state: "failure" });
    });

    it("needs no earlier code when the cycle is accepted as it is, or is new", async () => {
      expect(await run(whole, whole)).toMatchObject({ state: "success" });
      expect(tarballs).toEqual(["head"]);
      expect(await run(whole, whole, { commits: { m: { ...whole, ...flatRules() }, head: { ...whole, ...flatRules() } }, mergeBase: "m" })).toMatchObject({ state: "failure" });
      expect(tarballs).toEqual(["head"]);
    });
    const flatRules = (): Files => ({ ...r, "voxium/baseline.json": JSON.stringify({ violations: [] }) });
  });

  describe("warnings", () => {
    const code: Files = { "src/ui/Page.ts": `import "../services/s";`, "src/services/s.ts": `import "../data/d";`, "src/data/d.ts": "" };
    const own = prepareSetup(code).setupFiles;
    const naming = { id: "NAME01", type: "naming", module: "*", files: "src/**", style: "kebab", description: "d", rationale: "r", severity: "warn" };
    const r: Files = { [ARCH]: JSON.stringify({ ...JSON.parse(own[ARCH]), rules: [naming] }), "voxium/baseline.json": JSON.stringify({ violations: [] }) };
    let tarballs: string[];
    const run = async (head: Files, rules: Files = r, failAt?: string) => {
      tarballs = [];
      const onTarball = async (sha: string) => {
        tarballs.push(sha);
        if (sha === failAt) throw new Error("down");
      };
      github({ branches: { main: "m" }, commits: { m: { ...code, ...rules }, head: { ...head, ...rules } }, mergeBase: "m", onTarball });
      await runPullRequestCheck(ev);
      return (saved.at(-1) as any).summary;
    };

    it("are only those the pull request adds, judged against the code where it branched off", async () => {
      const added = await run({ ...code, "src/ui/NewPage.ts": "" });
      expect([added.warnings.map((v: any) => v.id), added.warningCount, added.state]).toEqual([["NAME01:src/ui/NewPage.ts"], 1, "success"]);
      // Files the pull request does not change are taken from its own commit, so nothing more is downloaded here.
      expect(tarballs).toEqual(["head"]);
      // src/ui/Page.ts breaks the rule where the pull request branched off already, so it is not listed.
      const edited = await run({ ...code, "src/data/d.ts": "export {};" });
      expect([edited.warnings, edited.warningCount, edited.state]).toEqual([[], 0, "success"]);
      expect(edited).not.toHaveProperty("needsBase");
      expect(tarballs).toEqual(["head", "m"]);
    });

    it("never change the status when the code where the pull request branched off cannot be read", async () => {
      const edited = { ...code, "src/data/d.ts": "export {};" };
      const none: Files = { ...r, [ARCH]: JSON.stringify({ ...JSON.parse(own[ARCH]), rules: [] }) };
      await run(edited, none, "m");
      expect(last()).toMatchObject({ state: "success", description: "No new violations." });
      // Only the head is downloaded without warnings.
      expect(tarballs).toEqual(["head"]);
      const summary = await run(edited, r, "m");
      expect(last()).toMatchObject({ state: "success", description: "No new violations." });
      expect(tarballs).toEqual(["head", "m"]);
      expect([summary.state, summary.warnings, summary.warningCount, summary.warningsUnknown]).toEqual(["success", [], 0, true]);
      expect(summary).not.toHaveProperty("pendingWarnings");
      // The status is published before the warnings are worked out.
      const order: string[] = [];
      github({
        branches: { main: "m" },
        commits: { m: { ...code, ...r }, head: { ...edited, ...r } },
        mergeBase: "m",
        onTarball: async (sha) => void order.push(`tarball ${sha}:${statuses.filter((x) => x.state !== "pending").length}`),
      });
      const before = statuses.filter((x) => x.state !== "pending").length;
      await runPullRequestCheck(ev);
      expect(order).toEqual([`tarball head:${before}`, `tarball m:${before + 1}`]);
    });

    it("that depend on paths which are not source code are judged with the paths where the pull request branched off", async () => {
      const opaque = { id: "OPQ", type: "no_opaque_imports", description: "d", rationale: "r", severity: "warn" };
      const withOpaque: Files = { ...r, [ARCH]: JSON.stringify({ ...JSON.parse(own[ARCH]), rules: [opaque] }) };
      const data: Files = {
        "src/data/a.cjs": `require("./x.txt");`,
        "src/data/b.cjs": `require("./node_modules/p");`,
        "src/data/x.txt": "x",
        "src/data/node_modules/p/package.json": "{}",
      };
      const base = { ...code, ...data };
      github({ branches: { main: "m" }, commits: { m: { ...base, ...withOpaque }, head: { ...base, "src/data/d.ts": "export {};", ...withOpaque } }, mergeBase: "m" });
      await runPullRequestCheck(ev);
      const summary = (saved.at(-1) as any).summary;
      expect([summary.state, summary.warnings, summary.warningCount]).toEqual(["success", [], 0]);
      // The same import added by the pull request is new.
      github({ branches: { main: "m" }, commits: { m: { ...base, ...withOpaque }, head: { ...base, "src/data/c.cjs": `require("./x.txt");`, ...withOpaque } }, mergeBase: "m" });
      await runPullRequestCheck(ev);
      expect((saved.at(-1) as any).summary.warnings.map((v: any) => v.id)).toEqual(["OPQ:src/data/c.cjs"]);
    });
  });

  describe("config files where the pull request branched off", () => {
    const layered = {
      version: 1,
      modules: { ui: { paths: ["apps/web/src/ui/**"] }, data: { paths: ["apps/web/src/data/**"] } },
      layers: ["data", "ui"],
      rules: [{ id: "LAYER01", type: "layers", description: "d", rationale: "r", severity: "block" }],
      exceptions: [],
    };
    const r: Files = { [ARCH]: JSON.stringify(layered), "voxium/baseline.json": JSON.stringify({ violations: [] }) };
    const base: Files = {
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@web/*": ["src/*"] } } }),
      "apps/web/src/data/db.ts": "",
      "apps/web/src/ui/page.ts": "",
      "apps/old/tsconfig.json": "{}",
    };
    const remapped: Files = {
      ...base,
      "apps/web/src/ui/page.ts": "import '@web/data/db';",
      "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@web/data/*": ["src/ui/stub/*"], "@web/*": ["src/*"] } } }),
      "apps/web/src/ui/stub/db.ts": "",
    };
    let tarballs: string[];
    const run = async (head: Files, over: Partial<World> = {}) => {
      tarballs = [];
      github({ branches: { main: "m" }, commits: { m: { ...base, ...r }, head: { ...head, ...r } }, mergeBase: "m", onTarball: async (sha) => void tarballs.push(sha), ...over });
      await runPullRequestCheck(ev);
      return last();
    };

    it("still count, so editing a tsconfig that is not the root one cannot drop an import", async () => {
      expect(await run(remapped)).toMatchObject({ state: "failure", description: expect.stringContaining("LAYER01 x1") });
      expect(tarballs).toEqual(["head", "m"]);
    });

    it("are only downloaded when the pull request changes one", async () => {
      expect(await run({ ...base, "apps/web/src/ui/page.ts": "import '@web/data/db';" })).toMatchObject({ state: "failure" });
      expect(tarballs).toEqual(["head"]);
      expect(await run(base)).toMatchObject({ state: "success" });
      expect(tarballs).toEqual(["head"]);
    });

    it("leave the check incomplete when they cannot be listed or read", async () => {
      const { "apps/old/tsconfig.json": _, ...removed } = base;
      expect(await run(removed)).toMatchObject({ state: "success" });
      expect(await run(removed, { truncatedAt: "m" })).toMatchObject({ state: "error" });
      expect(await run(removed, { altered: { "apps/old/tsconfig.json": "{ }" } })).toMatchObject({ state: "error" });
    });
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
