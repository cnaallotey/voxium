import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPullRequest, prepareSetup, wantFile } from "./analysis";
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

  it.each(["gnu", "ustar", "pax"])("reads %s format tarballs including long paths", async (format) => {
    const dir = tmp();
    seedRepo(dir);
    const out = path.join(tmp(), `repo-${format}.tar.gz`);
    execFileSync("tar", [`--format=${format}`, "--transform", "s,^\\.,repo-sha,", "-czf", out, "-C", dir, "."]);
    const files = await readTarGz(stream(out), { want });
    expect(files["src/ui/Page.ts"]).toContain("services/s");
    expect(files[`src/shared/${longDir}/deep.ts`]).toContain("deep");
    expect(files["README.md"]).toBeUndefined();
  });

  it("skips files over the size limit and respects the keep budget", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/big.ts"), "x".repeat(5000));
    fs.writeFileSync(path.join(dir, "src/small.ts"), "ok");
    const out = path.join(tmp(), "r.tar.gz");
    execFileSync("tar", ["--transform", "s,^\\.,repo-sha,", "-czf", out, "-C", dir, "."]);
    const files = await readTarGz(stream(out), { want, maxFileBytes: 1000 });
    expect(Object.keys(files)).toEqual(["src/small.ts"]);
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

describe("analysis", () => {
  it("prepares a setup plan whose files are consistent and baseline starts green", () => {
    const plan = prepareSetup({ ...goodFiles, "CLAUDE.md": "# Mine\n" });
    expect(plan.summary.layers).toEqual(["ui", "services", "data"]);
    expect(Object.keys(plan.setupFiles).sort()).toEqual(
      [".github/workflows/voxium.yml", ".mcp.json", "AGENTS.md", "CLAUDE.md", "voxium/CODEOWNERS.suggested", "voxium/architecture.json", "voxium/baseline.json"].sort(),
    );
    expect(plan.setupFiles["CLAUDE.md"]).toContain("# Mine");
    const arch = plan.setupFiles["voxium/architecture.json"];
    const res = checkPullRequest(goodFiles, arch, plan.setupFiles["voxium/baseline.json"], arch);
    expect(res.state).toBe("success");
  });

  it("wantFile keeps source and agent files only", () => {
    expect(wantFile("src/a.ts")).toBe(true);
    expect(wantFile("CLAUDE.md")).toBe(true);
    expect(wantFile("README.md")).toBe(false);
    expect(wantFile("node_modules/x/index.js")).toBe(false);
  });

  it("fails a PR with a new violation and uses the BASE rules, not the PR's edited rules", () => {
    const plan = prepareSetup(goodFiles);
    const baseArch = plan.setupFiles["voxium/architecture.json"];
    const baseBaseline = plan.setupFiles["voxium/baseline.json"];

    const bad = { ...goodFiles, "src/data/d.ts": `import "../ui/Page";` };

    // The PR also deletes the rules to try to pass.
    const weakened = JSON.stringify({ ...JSON.parse(baseArch), rules: [] });
    const res = checkPullRequest(bad, baseArch, baseBaseline, weakened);
    expect(res.state).toBe("failure");
    expect(res.architectureChanged).toBe(true);
    expect(res.description).toMatch(/Team Leader/);
    expect(res.newViolations.map((v) => v.ruleId).sort()).toEqual(["CYCLE01", "LAYER01"]);
  });

  it("skips repos that are not set up and errors on a broken architecture file", () => {
    expect(checkPullRequest(goodFiles, null, null, null)).toMatchObject({ state: "success", skipped: true });
    expect(checkPullRequest(goodFiles, "{not json", null, null).state).toBe("error");
    expect(checkPullRequest(goodFiles, JSON.stringify({ version: 1 }), null, null).state).toBe("error");
  });

  it("does not fail on baseline debt but fails on expired exceptions", () => {
    const dirty = { ...goodFiles, "src/data/d.ts": `import "../services/s";` };
    const plan = prepareSetup(dirty);
    expect(plan.baselineCount).toBeGreaterThan(0);
    const arch = plan.setupFiles["voxium/architecture.json"];
    const base = plan.setupFiles["voxium/baseline.json"];
    expect(checkPullRequest(dirty, arch, base, arch).state).toBe("success");

    const withEx = JSON.stringify({
      ...JSON.parse(arch),
      exceptions: [{ rule: "LAYER01", file: "src/data/**", owner: "t", reason: "r", expires: "2020-01-01" }],
    });
    const res = checkPullRequest(dirty, withEx, base, withEx, new Date("2026-11-24"));
    expect(res.state).toBe("failure");
    expect(res.description).toMatch(/expired/);
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
    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("heads/voxium/setup") && c.body.force === true)).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/pulls") && c.method === "POST")).toBe(false);
  });
});
