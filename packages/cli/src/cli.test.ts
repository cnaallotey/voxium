import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASELINE = "voxium/baseline.json";
const ARCH = {
  version: 1,
  modules: { ui: { paths: ["src/ui/**"] }, data: { paths: ["src/data/**"] } },
  layers: ["ui", "data"],
  rules: [{ id: "LAYER01", type: "layers", description: "d", rationale: "r", severity: "block" }],
  exceptions: [],
};

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "voxium-cli-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true });
});

function write(files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
}

async function voxium(...args: string[]): Promise<{ code: unknown; out: string; err: string }> {
  const before = { argv: process.argv, exitCode: process.exitCode };
  const lines = { out: [] as string[], err: [] as string[] };
  const log = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.out.push(line));
  const error = vi.spyOn(console, "error").mockImplementation((line: string) => void lines.err.push(line));
  try {
    process.argv = ["node", "voxium", ...args, "--root", root];
    process.exitCode = undefined;
    vi.resetModules();
    await import("./cli.js");
    await vi.waitFor(() => expect(process.exitCode).toBeDefined());
    return { code: process.exitCode, out: lines.out.join("\n"), err: lines.err.join("\n") };
  } finally {
    Object.assign(process, before);
    log.mockRestore();
    error.mockRestore();
  }
}

const BROKEN = "import '../ui/page'; `";
const setup = (files: Record<string, string>) => write({ "voxium/architecture.json": JSON.stringify(ARCH), "src/ui/page.ts": "", ...files });

describe("check", () => {
  it("passes, fails and reports what it finds", async () => {
    setup({ "src/data/db.ts": "" });
    expect(await voxium("check")).toMatchObject({ code: 0, out: expect.stringContaining("PASSED") });
    write({ "src/data/db.ts": "import '../ui/page'" });
    expect(await voxium("check")).toMatchObject({ code: 1, out: expect.stringContaining("FAILED: 1 blocking") });
    expect(JSON.parse((await voxium("check", "--format", "json")).out)).toMatchObject({ violations: [{ ruleId: "LAYER01" }], unparsed: [] });
  });

  it("is not complete when a file cannot be read to its end, unless it is ignored", async () => {
    setup({ "src/data/db.ts": BROKEN });
    const { code, out } = await voxium("check");
    expect(code).toBe(2);
    expect(out).toContain("src/data/db.ts ends inside a template literal");
    expect(out).toContain("INCOMPLETE");
    expect(out).not.toContain("PASSED");
    const json = await voxium("check", "--format", "json");
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out).unparsed).toEqual([{ file: "src/data/db.ts", reason: "ends inside a template literal" }]);
    expect((await voxium("check", "--format", "github")).out).toContain("::error file=src/data/db.ts::");
    write({ "voxium/architecture.json": JSON.stringify({ ...ARCH, ignore: ["src/data/**"] }) });
    expect((await voxium("check")).code).toBe(0);
  });

  it("does not update the baseline then", async () => {
    setup({ "src/data/db.ts": BROKEN, "src/data/x.ts": "import '../ui/page'", [BASELINE]: "[]" });
    const { code, err } = await voxium("check", "--update-baseline");
    expect(code).toBe(2);
    expect(err).toContain("The baseline was not updated");
    expect(fs.readFileSync(path.join(root, BASELINE), "utf8")).toBe("[]");
    write({ "src/data/db.ts": "" });
    expect((await voxium("check", "--update-baseline")).code).toBe(0);
    expect(fs.readFileSync(path.join(root, BASELINE), "utf8")).toContain("LAYER01:src/data/x.ts->src/ui/page.ts");
  });

  it("lets no file name end a line or start a command of GitHub", async () => {
    setup({ "src/data/a\n::stop-commands::x.ts": BROKEN, "::group::x.ts": "`", "src/data/##[group]c.ts": "import '../ui/page'", "src/data/\u001b[2Jd.ts": "'" });
    for (const format of ["github", "text"]) {
      const { code, out } = await voxium("check", "--format", format);
      expect(code).toBe(2);
      expect(out).toContain("stop-commands");
      expect(out).not.toMatch(/[\u001b\r]/);
      const starts = out.split("\n").filter((line) => line.trimStart().startsWith("::"));
      if (format === "github") {
        expect(starts.every((line) => /^::error (?:file=[^:,\n]*(?:,line=\d+)?)::/.test(line))).toBe(true);
        expect(starts).toHaveLength(4);
        expect(out.split("\n").filter((line) => !line.startsWith("::error")).join("\n")).not.toMatch(/##\[|::/);
      } else expect(out).not.toMatch(/^::/m);
    }
  });
});

