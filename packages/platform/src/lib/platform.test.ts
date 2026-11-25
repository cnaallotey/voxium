import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractImports } from "@voxium/core";
import { checkPullRequest, prepareSetup, wantFile, type PrCheckInput } from "./analysis";
import { hmacSha256Hex, safeEqual, verifyWebhookSignature } from "./crypto";
import { createAppJwt, createSetupPr, pkcs1ToPkcs8 } from "./github";
import { createSessionToken, readSessionToken } from "./session";
import { readTarGz } from "./tar";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vx-plat-"));
}

function stream(file: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
}

const longDir = "a".repeat(60) + "/" + "b".repeat(60) + "/" + "c".repeat(40);

function seedRepo(dir: string) {
  const files: Record<string, string> = {
    "src/ui/Page.ts": `import { s } from "../services/s";\nexport const p = s;\n`,
    "src/services/s.ts": `import { d } from "../data/d";\nexport const s = d;\n`,
    "src/data/d.ts": `export const d = 1;\n`,
    "README.md": "# not wanted\n",
    "image.bin": "x".repeat(2000),
    [`src/shared/${longDir}/deep.ts`]: `export const deep = "héllo wörld ✓";\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return files;
}

describe("tar reader", () => {
  const want = (p: string) => p.endsWith(".ts");

  it("reads a git archive tarball (pax headers) and strips the top folder", () => {
    const dir = tmp();
    seedRepo(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: dir });
    const out = path.join(tmp(), "repo.tar.gz");
    execFileSync("git", ["archive", "--format=tar.gz", "--prefix=owner-repo-abc123/", "-o", out, "HEAD"], { cwd: dir });
    return readTarGz(stream(out), { want }).then((files) => {
      expect(Object.keys(files).sort()).toEqual([
        "src/data/d.ts",
        `src/shared/${longDir}/deep.ts`,
        "src/services/s.ts",
        "src/ui/Page.ts",
      ].sort());
      expect(files[`src/shared/${longDir}/deep.ts`]).toContain("héllo wörld ✓");
    });
  });

  // Packs <parent>/repo-sha. GNU tar and macOS bsdtar differ in flags and in the name of the GNU format.
  const bsd = execFileSync("tar", ["--version"]).toString().includes("bsdtar");
  function pack(parent: string, out: string, format?: string) {
    const name = format === "gnu" && bsd ? "gnutar" : format;
    execFileSync("tar", [...(name ? [`--format=${name}`] : []), "-czf", out, "-C", parent, "repo-sha"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
  }

  it.each(["gnu", "ustar", "pax"])("reads %s format tarballs including long paths", async (format) => {
    const parent = tmp();
    seedRepo(path.join(parent, "repo-sha"));
    const out = path.join(tmp(), `repo-${format}.tar.gz`);
    pack(parent, out, format);
    const files = await readTarGz(stream(out), { want });
    expect(files["src/ui/Page.ts"]).toContain("services/s");
    expect(files[`src/shared/${longDir}/deep.ts`]).toContain("deep");
    expect(files["README.md"]).toBeUndefined();
  });

  it("skips files over the size limit and respects the keep budget", async () => {
    const parent = tmp();
    const dir = path.join(parent, "repo-sha");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/big.ts"), "x".repeat(5000));
    fs.writeFileSync(path.join(dir, "src/small.ts"), "ok");
    const out = path.join(tmp(), "r.tar.gz");
    pack(parent, out);
    const files = await readTarGz(stream(out), { want, maxFileBytes: 1000 });
    expect(Object.keys(files)).toEqual(["src/small.ts"]);
  });
});

describe("tar paths", () => {
  it("reads long non ASCII paths from pax headers exactly", async () => {
    const dir = tmp();
    const rel = `src/${"é".repeat(40)}/${"ü".repeat(40)}/a.ts`;
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "export {};\n");
    execFileSync("git", ["-c", "core.precomposeunicode=false", "init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: dir });
    const out = path.join(tmp(), "u.tar.gz");
    execFileSync("git", ["archive", "--format=tar.gz", "--prefix=o-r-abc/", "-o", out, "HEAD"], { cwd: dir });
    const files = await readTarGz(stream(out), { want: (p) => p.endsWith(".ts") });
    expect(Object.keys(files).map((k) => k.normalize("NFC"))).toEqual([rel.normalize("NFC")]);
  });
});

describe("archives that differ from the commit", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...args], { cwd });

  /** Commit these files, archive them as GitHub does, and read the archive against the commit's own hashes. */
  async function archived(files: Record<string, string>) {
    const dir = tmp();
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), c);
    }
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "x");
    const tree = new Map(
      git(dir, "ls-tree", "-r", "HEAD").toString().trim().split("\n").map((l) => [l.split("\t")[1], l.split(/\s/)[2]] as const),
    );
    const out = path.join(tmp(), "a.tar.gz");
    git(dir, "archive", "--format=tar.gz", "--prefix=o-r-sha/", "-o", out, "HEAD");
    const want = (p: string) => p.endsWith(".ts");
    return { unverified: await readTarGz(stream(out), { want }), files: await readTarGz(stream(out), { want, expect: tree }) };
  }

  it("drops a file that export-subst rewrote to hide an import", async () => {
    const { unverified, files } = await archived({
      ".gitattributes": "*.ts export-subst\n",
      "src/d.ts": `const s = '$Format:%x27;/*$'; import "../ui/Page";\n`,
      "src/ok.ts": "export {};\n",
    });
    expect(extractImports(unverified["src/d.ts"])).toEqual([]); // the attack works on the raw archive
    expect(Object.keys(files)).toEqual(["src/ok.ts"]);
  });

  it("drops a file that was re-encoded", async () => {
    const { files } = await archived({ ".gitattributes": "src/d.ts working-tree-encoding=UTF-16LE\n", "src/ok.ts": "export {};\n", "src/d.ts": "a\u0000\n\u0000" });
    expect(Object.keys(files)).toEqual(["src/ok.ts"]);
  });

  it("restores line endings the archive converted", async () => {
    const { unverified, files } = await archived({ ".gitattributes": "*.ts text eol=crlf\n", "src/ok.ts": "a\nb\n" });
    expect(unverified["src/ok.ts"]).toBe("a\r\nb\r\n");
    expect(files["src/ok.ts"]).toBe("a\nb\n");
  });
});

describe("webhook signature", () => {
  it("accepts a correct signature and rejects wrong, missing or malformed ones", async () => {
    const body = JSON.stringify({ hello: "world" });
    const good = `sha256=${crypto.createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(await verifyWebhookSignature("s3cret", body, good)).toBe(true);
    expect(await verifyWebhookSignature("other", body, good)).toBe(false);
    expect(await verifyWebhookSignature("s3cret", body + " ", good)).toBe(false);
    expect(await verifyWebhookSignature("s3cret", body, null)).toBe(false);
    expect(await verifyWebhookSignature("s3cret", body, "sha1=abc")).toBe(false);
    expect(await verifyWebhookSignature("", body, good)).toBe(false);
    expect(safeEqual("a", "ab")).toBe(false);
    expect(await hmacSha256Hex("k", "d")).toBe(crypto.createHmac("sha256", "k").update("d").digest("hex"));
  });
});

