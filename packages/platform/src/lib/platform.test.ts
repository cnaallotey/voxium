import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkChange, extractImports } from "@voxium/core";
import { readProjectFiles } from "@voxium/core/node";
import { checkPullRequest, describeUnchecked, prepareSetup, settleWarnings, wantFile, type PrCheckInput } from "./analysis";
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

  it("reads extra files into their own map, with their own size limit", async () => {
    const parent = tmp();
    const dir = path.join(parent, "repo-sha");
    fs.mkdirSync(path.join(dir, "voxium/proposals"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "voxium/proposals/big.json"), "x".repeat(5000));
    fs.writeFileSync(path.join(dir, "voxium/proposals/small.json"), "{}");
    fs.writeFileSync(path.join(dir, "src/a.ts"), "x".repeat(5000));
    const out = path.join(tmp(), "r.tar.gz");
    pack(parent, out);
    const into: Record<string, string> = {};
    const files = await readTarGz(stream(out), { want, extra: { want: (p) => p.startsWith("voxium/proposals/"), maxFileBytes: 1000, into } });
    expect(into).toEqual({ "voxium/proposals/small.json": "{}" });
    expect(Object.keys(files)).toEqual(["src/a.ts"]);
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
      [".cursor/rules/voxium.mdc", "AGENTS.md", "CLAUDE.md", "voxium/CODEOWNERS.suggested", "voxium/architecture.json", "voxium/baseline.json"].sort(),
    );
    const pinned = prepareSetup(goodFiles, undefined, "voxium@1.2.3").setupFiles;
    expect(pinned[".github/workflows/voxium.yml"]).toContain("voxium@1.2.3 check");
    expect(pinned[".mcp.json"]).toContain("voxium@1.2.3");
    expect(plan.setupFiles["CLAUDE.md"]).toContain("# Mine");
    expect(check(goodFiles, rulesFor(goodFiles)).state).toBe("success");
  });

  it("says which violations are new, where and why, and whether everything was checked", () => {
    const rules = rulesFor(goodFiles);
    const bad = { ...goodFiles, "src/data/d.ts": `\nimport "../ui/Page";` };
    const res = check(bad, rules);
    expect(res.newViolations[0]).toMatchObject({ id: "LAYER01:src/data/d.ts->src/ui/Page.ts", line: 2, rationale: expect.stringMatching(/./) });
    expect(res.complete).toBe(true);
    expect(check(bad, rules, { treePaths: null }).complete).toBe(false);
    expect(check(bad, { ...rules, [ARCH]: "{" }).complete).toBe(false);
  });

  it("lists new warnings without changing the state, the description or what fails", () => {
    const rules = rulesFor(goodFiles);
    const parsed = JSON.parse(rules[ARCH]);
    const naming = { id: "NAME01", type: "naming", module: "*", files: "src/**", style: "kebab", description: "d", rationale: "r", severity: "warn" };
    const warned = { ...rules, [ARCH]: JSON.stringify({ ...parsed, rules: [...parsed.rules, naming] }) };
    // goodFiles has src/ui/Page.ts already where the PR branched off, so only what the PR adds is new.
    const head = { ...goodFiles, "src/ui/NewPage.ts": "" };
    const plain = check(head, rules, { mergeBaseFiles: goodFiles });
    const res = check(head, warned, { mergeBaseFiles: goodFiles });
    expect(res.warnings).toEqual([expect.objectContaining({ id: "NAME01:src/ui/NewPage.ts", ruleId: "NAME01", severity: "warn" })]);
    expect(res.warningCount).toBe(1);
    expect([res.state, res.description, res.newViolations]).toEqual([plain.state, plain.description, plain.newViolations]);
    // Accepted ones are not warnings, and a failing check keeps its own description.
    expect(check(head, { ...warned, [BASELINE]: JSON.stringify({ violations: ["NAME01:src/ui/NewPage.ts"] }) }, { mergeBaseFiles: goodFiles }).warnings).toEqual([]);
    const bad = { ...head, "src/data/d.ts": `import "../ui/Page";` };
    expect([check(bad, warned, { mergeBaseFiles: goodFiles }).state, check(bad, warned, { mergeBaseFiles: goodFiles }).description]).toEqual([
      check(bad, rules, { mergeBaseFiles: goodFiles }).state,
      check(bad, rules, { mergeBaseFiles: goodFiles }).description,
    ]);
    // At most 50 are kept, with the count of all.
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`src/ui/Bad${i}.ts`, ""]));
    const lots = check({ ...head, ...many }, warned, { mergeBaseFiles: goodFiles });
    expect([lots.warnings?.length, lots.warningCount, lots.state]).toEqual([50, 61, "success"]);
  });

  it("lists as warnings only what the pull request adds, never what was there where it branched off", () => {
    const rules = rulesFor(goodFiles);
    const parsed = JSON.parse(rules[ARCH]);
    const naming = { id: "NAME01", type: "naming", module: "*", files: "src/**", style: "kebab", description: "d", rationale: "r", severity: "warn" };
    const warned = { ...rules, [ARCH]: JSON.stringify({ ...parsed, rules: [...parsed.rules, naming] }) };
    // The code is the same as where the PR branched off: src/ui/Page.ts breaks the rule, but not because of this PR.
    const same = check(goodFiles, warned, { mergeBaseFiles: goodFiles });
    expect([same.warnings, same.warningCount, same.needsBase, same.pendingWarnings]).toEqual([[], 0, false, undefined]);
    // Without the code where it branched off, nothing is listed yet and the outcome holds the warnings to settle. That
    // is not the code a failing check needs, so a check with warnings only never fails or errs for it.
    const first = check(goodFiles, warned);
    expect([first.warnings, first.warningCount, first.needsBase, first.pendingWarnings?.candidates.map((v) => v.id)]).toEqual([[], 0, false, ["NAME01:src/ui/Page.ts"]]);
    expect([first.state, first.description]).toEqual([same.state, same.description]);
    // With no warnings at all, nothing more is needed.
    expect([check(goodFiles, rules).needsBase, check(goodFiles, rules).pendingWarnings]).toEqual([false, undefined]);
    // A file the PR renames into a bad name is new, the one it was is gone.
    const { "src/ui/Page.ts": page, ...rest } = goodFiles;
    const renamed = { ...rest, "src/ui/PageView.ts": page };
    expect(check(renamed, warned, { mergeBaseFiles: goodFiles }).warnings?.map((v) => v.id)).toEqual(["NAME01:src/ui/PageView.ts"]);
  });

  it("settles warnings from the code where the pull request branched off without running the check again", () => {
    const rules = rulesFor(goodFiles);
    const parsed = JSON.parse(rules[ARCH]);
    const naming = { id: "NAME01", type: "naming", module: "*", files: "src/**", style: "kebab", description: "d", rationale: "r", severity: "warn" };
    const warned = { ...rules, [ARCH]: JSON.stringify({ ...parsed, rules: [...parsed.rules, naming] }) };
    const head = { ...goodFiles, "src/ui/NewPage.ts": "", "src/data/d.ts": `import "../ui/Page";` };
    const whole = check(head, warned, { mergeBaseFiles: goodFiles });
    const first = check(head, warned);
    const settled = settleWarnings(first, goodFiles);
    expect(settled).toEqual(whole);
    expect(settled).not.toHaveProperty("pendingWarnings");
    expect([settled.state, settled.warnings?.map((v) => v.id)]).toEqual(["failure", ["NAME01:src/ui/NewPage.ts"]]);
    // When that code cannot be read, nothing but the warnings changes, and they are said to be unknown.
    const unknown = settleWarnings(first, null);
    expect([unknown.state, unknown.description, unknown.newViolations, unknown.warnings, unknown.warningCount, unknown.warningsUnknown]).toEqual([
      first.state, first.description, first.newViolations, [], 0, true,
    ]);
    expect(unknown).not.toHaveProperty("pendingWarnings");
    // A settled outcome stays as it is.
    expect(settleWarnings(whole, null)).toBe(whole);
  });

  it("builds the code where the pull request branched off with its own paths, so an opaque import that was there is not new", () => {
    const rules = rulesFor(goodFiles);
    const opaque = JSON.parse(rules[ARCH]).rules.find((r: { type: string }) => r.type === "no_opaque_imports");
    expect(opaque).toMatchObject({ severity: "warn" });
    const code = {
      ...goodFiles,
      "src/data/a.cjs": `require("./x.txt");`,
      "src/data/b.cjs": `require("./node_modules/p");`,
      "src/data/c.ts": `import "lodash";`,
    };
    // Paths that are not source code: a data file and committed node_modules.
    const paths = [...Object.keys(code), "src/data/x.txt", "src/data/node_modules/p/package.json", "src/node_modules/lodash/package.json"];
    const head = { ...code, "src/data/d.ts": `export const y = 1;` };
    const run = (over: Partial<PrCheckInput>) => check(head, rules, { treePaths: paths, ...over });
    const first = run({});
    expect(first.pendingWarnings?.candidates.map((v) => v.id)).toEqual(["a.cjs", "b.cjs", "c.ts"].map((f) => `${opaque.id}:src/data/${f}`));
    // The same three are there where it branched off, so none of them is new, inline or settled afterwards.
    const inline = run({ mergeBaseFiles: code, mergeBasePaths: paths });
    expect([inline.state, inline.warnings, inline.warningCount]).toEqual(["success", [], 0]);
    expect(settleWarnings(first, code, paths)).toEqual(inline);
    // A file the tree lists that could not be read is an empty node there, as it is for the head.
    const { "src/data/c.ts": _c, ...unread } = code;
    expect(settleWarnings(first, unread, paths).warnings?.map((v) => v.file)).toEqual(["src/data/c.ts"]);
    // One the pull request adds is still new.
    const added = check({ ...head, "src/data/e.cjs": `require("./x.txt");` }, rules, { treePaths: [...paths, "src/data/e.cjs"], mergeBaseFiles: code, mergeBasePaths: paths });
    expect(added.warnings?.map((v) => v.file)).toEqual(["src/data/e.cjs"]);
  });

  it("does not list as new a public_api warning that the code where the pull request branched off had for the whole module", () => {
    const rules = rulesFor(goodFiles);
    const parsed = JSON.parse(rules[ARCH]);
    const api = { id: "API01", type: "public_api", module: "data", entries: ["src/data/index.ts"], description: "d", rationale: "r", severity: "warn" };
    const arch = { ...rules, [ARCH]: JSON.stringify({ ...parsed, rules: [...parsed.rules, api] }) };
    const internal = Array.from({ length: 25 }, (_, i) => `src/data/f${String(i).padStart(2, "0")}.ts`);
    const repo = (list: string[]) => ({
      ...goodFiles,
      "src/data/index.ts": "",
      ...Object.fromEntries(list.map((f) => [f, ""])),
      "src/shared.ts": ["./data/index", ...list.map((f) => `./${f.slice(4, -3)}`)].map((f) => `export * from "${f}";`).join("\n"),
      "src/ui/Page.ts": `import "../services/s";\nimport "../shared";`,
    });
    // The pull request deletes files until 20 are left, which are then reported one by one.
    const fewer = check(repo(internal.slice(0, 20)), arch, { mergeBaseFiles: repo(internal) });
    expect([fewer.warnings, fewer.warningCount]).toEqual([[], 0]);
    // Without it, each of them would be listed.
    expect(check(repo(internal.slice(0, 20)), arch, { mergeBaseFiles: goodFiles }).warningCount).toBe(20);
  });

  it("does not list a warning that an exception covers", () => {
    const rules = rulesFor(goodFiles);
    const parsed = JSON.parse(rules[ARCH]);
    const naming = { id: "NAME01", type: "naming", module: "*", files: "src/**", style: "kebab", description: "d", rationale: "r", severity: "warn" };
    const exceptions = [{ rule: "NAME01", file: "src/ui/New*.ts", owner: "ann", reason: "later", expires: "2999-01-01" }];
    const excepted = { ...rules, [ARCH]: JSON.stringify({ ...parsed, rules: [...parsed.rules, naming], exceptions }) };
    const head = { ...goodFiles, "src/ui/NewPage.ts": "", "src/ui/OtherPage.ts": "" };
    const res = check(head, excepted, { mergeBaseFiles: goodFiles });
    expect([res.warnings?.map((v) => v.id), res.warningCount]).toEqual([["NAME01:src/ui/OtherPage.ts"], 1]);
  });

  it("announces exceptions that run out within two weeks", () => {
    const rules = rulesFor(goodFiles);
    const ex = (expires: string) => ({ rule: "R", file: `${expires}.ts`, owner: "o", reason: "r", expires });
    const arch = JSON.stringify({ ...JSON.parse(rules[ARCH]), exceptions: ["2025-12-31", "2026-01-01", "2026-01-15", "2026-01-16"].map(ex) });
    const res = check(goodFiles, { ...rules, [ARCH]: arch }, { today: new Date("2026-01-01T12:00:00Z") });
    expect(res.expiring.map((e) => e.expires)).toEqual(["2026-01-01", "2026-01-15"]);
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

  it("says when it needs the earlier code to judge what is left of a cycle", () => {
    const whole = { "src/ui/Page.ts": `import "../services/s";`, "src/services/s.ts": `import "../ui/Page"; import "../data/d";`, "src/data/d.ts": `import "../services/s";` };
    const rules = rulesFor(whole);
    const less = { ...whole, "src/data/d.ts": "" };
    expect(check(whole, rules)).toMatchObject({ state: "success", needsBase: false });
    expect(check(less, rules)).toMatchObject({ state: "failure", needsBase: true });
    expect(check(less, rules, { mergeBaseFiles: whole })).toMatchObject({ state: "success", needsBase: false });
    expect(check(less, rules, { mergeBaseFiles: {} })).toMatchObject({ state: "failure", needsBase: false });
    // Dropping the accepted cycle from the baseline as well leaves nothing to fall back on.
    const none = JSON.stringify({ violations: JSON.parse(rules[BASELINE]).violations.filter((v: string) => !v.startsWith("CYCLE01")) });
    expect(check(less, rules, { mergeBaseFiles: whole, headRules: { [BASELINE]: none } })).toMatchObject({ state: "failure", protectedChanges: [] });
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

  it("sees an import of a file of the tree that is not source code but would run as code", () => {
    const arch = JSON.parse(rules[ARCH]);
    const blocking = { ...rules, [ARCH]: JSON.stringify({ ...arch, rules: arch.rules.map((r: { type: string }) => (r.type === "no_opaque_imports" ? { ...r, severity: "block" } : r)) }) };
    expect(JSON.parse(blocking[ARCH]).rules.some((r: { type: string; severity: string }) => r.type === "no_opaque_imports" && r.severity === "block")).toBe(true);
    const head = { ...goodFiles, "src/data/d.ts": "require('./payload.txt');\nexport {};" };
    const res = check(head, blocking, { treePaths: [...Object.keys(head), "src/data/payload.txt"] });
    expect(res).toMatchObject({ state: "failure", complete: true });
    expect(res.newViolations.map((v) => v.id)).toEqual(["OPAQUE01:src/data/d.ts"]);
    // A file that is not there, or that is data, runs nothing.
    expect(check(head, blocking).state).toBe("success");
    expect(check({ ...head, "src/data/d.ts": "require('./payload.json');\nexport {};" }, blocking, { treePaths: [...Object.keys(head), "src/data/payload.json"] }).state).toBe("success");
  });

  it("never passes when source files could not be read", () => {
    const res = check(goodFiles, rules, { treePaths: [...Object.keys(goodFiles), "src/data/hidden.ts", "README.md"] });
    expect(res).toMatchObject({ state: "error", unchecked: ["src/data/hidden.ts"], uncheckedCount: 1 });
    expect(check(goodFiles, rules, { treePaths: null }).state).toBe("error");
  });

  it("never passes when source files could not be read to their end", () => {
    const broken = { ...goodFiles, "src/data/d.ts": `import "../ui/Page";\nexport const d = \`;\n` };
    const res = check(broken, rules);
    expect(res).toMatchObject({ state: "error", complete: false, unchecked: ["src/data/d.ts"], uncheckedCount: 1 });
    expect(res.description).toBe("1 source file(s) could not be read, for example src/data/d.ts, which ends inside a template literal.");
    // With both kinds, and next to a violation, which is certain.
    const hidden = check(broken, rules, { treePaths: [...Object.keys(broken), "src/ui/hidden.ts"] });
    expect(hidden).toMatchObject({ state: "error", unchecked: ["src/ui/hidden.ts", "src/data/d.ts"], uncheckedCount: 2 });
    expect(check({ ...broken, "src/data/e.ts": `import "../ui/Page";` }, rules)).toMatchObject({ state: "failure", uncheckedCount: 1 });
    // Once it is fixed, what it hid counts.
    const fixed = check({ ...goodFiles, "src/data/d.ts": `import "../ui/Page";\nexport const d = \`\`;\n` }, rules);
    expect(fixed).toMatchObject({ state: "failure", uncheckedCount: 0 });
    expect(fixed.newViolations.map((v) => v.id)).toContain("LAYER01:src/data/d.ts->src/ui/Page.ts");
  });

  it("accepts ones that the approved architecture ignores while nothing that is checked leads to them", () => {
    const ignoring = { ...rules, [ARCH]: JSON.stringify({ ...JSON.parse(rules[ARCH]), ignore: ["templates/**"] }) };
    const files = { ...goodFiles, "templates/a.js": "const a = '{{ name }" };
    expect(check(files, ignoring).state).toBe("success");
    expect(check({ ...files, "src/data/e.ts": `import "../../templates/a";` }, ignoring)).toMatchObject({ state: "error", unchecked: ["templates/a.js"] });
    expect(check(files, rules, { headRules: ignoring })).toMatchObject({ state: "failure", unchecked: ["templates/a.js"], protectedChanges: [ARCH] });
  });

  it("sets up a repository with such files by ignoring them, unless code that is checked imports them", () => {
    const files = { ...goodFiles, "templates/a.js": "const a = '{{ name }" };
    const plan = prepareSetup(files, Object.keys(files));
    expect(plan.ignore).toEqual(["templates/a.js"]);
    expect(plan.unchecked).toEqual([]);
    expect(check(files, { [ARCH]: plan.setupFiles[ARCH], [BASELINE]: plan.setupFiles[BASELINE] }).state).toBe("success");
    expect(prepareSetup({ ...files, "src/data/e.ts": `import "../../templates/a";` }).unchecked).toEqual(["templates/a.js"]);
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

describe("import resolution", () => {
  const ARCH_FILE = {
    version: 1,
    modules: { ui: { paths: ["packages/ui/**"] }, data: { paths: ["packages/data/**"] } },
    layers: ["ui", "data"],
    rules: [
      { id: "LAYER01", type: "layers", description: "d", rationale: "r", severity: "block" },
      { id: "EXT01", type: "deny_external", module: "data", packages: ["pg", "node:child_process"], description: "d", rationale: "r", severity: "block" },
    ],
    exceptions: [],
  };
  const BEFORE: Record<string, string> = {
    [ARCH]: JSON.stringify(ARCH_FILE),
    "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    "tsconfig.json": `{ // paths\n "compilerOptions": { "baseUrl": ".", "paths": { "@ui/*": ["packages/ui/src/*"] }, }, }`,
    "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", exports: { ".": { import: "./dist/index.js" }, "./*": "./dist/*.js" } }),
    "packages/ui/src/index.ts": "export {};",
    "packages/ui/src/page.ts": "import '@acme/data';",
    "packages/data/package.json": JSON.stringify({ name: "@acme/data", imports: { "#db": "pg", "#ui": "./../ui/src/page.ts" }, dependencies: { sql: "npm:pg@8" } }),
    "packages/data/src/index.ts": "export {};",
  };
  const CHANGE = { path: "packages/data/src/index.ts", content: "import '@acme/ui/page';\nimport '@ui/index';\nimport 'packages/ui/src/page';\nimport '#db';\nimport sql from 'sql';\nimport 'node:child_process';\nexport {};" };

  it("gives the CLI check, check_change and the platform the same results", () => {
    const dir = tmp();
    const writeAll = (files: Record<string, string>) => {
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
      }
    };
    writeAll(BEFORE);
    const ctx = { arch: ARCH_FILE as never, files: readProjectFiles(dir), baseline: [] };
    const fromAgent = checkChange(ctx, [CHANGE]).introduced.map((v) => `${v.rule} ${v.file} ${v.message}`).sort();

    writeAll({ [CHANGE.path]: CHANGE.content });
    const cli = path.resolve(__dirname, "../../../cli/dist/cli.js");
    let out = "";
    try {
      execFileSync(process.execPath, [cli, "check", "--format", "json", "--root", dir], { encoding: "utf8" });
    } catch (err) {
      expect((err as { status: number }).status).toBe(1);
      out = (err as { stdout: string }).stdout;
    }
    const fromCli = (JSON.parse(out).violations as Array<{ ruleId: string; file: string; message: string }>).map((v) => `${v.ruleId} ${v.file} ${v.message}`).sort();

    const head = { ...BEFORE, [CHANGE.path]: CHANGE.content };
    const headFiles = Object.fromEntries(Object.entries(head).filter(([p]) => wantFile(p)));
    const res = check(headFiles, { [ARCH]: BEFORE[ARCH] }, { treePaths: Object.keys(head) });
    expect(res.complete).toBe(true);
    const fromPlatform = res.newViolations.map((v) => `${v.ruleId} ${v.file} ${v.message}`).sort();

    expect(new Set(fromCli).size).toBe(4);
    expect([...new Set(fromCli)]).toEqual([...new Set(fromAgent)]);
    expect([...new Set(fromPlatform)]).toEqual([...new Set(fromCli)]);
    expect([...new Set(res.newViolations.map((v) => v.id))].sort()).toEqual([
      "EXT01:packages/data/src/index.ts->child_process", "EXT01:packages/data/src/index.ts->pg",
      "LAYER01:packages/data/src/index.ts->packages/ui/src/index.ts", "LAYER01:packages/data/src/index.ts->packages/ui/src/page.ts",
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps config files, and never passes when one above the code is broken or could not be read", () => {
    expect(["package.json", "tsconfig.json", "apps/web/tsconfig.app.json", "pnpm-workspace.yaml"].every(wantFile)).toBe(true);
    expect(wantFile("node_modules/x/package.json")).toBe(false);
    const rules = { [ARCH]: BEFORE[ARCH] };
    expect(check(BEFORE, rules).state).toBe("success");
    const broken = check({ ...BEFORE, "tsconfig.json": "{" }, rules);
    expect(broken).toMatchObject({ state: "error", complete: false, unchecked: ["tsconfig.json"] });
    expect(broken.description).toContain("tsconfig.json, which is not valid JSON");
    const { "tsconfig.json": _, ...unread } = BEFORE;
    expect(check(unread, rules, { treePaths: Object.keys(BEFORE) })).toMatchObject({ state: "error", unchecked: ["tsconfig.json"] });
    expect(check({ ...BEFORE, "tsconfig.json": "{" }, { [ARCH]: JSON.stringify({ ...ARCH_FILE, ignore: ["tsconfig.json"] }) }).state).toBe("success");
  });

  it("resolves with the config files where the PR branched off, so editing a nested tsconfig cannot drop an import", () => {
    const arch = { ...ARCH_FILE, modules: { ui: { paths: ["apps/web/src/ui/**"] }, data: { paths: ["apps/web/src/data/**"] } }, layers: ["data", "ui"] };
    const rules = { [ARCH]: JSON.stringify(arch) };
    const base: Record<string, string> = {
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@web/*": ["src/*"] } } }),
      "apps/web/src/data/db.ts": "",
      "apps/web/src/ui/page.ts": "",
    };
    const head = {
      ...base,
      "apps/web/src/ui/page.ts": "import '@web/data/db';",
      "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@web/data/*": ["src/ui/stub/*"], "@web/*": ["src/*"] } } }),
      "apps/web/src/ui/stub/db.ts": "",
    };
    const id = ["LAYER01:apps/web/src/ui/page.ts->apps/web/src/data/db.ts"];
    expect(check(head, rules).state).toBe("success"); // what the head alone says
    expect(check(head, rules, { mergeBaseConfig: base }).newViolations.map((v) => v.id)).toEqual(id);
    expect(check({ ...head, "apps/web/tsconfig.json": "{}" }, rules, { mergeBaseConfig: base }).newViolations.map((v) => v.id)).toEqual(id);
    // When they could not be read, the check is not complete.
    const unknown = check({ ...base, "apps/web/src/ui/page.ts": "export {};" }, rules, { mergeBaseConfig: null });
    expect(unknown).toMatchObject({ state: "error", complete: false });
    expect(unknown.description).toContain("config files where this PR branched off could not be read");
    expect(check(base, rules, { mergeBaseConfig: base }).state).toBe("success");
  });

  it("calls config files that cannot be read config files, with the reason", () => {
    const rules = { [ARCH]: BEFORE[ARCH] };
    const broken = check({ ...BEFORE, "packages/ui/package.json": "{" }, rules);
    expect(broken.description).toBe("1 config file(s) could not be read, for example packages/ui/package.json, which is not valid JSON.");
    expect(describeUnchecked(["a.ts", "tsconfig.json", "b/package.json"])).toBe("1 source file(s) and 2 config file(s)");
    const plan = prepareSetup({ ...BEFORE, "tsconfig.json": "{" }, Object.keys(BEFORE));
    expect(plan.unchecked).toEqual(["tsconfig.json"]);
    expect(plan.reasons).toEqual({ "tsconfig.json": "is not valid JSON" });
    // A tsconfig set up as gts documents it is not one of them.
    const gts = { ...BEFORE, "tsconfig.json": JSON.stringify({ extends: "./node_modules/gts/tsconfig-google.json" }) };
    expect(prepareSetup(gts, Object.keys(gts)).unchecked).toEqual([]);
  });

  it("builds the code where the PR branched off with the aliases of the rules", () => {
    const whole = { "src/ui/Page.ts": `import "../services/s";`, "src/services/s.ts": `import "../ui/Page"; import "../data/d";`, "src/data/d.ts": `import "../services/s";` };
    const plain = rulesFor(whole);
    const aliased = { ...whole, "src/services/s.ts": `import "@u/Page"; import "../data/d";` };
    const rules = { ...plain, [ARCH]: JSON.stringify({ ...JSON.parse(plain[ARCH]), aliases: { "@u/*": ["src/ui/*"] } }) };
    const less = { ...aliased, "src/data/d.ts": "" };
    expect(check(aliased, rules)).toMatchObject({ state: "success" });
    expect(check(less, rules)).toMatchObject({ state: "failure", needsBase: true });
    // What is left of the accepted cycle goes through the alias, as it did where the PR branched off.
    expect(check(less, rules, { mergeBaseFiles: aliased })).toMatchObject({ state: "success", needsBase: false });
  });

  it("sees a relative import of a committed node_modules package, whose package.json is not read", () => {
    const rules = { [ARCH]: JSON.stringify({ ...ARCH_FILE, rules: [...ARCH_FILE.rules, { id: "OPQ01", type: "no_opaque_imports", description: "d", rationale: "r", severity: "block" }] }) };
    const head = { ...BEFORE, "packages/data/src/a4.cjs": "require('./node_modules/mainpkg')" };
    const tree = [...Object.keys(head), "packages/data/src/node_modules/mainpkg/package.json", "packages/data/src/node_modules/mainpkg/lib.txt"];
    const res = check(Object.fromEntries(Object.entries(head).filter(([p]) => wantFile(p))), rules, { treePaths: tree });
    expect(res.newViolations.map((v) => v.id)).toEqual(["OPQ01:packages/data/src/a4.cjs"]);
  });

  it("sees a relative import that ends with '/' as the folder Node loads, not a file of that name", () => {
    const head = { ...BEFORE, "packages/ui.js": "", "packages/ui/index.js": "", "packages/data/src/b.cjs": "require('../../ui/')" };
    const res = check(Object.fromEntries(Object.entries(head).filter(([p]) => wantFile(p))), { [ARCH]: BEFORE[ARCH] }, { treePaths: Object.keys(head) });
    expect(res.state).toBe("failure");
    expect(res.newViolations.map((v) => v.id)).toEqual(["LAYER01:packages/data/src/b.cjs->packages/ui/index.js"]);
  });

  it("is not complete when pnpm-workspace.yaml is written in a form of YAML that is not read, which could hide overrides", () => {
    for (const yaml of ["{overrides: {x: 'npm:pg@8'}}\n", "  overrides:\n    x: npm:pg@8\n"]) {
      const head = { ...BEFORE, "pnpm-workspace.yaml": yaml, "packages/data/src/a.ts": "import 'x';" };
      const res = check(Object.fromEntries(Object.entries(head).filter(([p]) => wantFile(p))), { [ARCH]: BEFORE[ARCH] }, { treePaths: Object.keys(head) });
      expect(res, yaml).toMatchObject({ state: "error", complete: false });
      expect(res.description).toContain("pnpm-workspace.yaml");
    }
  });

  it("takes aliases from the rules of the base branch, so the PR cannot drop them", () => {
    const rules = { [ARCH]: JSON.stringify({ ...ARCH_FILE, aliases: { "@acme/ui": ["packages/ui/src/index.ts"] } }) };
    const head = { ...BEFORE, "package.json": "{}", [CHANGE.path]: "import '@acme/ui';" };
    expect(check(head, { [ARCH]: BEFORE[ARCH] }).state).toBe("success");
    expect(check(head, rules).newViolations.map((v) => v.id)).toEqual(["LAYER01:packages/data/src/index.ts->packages/ui/src/index.ts"]);
    // Removing them is a change to the rules, which needs approval.
    const dropped = check(head, rules, { headRules: { [ARCH]: BEFORE[ARCH] } });
    expect(dropped).toMatchObject({ state: "failure", protectedChanges: [ARCH] });
  });
});
