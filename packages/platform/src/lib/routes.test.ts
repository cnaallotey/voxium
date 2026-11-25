import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  user: { id: 1, github_id: 1, login: "ann" } as object | null,
  role: "team_leader" as string | null,
  level: "write" as string | null,
  standing: "member",
  down: false,
  tree: ["src/ui/a.ts", "src/data/d.ts"],
  cli: undefined as string | undefined,
};
const opened: Array<Record<string, string>> = [];
let body = "";
const repoStatus: string[] = [];
let memberships: object[] = [];

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
  getBranchSha: async () => "sha",
  listTree: async () => new Map(state.tree.map((p) => [p, "sha"])),
  getFileAtRef: async (_t: string, _r: string, p: string) => `# existing ${p}\n`,
  fetchTarball: async () => null,
  createSetupPr: async (_t: string, _r: string, _b: string, files: Record<string, string>, pr: { body: string }) => {
    opened.push(files);
    body = pr.body;
    return { url: "https://gh/pr/1", number: 1 };
  },
}));
vi.mock("@/lib/tar", () => ({ readTarGz: async () => ({ "src/ui/a.ts": `import "../data/d";`, "src/data/d.ts": "" }) }));
vi.mock("@/lib/store", () => ({
  getRepo: async () => ({ id: 5, org_id: 9, full_name: "acme/secret", default_branch: "main" }),
  getOrg: async () => ({ id: 9, installation_id: 3 }),
  getRole: async () => state.role,
  listAnalyses: async () => [],
  listDecisions: async () => [],
  saveAnalysis: async () => {},
  setRepoSetup: async (_db: unknown, _id: number, status: string) => void repoStatus.push(status),
  listOrgsForUser: async () => [],
  listReposForUser: async () => [],
  listMemberships: async () => memberships,
  audit: async () => {},
}));

const { POST } = await import("../app/api/repos/[id]/setup/route");
const { default: RepoPage } = await import("../app/repos/[id]/page");
const { default: Dashboard } = await import("../app/dashboard/page");
const params = { params: Promise.resolve({ id: "5" }) };
const page = { ...params, searchParams: Promise.resolve({}) };
const request = (origin: string | null = "https://vx.test") => ({ headers: new Headers(origin === null ? {} : { origin }) }) as never;
const setup = async (req = request()) => new URL((await POST(req, params)).headers.get("location")!);

beforeEach(() => {
  opened.length = 0;
  repoStatus.length = 0;
  memberships = [];
  Object.assign(state, { tree: ["src/ui/a.ts", "src/data/d.ts"], user: { id: 1, github_id: 1, login: "ann" }, role: "team_leader", level: "write", standing: "member", down: false, cli: undefined });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

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
  });

  it.each([
    ["not signed in", { user: null }],
    ["not in the organization", { role: null }],
    ["a member", { role: "member" }],
    ["a Team Leader who can only read the repo", { level: "read" }],
    ["a Team Leader with no access to the repo", { level: null }],
    ["a Team Leader who left the organization", { standing: "outside" }],
    ["a stored Owner who is no longer an admin", { role: "owner", standing: "member" }],
  ])("does nothing for someone who is %s", async (_n, change) => {
    Object.assign(state, change);
    await setup();
    expect(opened).toEqual([]);
  });

  it.each([null, "null", "https://evil.test", "http://vx.test", "https://vx.test:8443"])("ignores a form sent from %j", async (origin) => {
    await setup(request(origin));
    expect(opened).toEqual([]);
  });

  it("works with unreadable files that nothing imports, and lists them for review", async () => {
    state.tree.push(".yarn/releases/yarn-4.5.0.cjs", "public/huge.min.js");
    await setup();
    expect(JSON.parse(opened[0]["voxium/architecture.json"]).ignore).toEqual([".yarn/**", "public/huge.min.js"]);
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
    expect((await setup()).search).toContain("VOXIUM_CLI_PACKAGE");
    expect(opened).toHaveLength(1);
  });

  it("never replaces rules that are already there", async () => {
    state.tree.push("voxium/architecture.json");
    expect((await setup()).pathname).toBe("/repos/5");
    expect(opened).toEqual([]);
    expect(repoStatus).toEqual(["active"]);
  });

  it("keeps an existing CLAUDE.md that is missing from the archive", async () => {
    state.tree.push("CLAUDE.md");
    await setup();
    expect(opened[0]["CLAUDE.md"]).toContain("# existing CLAUDE.md");
  });

  it("does not reveal private repo names to people without access", async () => {
    state.level = null;
    expect((await setup()).search).not.toContain("secret");
    state.down = true;
    expect((await setup()).search).not.toContain("secret");
    state.role = null;
    expect((await setup()).search).not.toContain("secret");
  });
});

describe("dashboard", () => {
  it("says when access could not be read instead of asking to install the app again", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const page = async () => renderToStaticMarkup(await Dashboard({ searchParams: Promise.resolve({}) }));
    expect(await page()).toContain("Install the GitHub App");
    memberships = [{ org_id: 9, account_login: "acme", role: "member", state: "error" }];
    expect(await page()).toContain("could not read your access to acme");
    expect(await page()).not.toContain("Install the GitHub App");
  });
});