describe("session cookie", () => {
  it("round trips, expires and rejects tampering", async () => {
    const t = await createSessionToken("secret", { uid: 7, login: "charles" }, 1_000_000);
    expect((await readSessionToken("secret", t, 1_000_000))?.uid).toBe(7);
    expect(await readSessionToken("other", t, 1_000_000)).toBeNull();
    expect(await readSessionToken("secret", t, 1_000_000 + 15 * 24 * 3600 * 1000)).toBeNull();
    const [payload, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: 1, login: "admin", exp: 9_999_999_999 })).toString("base64url");
    expect(await readSessionToken("secret", `${forged}.${sig}`, 1_000_000)).toBeNull();
    expect(await readSessionToken("secret", payload, 1_000_000)).toBeNull();
    expect(await readSessionToken("secret", undefined)).toBeNull();
  });
});

describe("GitHub App JWT", () => {
  it("signs with a PKCS1 key (as GitHub issues) and a PKCS8 key, verifiable with the public key", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const type of ["pkcs1", "pkcs8"] as const) {
      const pem = privateKey.export({ type, format: "pem" }).toString();
      const jwt = await createAppJwt("12345", pem.replace(/\n/g, "\\n"), 1_700_000_000_000);
      const [h, b, s] = jwt.split(".");
      expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
      const claims = JSON.parse(Buffer.from(b, "base64url").toString());
      expect(claims.iss).toBe("12345");
      expect(claims.exp - claims.iat).toBe(540);
      const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, "base64url"));
      expect(ok).toBe(true);
    }
  });

  it("wraps PKCS1 into valid PKCS8", () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: "pkcs1", format: "der" });
    const wrapped = Buffer.from(pkcs1ToPkcs8(new Uint8Array(pkcs1)));
    expect(wrapped.equals(privateKey.export({ type: "pkcs8", format: "der" }))).toBe(true);
  });
});