describe("import resolution", () => {
  const PACKAGES = { ...ARCH, modules: { ui: { paths: ["packages/ui/**"] }, data: { paths: ["packages/data/**"] } } };
  const workspace = (files: Record<string, string> = {}) =>
    write({
      "voxium/architecture.json": JSON.stringify(PACKAGES),
      "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", exports: { ".": "./dist/index.js" } }),
      "packages/ui/src/index.ts": "export {};",
      "packages/data/package.json": JSON.stringify({ name: "@acme/data" }),
      "packages/data/src/index.ts": "export {};",
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@ui/*": ["./packages/ui/src/*"] } } }),
      ...files,
    });

  it("follows workspace packages and tsconfig paths", async () => {
    workspace();
    expect((await voxium("check")).code).toBe(0);
    write({ "packages/data/src/index.ts": "import '@acme/ui';\nimport '@ui/index';" });
    const { code, out } = await voxium("check", "--format", "json");
    expect(code).toBe(1);
    expect(JSON.parse(out).violations.map((v: { id: string }) => v.id)).toEqual(["LAYER01:packages/data/src/index.ts->packages/ui/src/index.ts", "LAYER01:packages/data/src/index.ts->packages/ui/src/index.ts"]);
  });

  it("is not complete when the root tsconfig is broken or extends what cannot be read, unless it is ignored", async () => {
    workspace({ "tsconfig.json": "{ \"compilerOptions\": " });
    const broken = await voxium("check");
    expect(broken.code).toBe(2);
    expect(broken.out).toContain("tsconfig.json is not valid JSON");
    expect(broken.out).not.toContain("PASSED");
    // What is not in the tree at all is generated, as with SvelteKit or Nuxt, and is ignored.
    write({ "tsconfig.json": JSON.stringify({ extends: "./.svelte-kit/tsconfig.json" }) });
    expect((await voxium("check")).code).toBe(0);
    // A file of the tree that is not read, since only tsconfig*.json and jsconfig*.json are, is a gap.
    write({ "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base" }), "tsconfig.base": "{}" });
    const missing = await voxium("check", "--format", "json");
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.out).unparsed).toEqual([{ file: "tsconfig.json", reason: "extends a file that cannot be read" }]);
    write({ "voxium/architecture.json": JSON.stringify({ ...PACKAGES, ignore: ["tsconfig.json"] }) });
    expect((await voxium("check")).code).toBe(0);
  });

  it("keeps the aliases of the rules when a change removes the workspace", async () => {
    workspace({ "packages/data/src/index.ts": "import '@acme/ui';" });
    write({ "voxium/architecture.json": JSON.stringify({ ...PACKAGES, aliases: { "@acme/ui": ["packages/ui/src/index.ts"] } }), "package.json": "{}" });
    expect((await voxium("check")).code).toBe(1);
  });
});

describe("with rules from a git ref", () => {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdio: "ignore" });
  const commit = () => {
    git("add", "-A");
    git("commit", "-qm", "x");
  };

  it("still sees what a tsconfig that is not the root one mapped where the change started, whatever the change does to it", async () => {
    const arch = { ...ARCH, modules: { ui: { paths: ["apps/web/src/ui/**"] }, data: { paths: ["apps/web/src/data/**"] } }, layers: ["data", "ui"] };
    write({
      "voxium/architecture.json": JSON.stringify(arch),
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@web/*": ["src/*"] } } }),
      "apps/web/src/data/db.ts": "",
      "apps/web/src/ui/page.ts": "",
    });
    git("init", "-q", "-b", "main");
    commit();
    git("checkout", "-q", "-b", "change");
    write({
      "apps/web/src/ui/page.ts": "import '@web/data/db';",
      "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@web/data/*": ["src/ui/stub/*"], "@web/*": ["src/*"] } } }),
      "apps/web/src/ui/stub/db.ts": "",
    });
    const ids = async (...args: string[]) => {
      const res = await voxium("check", "--format", "json", ...args);
      return { code: res.code, ids: (JSON.parse(res.out).violations as Array<{ id: string }>).map((v) => v.id) };
    };
    const expected = { code: 1, ids: ["LAYER01:apps/web/src/ui/page.ts->apps/web/src/data/db.ts"] };
    expect(await ids("--rules-from", "main")).toEqual(expected);
    commit();
    expect(await ids("--rules-from", "main")).toEqual(expected);
    // Without git history to the ref, as in a shallow clone, the ref itself is where the change started.
    git("checkout", "-q", "--orphan", "lone", "main");
    git("commit", "-qm", "lone");
    git("checkout", "-q", "change");
    expect(await ids("--rules-from", "lone")).toEqual(expected);
  });

  it("judges what is left of an accepted cycle by the code before the change, with the aliases of the rules", async () => {
    const arch = {
      ...ARCH,
      modules: { ui: { paths: ["src/ui/**"] }, services: { paths: ["src/services/**"] }, data: { paths: ["src/data/**"] } },
      layers: [],
      rules: [{ id: "CYCLE01", type: "no_cycles", description: "d", rationale: "r", severity: "block" }],
      aliases: { "@u/*": ["src/ui/*"] },
    };
    write({
      "voxium/architecture.json": JSON.stringify(arch),
      "src/ui/Page.ts": `import "../services/s";`,
      "src/services/s.ts": `import "@u/Page"; import "../data/d";`,
      "src/data/d.ts": `import "../services/s";`,
    });
    const first = JSON.parse((await voxium("check", "--format", "json")).out).violations.map((v: { id: string }) => v.id);
    expect(first).toEqual(["CYCLE01:data+services+ui"]);
    write({ [BASELINE]: JSON.stringify({ violations: first }) });
    git("init", "-q", "-b", "main");
    commit();
    git("checkout", "-q", "-b", "change");
    write({ "src/data/d.ts": "" });
    // The smaller cycle that is left goes through the alias, which the code before the change had as well.
    expect((await voxium("check", "--rules-from", "main")).code).toBe(0);
  });
});

describe("init", () => {
  it("writes nothing when a file that it cannot leave out cannot be read", async () => {
    write({ "src/ui/page.ts": "import '../data/db'", "src/data/db.ts": "import './gen/a'", "src/data/gen/a.ts": "`" });
    const res = await voxium("init");
    expect(res.code).toBe(2);
    expect(res.err).toContain("Nothing written");
    expect(fs.existsSync(path.join(root, "voxium"))).toBe(false);
    write({ "src/data/gen/a.ts": "" });
    expect((await voxium("init")).code).toBe(0);
    expect(fs.existsSync(path.join(root, "voxium/architecture.json"))).toBe(true);
  });

  it("starts from a template, with the baseline of the code as it is", async () => {
    write({ "src/controllers/user.ts": "import '../repositories/user'", "src/repositories/user.ts": "import '../controllers/user'", "src/utils/id.ts": "" });
    const res = await voxium("init", "--template", "layered");
    expect(res).toMatchObject({ code: 0, out: expect.stringContaining("from the layered template") });
    expect(res.out).toContain("2 existing blocking violation(s) recorded as baseline.");
    expect(res.out).not.toContain("Layer order");
    const arch = JSON.parse(fs.readFileSync(path.join(root, "voxium/architecture.json"), "utf8"));
    expect(arch.layers).toEqual(["presentation", "infrastructure", "shared"]);
    const baseline = JSON.parse(fs.readFileSync(path.join(root, BASELINE), "utf8"));
    expect(JSON.stringify(baseline)).toContain("LAYER01:src/repositories/user.ts->src/controllers/user.ts");
    expect((await voxium("check")).code).toBe(0);
  });

  it("refuses an unknown template, and one that matches no folder, writing nothing", async () => {
    write({ "src/odd/a.ts": "" });
    expect(await voxium("init", "--template", "mvc")).toMatchObject({ code: 2, err: expect.stringContaining("--template needs one of: layered, hexagonal") });
    const res = await voxium("init", "--template", "hexagonal");
    expect(res).toMatchObject({ code: 1, err: expect.stringContaining("No folder matches the hexagonal template") });
    expect(fs.existsSync(path.join(root, "voxium"))).toBe(false);
  });

  it("names the framework package.json uses when inferring", async () => {
    write({ "src/ui/a.ts": "import '../data/b'", "src/data/b.ts": "", "package.json": JSON.stringify({ dependencies: { next: "14.2.0" } }) });
    const res = await voxium("infer");
    expect(res.err).toContain("Note: package.json uses next. A template fits it: next.");
    expect(res.err).toMatch(/module ui: \d+%\. 1 source file\(s\) match src\/ui\/\*\*\./);
  });
});

describe("propose", () => {
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const text = ["--title", "Split billing", "--summary", "Move billing out", "--rationale", "It grew too large"];

  it("saves a pending proposal with an architecture, and never replaces one", async () => {
    setup({});
    const file = path.join(root, "next.json");
    fs.writeFileSync(file, JSON.stringify({ ...ARCH, layers: ["data", "ui"] }));
    const first = await voxium("propose", ...text, "--architecture", file, "--accept-debt");
    expect(first.code).toBe(0);
    const [name] = fs.readdirSync(path.join(root, "voxium/proposals"));
    expect(first.out).toContain(`voxium/proposals/${name}`);
    expect(read(`voxium/proposals/${name}`)).toMatchObject({
      status: "pending_approval", approvedBy: null, requestedBy: "cli", title: "Split billing", change: { architecture: { layers: ["data", "ui"] }, acceptDebt: true },
    });
    expect((await voxium("propose", ...text)).code).toBe(0);
    expect(fs.readdirSync(path.join(root, "voxium/proposals")).sort()).toEqual([name, name.replace(".json", "_2.json")].sort());
  });

  it("writes nothing for an invalid proposal", async () => {
    setup({});
    const file = path.join(root, "next.json");
    fs.writeFileSync(file, JSON.stringify({ ...ARCH, layers: ["nope"] }));
    for (const args of [[...text, "--architecture", file], [...text, "--architecture", path.join(root, "missing.json")], text.slice(0, 4), ["--title"]]) {
      const res = await voxium("propose", ...args);
      expect(res.code).toBe(2);
      expect(res.err).toMatch(/voxium: /);
    }
    expect(fs.existsSync(path.join(root, "voxium/proposals"))).toBe(false);
  });
});

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString();
const ids = (out: string) => (JSON.parse(out).violations as Array<{ id: string }>).map((v) => v.id);

describe("generated files", () => {
  const CLI = "voxium@1.2.3";

  it("are the files the platform writes for the same rules", async () => {
    setup({ "CLAUDE.md": "# Mine\n", [BASELINE]: JSON.stringify({ violations: ["X"] }) });
    expect((await voxium("generate", "--cli-package", CLI, "--with-tests")).code).toBe(0);
    const { buildSetupFiles } = await import("@voxium/core");
    const expected = buildSetupFiles({ arch: ARCH as never, baseline: ["X"], cliPackage: CLI, withTests: true, existing: { "CLAUDE.md": "# Mine\n" } });
    const written = Object.keys(expected).filter((p) => p !== "voxium/architecture.json" && p !== BASELINE);
    expect(written.sort()).toEqual([".cursor/rules/voxium.mdc", ".github/workflows/voxium.yml", ".mcp.json", "AGENTS.md", "CLAUDE.md", "voxium/CODEOWNERS.suggested", "voxium/dependency-cruiser.json", "voxium/gitlab-ci.yml", "voxium/hooks/pre-commit"]);
    for (const p of written) expect(fs.readFileSync(path.join(root, p), "utf8"), p).toBe(expected[p]);
  });

  it("keep the pinned version, the dependency-cruiser rules once there, and owners written into CODEOWNERS.suggested", async () => {
    setup({});
    await voxium("init", "--force", "--cli-package", CLI, "--with-tests");
    fs.rmSync(path.join(root, ".github"), { recursive: true });
    write({ "voxium/CODEOWNERS.suggested": "/voxium/ @lead\n", "voxium/dependency-cruiser.json": "{}" });
    const res = await voxium("generate");
    expect(res.code).toBe(0);
    expect(res.out).not.toContain("CODEOWNERS");
    expect(fs.readFileSync(path.join(root, "voxium/CODEOWNERS.suggested"), "utf8")).toBe("/voxium/ @lead\n");
    expect(fs.readFileSync(path.join(root, "voxium/dependency-cruiser.json"), "utf8")).toContain('"forbidden"');
    // The GitLab job pins the version when there is no workflow.
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toContain(`npx --yes ${CLI} check`);
  });

  it("are never written outside the project through a symlink", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "voxium-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.md"), "keep\n");
      for (const link of [
        { from: "CLAUDE.md", to: path.join(outside, "secret.md") },
        { from: ".cursor", to: outside },
        { from: "AGENTS.md", to: path.join(outside, "missing.md") },
      ]) {
        setup({});
        fs.symlinkSync(link.to, path.join(root, link.from));
        const res = await voxium("generate");
        expect(res).toMatchObject({ code: 2, err: expect.stringContaining("leads outside the project") });
        expect(fs.readdirSync(outside)).toEqual(["secret.md"]);
        expect(fs.readFileSync(path.join(outside, "secret.md"), "utf8")).toBe("keep\n");
        fs.rmSync(root, { recursive: true });
        fs.mkdirSync(root);
      }
      // A link within the project, such as CLAUDE.md to AGENTS.md, is fine.
      setup({ "AGENTS.md": "# Shared\n" });
      fs.symlinkSync("AGENTS.md", path.join(root, "CLAUDE.md"));
      expect((await voxium("generate")).code).toBe(0);
      expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("<!-- voxium:start -->");
    } finally {
      fs.rmSync(outside, { recursive: true });
    }
  });
});

describe("check --staged", () => {
  const git = (...args: string[]) => gitIn(root, ...args);
  const staged = async () => {
    const res = await voxium("check", "--staged", "--format", "json");
    return { code: res.code, ids: ids(res.out), err: res.err };
  };
  const committed = () => {
    setup({ "src/data/db.ts": "", "src/ui/x.ts": "import './page'" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "x");
  };

  it("checks what is staged, whatever the work tree has since", async () => {
    committed();
    write({ "src/data/db.ts": "import '../ui/page'" });
    git("add", "src/data/db.ts");
    write({ "src/data/db.ts": "" }); // fixed, but not staged
    expect(await staged()).toMatchObject({ code: 1, ids: ["LAYER01:src/data/db.ts->src/ui/page.ts"] });
    expect((await voxium("check")).code).toBe(0);
    git("add", "src/data/db.ts");
    write({ "src/data/db.ts": "import '../ui/page'", "src/data/new.ts": "import '../ui/page'" }); // broken, but not staged
    expect(await staged()).toMatchObject({ code: 0, ids: [] });
    expect((await voxium("check")).code).toBe(1);
  });

  it("judges by the rules and baseline of HEAD, so staging weaker ones does not help", async () => {
    committed();
    write({ "src/data/db.ts": "import '../ui/page'", "voxium/architecture.json": JSON.stringify({ ...ARCH, rules: [] }), [BASELINE]: JSON.stringify({ violations: ["LAYER01:src/data/db.ts->src/ui/page.ts"] }) });
    git("add", "-A");
    const res = await staged();
    expect(res).toMatchObject({ code: 1, ids: ["LAYER01:src/data/db.ts->src/ui/page.ts"] });
    expect(res.err).toContain("voxium/architecture.json, voxium/baseline.json changed. The rules from HEAD still apply here.");
  });

  it("works before the first commit, by the staged rules", async () => {
    setup({ "src/data/db.ts": "" });
    git("init", "-q");
    git("add", "-A");
    expect(await staged()).toMatchObject({ code: 0, ids: [] });
    write({ "src/data/db.ts": "import '../ui/page'" });
    git("add", "-A");
    expect(await staged()).toMatchObject({ code: 1, ids: ["LAYER01:src/data/db.ts->src/ui/page.ts"] });
    git("rm", "-q", "--cached", "voxium/architecture.json");
    expect((await voxium("check", "--staged")).code).toBe(1);
  });

  it("follows renames, and file names git has to quote", async () => {
    committed();
    git("mv", "src/ui/x.ts", "src/data/x.ts");
    write({ "src/data/x.ts": "import '../ui/page'" });
    git("add", "src/data/x.ts");
    write({ "src/data/x.ts": "" });
    // Leading dash, quotes, a space and a letter git quotes unless it is asked for NUL-separated names. A name with a line
    // break is outside every module, since no glob lets "**" cross one.
    const odd = "src/data/-n '\"q ü.ts";
    write({ [odd]: "import '../ui/page'" });
    git("add", "--", odd);
    expect(await staged()).toMatchObject({ code: 1, ids: [`LAYER01:${odd}->src/ui/page.ts`, "LAYER01:src/data/x.ts->src/ui/page.ts"] });
  });

  it("runs no fsmonitor command the repository's config names", async () => {
    committed();
    const marker = path.join(root, "ran");
    write({ "fsmonitor.sh": `#!/bin/sh\ntouch '${marker}'\n` });
    fs.chmodSync(path.join(root, "fsmonitor.sh"), 0o755);
    git("config", "core.fsmonitor", path.join(root, "fsmonitor.sh"));
    expect((await voxium("check", "--staged")).code).toBe(0);
    expect((await voxium("check", "--changed", "HEAD")).code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("cannot be combined with another way to pick the rules", async () => {
    committed();
    expect(await voxium("check", "--staged", "--rules-from", "main")).toMatchObject({ code: 2, err: expect.stringContaining("cannot be combined") });
    expect((await voxium("check", "--changed", "main", "--update-baseline")).code).toBe(2);
  });
});

describe("check --changed", () => {
  it("shows only violations in changed files and in the files that import them", async () => {
    // old.ts has nothing to do with the change; imp.ts imports the file that changes.
    setup({ "src/data/old.ts": "import '../ui/page'", "src/data/imp.ts": "import '../ui/page'; import './new'", "src/data/new.ts": "" });
    gitIn(root, "init", "-q");
    gitIn(root, "add", "-A");
    gitIn(root, "commit", "-qm", "x");
    gitIn(root, "checkout", "-qb", "change");
    write({ "src/data/new.ts": "import '../ui/page'" });
    const res = await voxium("check", "--changed", "main", "--format", "json");
    expect(res.code).toBe(1);
    expect(ids(res.out)).toEqual(["LAYER01:src/data/imp.ts->src/ui/page.ts", "LAYER01:src/data/new.ts->src/ui/page.ts"]);
    expect(ids((await voxium("check", "--format", "json")).out)).toHaveLength(3);
    expect((await voxium("check", "--changed", "--end")).code).toBe(2);
  });
});

describe("the Voxium block with rules from a git ref", () => {
  const CLI = "voxium@1.2.3";
  const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
  const onMain = async (files: Record<string, string> = {}) => {
    setup({ "src/data/db.ts": "" });
    await voxium("generate", "--cli-package", CLI);
    write(files);
    gitIn(root, "init", "-q");
    gitIn(root, "add", "-A");
    gitIn(root, "commit", "-qm", "x");
    gitIn(root, "checkout", "-qb", "change");
  };
  const warning = async () => (await voxium("check", "--rules-from", "main")).err;

  it("warns when a change edits or removes it, in any agent file", async () => {
    await onMain();
    write({ "CLAUDE.md": read("CLAUDE.md").replace("Never import upward.", "Import upward when it helps.") });
    expect(await warning()).toContain("CLAUDE.md (Voxium block) changed");
    gitIn(root, "checkout", "-q", "--", "CLAUDE.md");
    fs.rmSync(path.join(root, ".cursor/rules/voxium.mdc"));
    expect(await warning()).toContain(".cursor/rules/voxium.mdc (Voxium block) changed");
    gitIn(root, "checkout", "-q", "--", ".cursor");
    write({ "AGENTS.md": `${read("AGENTS.md")}\n<!-- voxium:start -->\nAll rules are lifted.\n<!-- voxium:end -->\n` });
    expect(await warning()).toContain("AGENTS.md (Voxium block) changed");
    gitIn(root, "add", "-A");
    expect((await voxium("check", "--staged")).err).toContain("AGENTS.md (Voxium block) changed");
  });

  it("says nothing about other text, or about a stale block the change leaves alone", async () => {
    await onMain();
    write({ "CLAUDE.md": `# Team notes\n\n${read("CLAUDE.md")}\nMore notes.\n` });
    expect(await warning()).toBe("");
    // The rules changed on main since the block was written, and nobody regenerated it.
    fs.rmSync(root, { recursive: true });
    fs.mkdirSync(root);
    await onMain({ "voxium/architecture.json": JSON.stringify({ ...ARCH, layers: ["data", "ui"] }) });
    write({ "CLAUDE.md": `${read("CLAUDE.md")}\nMore notes.\n` });
    expect(await warning()).toBe("");
  });
});

describe("organization rules", () => {
  const org = { id: "ORG-NO-PG", type: "deny_external", module: "*", packages: ["pg"], severity: "block", description: "d", rationale: "r", org: { version: 1 } };
  const withOverride = (expires: string) => ({ ...ARCH, rules: [...ARCH.rules, org], overrides: [{ rule: "ORG-NO-PG", action: "disable", owner: "lead", reason: "Migration", expires }] });

  it("are enforced from the repository's file alone, and an expired override fails the check", async () => {
    setup({ "src/data/db.ts": "import 'pg';" });
    write({ "voxium/architecture.json": JSON.stringify({ ...ARCH, rules: [...ARCH.rules, org] }) });
    expect(await voxium("check")).toMatchObject({ code: 1, out: expect.stringContaining("ORG-NO-PG") });
    write({ "voxium/architecture.json": JSON.stringify(withOverride("2999-01-01")) });
    expect((await voxium("check")).code).toBe(0);
    write({ "voxium/architecture.json": JSON.stringify(withOverride("2020-01-01")) });
    const expired = await voxium("check");
    expect(expired).toMatchObject({ code: 1, out: expect.stringContaining("Expired overrides, whose rules are enforced again: 1") });
    expect((await voxium("check", "--format", "github")).out).toContain("::error::Expired override of ORG-NO-PG (owner lead).");
  }, 30_000);
});

describe("a source file that is a symlink out of the project", () => {
  it("is code that could not be read, in the work tree and as staged, and a link inside the project is read", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "voxium-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "x.ts"), "import '../ui/page';");
      setup({ "src/data/db.ts": "" });
      fs.symlinkSync(path.join(outside, "x.ts"), path.join(root, "src/data/evil.ts"));
      gitIn(root, "init", "-q");
      gitIn(root, "add", "-A");
      gitIn(root, "commit", "-qm", "x");
      for (const args of [["check"], ["check", "--staged"]]) {
        const res = await voxium(...args);
        expect(res, args.join(" ")).toMatchObject({ code: 2, out: expect.stringContaining("src/data/evil.ts is a symlink that leads outside the project") });
      }
      fs.rmSync(path.join(root, "src/data/evil.ts"));
      fs.symlinkSync("db.ts", path.join(root, "src/data/evil.ts"));
      expect((await voxium("check")).code).toBe(0);
    } finally {
      fs.rmSync(outside, { recursive: true });
    }
  }, 30_000);
});