const goodFiles = {
  "src/ui/Page.ts": `import "../services/s";`,
  "src/services/s.ts": `import "../data/d";`,
  "src/data/d.ts": `export {};`,
};

const ARCH = "voxium/architecture.json";
const BASELINE = "voxium/baseline.json";

/** A PR against a base branch holding these rules. Head defaults to leaving them untouched. */
function check(
  headFiles: Record<string, string>,
  rules: Record<string, string | null>,
  over: Partial<PrCheckInput> & { headRules?: Record<string, string | null> } = {},
) {
  const { headRules, ...rest } = over;
  return checkPullRequest({
    headFiles,
    treePaths: Object.keys(headFiles),
    base: rules,
    mergeBase: rules,
    head: { ...rules, ...headRules },
    ...rest,
  });
}

function rulesFor(files: Record<string, string>) {
  const plan = prepareSetup(files);
  return { [ARCH]: plan.setupFiles[ARCH], [BASELINE]: plan.setupFiles[BASELINE] };
}

describe("analysis", () => {
  it("prepares a setup plan whose files are consistent and baseline starts green", () => {
    const plan = prepareSetup({ ...goodFiles, "CLAUDE.md": "# Mine\n" });
    expect(plan.summary.layers).toEqual(["ui", "services", "data"]);
    expect(Object.keys(plan.setupFiles).sort()).toEqual(
      ["AGENTS.md", "CLAUDE.md", "voxium/CODEOWNERS.suggested", "voxium/architecture.json", "voxium/baseline.json"].sort(),
    );
    const pinned = prepareSetup(goodFiles, undefined, "voxium@1.2.3").setupFiles;
    expect(pinned[".github/workflows/voxium.yml"]).toContain("voxium@1.2.3 check");
    expect(pinned[".mcp.json"]).toContain("voxium@1.2.3");
    expect(plan.setupFiles["CLAUDE.md"]).toContain("# Mine");
    expect(check(goodFiles, rulesFor(goodFiles)).state).toBe("success");
  });

  it("wantFile keeps source and agent files only", () => {
    expect(wantFile("src/a.ts")).toBe(true);
    expect(wantFile("CLAUDE.md")).toBe(true);
    expect(wantFile("README.md")).toBe(false);
    expect(wantFile("node_modules/x/index.js")).toBe(false);
  });

  it("fails a PR with a new violation and uses the BASE rules, not the PR's edited rules", () => {
    const rules = rulesFor(goodFiles);
    const bad = { ...goodFiles, "src/data/d.ts": `import "../ui/Page";` };
    // The PR also deletes the rules to try to pass.
    const weakened = JSON.stringify({ ...JSON.parse(rules[ARCH]), rules: [] });
    const res = check(bad, rules, { headRules: { [ARCH]: weakened } });
    expect(res.state).toBe("failure");
    expect(res.protectedChanges).toEqual([ARCH]);
    expect(res.description).toMatch(/Team Leader/);
    expect(res.newViolations.map((v) => v.ruleId).sort()).toEqual(["CYCLE01", "LAYER01"]);
  });

  it("skips repos that are not set up and errors on a broken architecture file", () => {
    expect(check(goodFiles, {})).toMatchObject({ state: "success", skipped: true });
    expect(check(goodFiles, { [ARCH]: "{not json" }).state).toBe("error");
    expect(check(goodFiles, { [ARCH]: JSON.stringify({ version: 1 }) }).state).toBe("error");
  });

  it("does not fail on baseline debt but fails on expired exceptions", () => {
    const dirty = { ...goodFiles, "src/data/d.ts": `import "../services/s";` };
    const rules = rulesFor(dirty);
    expect(JSON.parse(rules[BASELINE]).violations.length).toBeGreaterThan(0);
    expect(check(dirty, rules).state).toBe("success");

    const withEx = JSON.stringify({
      ...JSON.parse(rules[ARCH]),
      exceptions: [{ rule: "LAYER01", file: "src/data/**", owner: "t", reason: "r", expires: "2020-01-01" }],
    });
    const res = check(dirty, { ...rules, [ARCH]: withEx }, { today: new Date("2026-11-24") });
    expect(res.state).toBe("failure");
    expect(res.description).toMatch(/expired/);
  });
});

describe("protected files", () => {
  const rules = rulesFor(goodFiles);
  const weak = JSON.stringify({ ...JSON.parse(rules[ARCH]), rules: [] });
  const bad = { ...goodFiles, "src/data/d.ts": `import "../ui/Page";` };

  it.each([
    ["deletes the architecture", { [ARCH]: null }],
    ["weakens the architecture", { [ARCH]: weak }],
    ["adds accepted debt to the baseline", { [BASELINE]: JSON.stringify({ violations: ["LAYER01:src/data/d.ts->src/ui/Page.ts"] }) }],
    ["breaks the baseline file", { [BASELINE]: "{" }],
    ["adds its own workflow content", { ".github/workflows/voxium.yml": "on: push" }],
  ])("a PR that %s fails even with clean code", (_name, headRules) => {
    const res = check(goodFiles, rules, { headRules });
    expect(res.state).toBe("failure");
    expect(res.description).toMatch(/needs Team Leader approval/);
  });

  it("an approved change is judged by the approved rules", () => {
    expect(check(bad, rules, { headRules: { [ARCH]: weak }, approvedBy: "lead" })).toMatchObject({ state: "success", approvedBy: "lead" });
    expect(check(goodFiles, rules, { headRules: { [ARCH]: null }, approvedBy: "lead" }).state).toBe("success");
    // Tightening counts too: the approved rules catch what the old ones allowed.
    expect(check(bad, { ...rules, [ARCH]: weak }, { headRules: { [ARCH]: rules[ARCH] }, approvedBy: "lead" }).state).toBe("failure");
  });

  it("approval cannot merge invalid rules, and does nothing for PRs that only break rules", () => {
    expect(check(goodFiles, rules, { headRules: { [ARCH]: "{" }, approvedBy: "lead" }).state).toBe("failure");
    expect(check(bad, rules, { approvedBy: "lead" })).toMatchObject({ state: "failure", approvedBy: null });
  });

  it("approval can repair a broken base and renew an expired exception", () => {
    expect(check(goodFiles, { ...rules, [ARCH]: "{" }, { headRules: { [ARCH]: rules[ARCH] }, approvedBy: "lead" }).state).toBe("success");
    const ex = (expires: string) =>
      JSON.stringify({ ...JSON.parse(rules[ARCH]), exceptions: [{ rule: "LAYER01", file: "x", owner: "o", reason: "r", expires }] });
    const today = new Date("2026-11-24");
    expect(check(goodFiles, { ...rules, [ARCH]: ex("2026-01-01") }, { today }).state).toBe("failure");
    const renewed = { headRules: { [ARCH]: ex("2027-01-01") }, approvedBy: "lead", today };
    expect(check(goodFiles, { ...rules, [ARCH]: ex("2026-01-01") }, renewed).state).toBe("success");
  });

  it("does not accept an approval when the base rules changed since the PR branched", () => {
    const newer = JSON.stringify({ ...JSON.parse(rules[ARCH]), ignore: ["x/**"] }); // anything the PR has not seen
    for (const headRules of [{ [ARCH]: weak }, { [ARCH]: null }]) {
      const res = checkPullRequest({
        headFiles: bad,
        treePaths: Object.keys(bad),
        base: { ...rules, [ARCH]: newer },
        mergeBase: rules,
        head: { ...rules, ...headRules },
        approvedBy: "lead",
      });
      expect(res.state).toBe("failure");
      expect(res.description).toMatch(/Update the branch/);
    }
  });

  it("does not blame a branch that is merely behind", () => {
    const res = checkPullRequest({
      headFiles: goodFiles,
      treePaths: Object.keys(goodFiles),
      base: rules,
      mergeBase: { ...rules, [ARCH]: weak },
      head: { ...rules, [ARCH]: weak },
    });
    expect(res).toMatchObject({ state: "success", protectedChanges: [] });
  });

  it("lets a PR pay down debt without approval, but not drop debt that is still there", () => {
    const dirty = { ...goodFiles, "src/data/d.ts": `import "../services/s";` };
    const debt = {
      ...rules,
      [BASELINE]: JSON.stringify({ violations: ["LAYER01:src/data/d.ts->src/services/s.ts", "CYCLE01:data+services"] }),
    };
    expect(check(dirty, debt).state).toBe("success");
    const none = { [BASELINE]: JSON.stringify({ violations: [] }) };
    expect(check(goodFiles, debt, { headRules: none })).toMatchObject({ state: "success", protectedChanges: [] });
    expect(check(dirty, debt, { headRules: none }).state).toBe("failure");
  });
});

describe("complete checks", () => {
  const rules = rulesFor(goodFiles);

  it("never passes when source files could not be read", () => {
    const res = check(goodFiles, rules, { treePaths: [...Object.keys(goodFiles), "src/data/hidden.ts", "README.md"] });
    expect(res).toMatchObject({ state: "error", unchecked: ["src/data/hidden.ts"], uncheckedCount: 1 });
    expect(check(goodFiles, rules, { treePaths: null }).state).toBe("error");
  });

  it("accepts files the approved architecture ignores", () => {
    const arch = JSON.stringify({ ...JSON.parse(rules[ARCH]), ignore: ["dist/**"] });
    const res = check(goodFiles, { ...rules, [ARCH]: arch }, { treePaths: [...Object.keys(goodFiles), "dist/bundle.js"] });
    expect(res.state).toBe("success");
  });

  it("does not accept an ignored, unread file once checked code leads to it", () => {
    const arch = JSON.stringify({ ...JSON.parse(rules[ARCH]), ignore: ["dist/**"] });
    const files = { ...goodFiles, "src/data/d.ts": `import "../../dist/small";`, "dist/small.js": `import "./big";` };
    const res = check(files, { ...rules, [ARCH]: arch }, { treePaths: [...Object.keys(files), "dist/big.js"] });
    expect(res).toMatchObject({ state: "error", unchecked: ["dist/big.js"] });
    // Output chunks that only import each other are fine.
    const own = { ...goodFiles, "dist/small.js": `import "./big";` };
    expect(check(own, { ...rules, [ARCH]: arch }, { treePaths: [...Object.keys(own), "dist/big.js"] }).state).toBe("success");
  });

  it("does not let an ignored folder carry an import around the layers", () => {
    const arch = JSON.stringify({ ...JSON.parse(rules[ARCH]), ignore: ["dist/**"] });
    const files = { ...goodFiles, "src/data/d.ts": `import "../../dist/bridge";`, "dist/bridge.js": `export * from "../src/ui/Page";` };
    const res = check(files, { ...rules, [ARCH]: arch });
    expect(res.state).toBe("failure");
    expect(res.newViolations.map((v) => v.ruleId)).toContain("LAYER01");
  });

  it("setup proposes ignoring unreadable files that nothing imports, and refuses ones that are imported", () => {
    const paths = [...Object.keys(goodFiles), "dist/bundle.js", "public/huge.js", ".yarn/releases/yarn.cjs", ".pnp.cjs"];
    const plan = prepareSetup(goodFiles, paths);
    expect(JSON.parse(plan.setupFiles[ARCH]).ignore).toEqual([".pnp.cjs", ".yarn/**", "dist/**", "public/huge.js"]);
    expect(plan.unchecked).toEqual([]);
    // The proposal then passes its own check.
    expect(check(goodFiles, { [ARCH]: plan.setupFiles[ARCH], [BASELINE]: plan.setupFiles[BASELINE] }, { treePaths: paths }).state).toBe("success");

    const imported = { ...goodFiles, "src/ui/Page.ts": `import "../gen/types";` };
    expect(prepareSetup(imported, [...Object.keys(imported), "src/gen/types.ts"]).unchecked).toEqual(["src/gen/types.ts"]);
    const many = Array.from({ length: 21 }, (_, i) => `vendor/${i}.js`);
    expect(prepareSetup(goodFiles, [...Object.keys(goodFiles), ...many]).unchecked).toHaveLength(21);
  });
});

describe("setup pull request", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeGithub(opts: { branchExists?: boolean; prExists?: boolean }) {
    const calls: Array<{ method: string; url: string; body?: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET";
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url, body });
        const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
        if (url.endsWith("/git/ref/heads/main")) return json({ object: { sha: "base1" } });
        if (url.endsWith("/git/commits/base1")) return json({ tree: { sha: "tree0" } });
        if (url.endsWith("/git/trees")) return json({ sha: "tree1" });
        if (url.endsWith("/git/commits")) return json({ sha: "commit1" });
        if (url.endsWith("/git/refs") && method === "POST") return json({}, opts.branchExists ? 422 : 201);
        if (url.includes("/git/refs/heads/voxium/setup") && method === "PATCH") return json({});
        if (url.endsWith("/pulls/9") && method === "PATCH") return json({});
        if (url.includes("/pulls?state=open")) return json(opts.prExists ? [{ html_url: "https://gh/pr/9", number: 9 }] : []);
        if (url.endsWith("/pulls") && method === "POST") return json({ html_url: "https://gh/pr/10", number: 10 }, 201);
        return json({ message: `unexpected ${method} ${url}` }, 500);
      }),
    );
    return calls;
  }

  it("commits to a new branch and opens a PR, never touching the default branch", async () => {
    const calls = fakeGithub({});
    const res = await createSetupPr("tok", "o/r", "main", { "voxium/architecture.json": "{}\n" }, { title: "T", body: "B" });
    expect(res).toMatchObject({ url: "https://gh/pr/10", number: 10, reused: false });
    const tree = calls.find((c) => c.url.endsWith("/git/trees"))!;
    expect(tree.body.base_tree).toBe("tree0");
    expect(tree.body.tree[0]).toMatchObject({ path: "voxium/architecture.json", mode: "100644", type: "blob" });
    const pr = calls.find((c) => c.url.endsWith("/pulls") && c.method === "POST")!;
    expect(pr.body).toMatchObject({ head: "voxium/setup", base: "main" });
    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("heads/main"))).toBe(false);
  });

  it("reuses the branch and the open PR on a second attempt", async () => {
    const calls = fakeGithub({ branchExists: true, prExists: true });
    const res = await createSetupPr("tok", "o/r", "main", { a: "b" }, { title: "T", body: "B" });
    expect(res).toMatchObject({ number: 9, reused: true });
    expect(calls.find((c) => c.url.endsWith("/pulls/9"))!.body).toEqual({ title: "T", body: "B" });
    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("heads/voxium/setup") && c.body.force === true)).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/pulls") && c.method === "POST")).toBe(false);
  });
});
