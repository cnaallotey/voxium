import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrCheckOutcome } from "./analysis";
import { database } from "./test-db";

let db = database().db;
vi.mock("./env", () => ({ getEnv: () => ({ DB: db, APP_URL: appUrl }) }));
let appUrl = "https://vx.test";
const { changedLines, commentableLines, commentOnPull, renderInline, renderSummary } = await import("./comments");
const { listPullFiles } = await import("./github");
const { claimComment, listComments, setComment } = await import("./store");
const { code, plain, urlPath } = await import("./markdown");

const violation = (n = 1, over = {}) => ({
  id: `L1:src/d${n}.ts->src/a.ts`, ruleId: "LAYER01", severity: "block" as const, file: `src/d${n}.ts`, line: 2,
  message: `src/d${n}.ts imports @acme/ui`, fix: "Move it", rationale: "Because", ...over,
});
const outcome = (newViolations = [violation()], over: Partial<PrCheckOutcome> = {}): PrCheckOutcome => ({
  state: newViolations.length ? "failure" : "success", skipped: false, description: "D", newViolations, baselineCount: 3, protectedChanges: [],
  approvedBy: null, unchecked: [], uncheckedCount: 0, cycles: new Map(), needsBase: false, expiring: [], complete: true, ...over,
});
const ev = { installationId: 3, repoId: 77, fullName: "o/r", defaultBranch: "main", number: 4, authorId: 1, headSha: "abc1234def", baseRef: "main" };
const key = { githubRepoId: 77, number: 4 };

/** GitHub's comments, by id. */
let issue: Map<number, string>;
let inline: Map<number, { body: string; review: number; path: string; line: number }>;
let reviews: any[];
let calls: string[];
let pull: any;
let files: Array<{ filename: string; status: string; patch?: string }>;
let fail: RegExp | null;
let nextId: number;

beforeEach(() => {
  db = database().db;
  appUrl = "https://vx.test";
  issue = new Map(); inline = new Map(); reviews = []; calls = []; fail = null; nextId = 100;
  pull = { number: 4, state: "open", head: { sha: ev.headSha }, base: { ref: "main" } };
  files = [1, 2, 3].map((n) => ({ filename: `src/d${n}.ts`, status: "modified", patch: "@@ -1 +1,3 @@\n a\n+b\n+c" }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const p = url.replace("https://api.github.com/repos/o/r", "");
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push(`${method} ${p}`);
    const json = (d: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(d), { status });
    if (fail?.test(`${method} ${p}`)) return json({}, 503);
    let m: RegExpMatchArray | null;
    if (p === "/pulls/4") return pull ? json(pull) : json({}, 404);
    if (p.startsWith("/pulls/4/files")) return json(files);
    if (method === "POST" && p === "/issues/4/comments") { issue.set(++nextId, body.body); return json({ id: nextId }, 201); }
    if ((m = p.match(/^\/issues\/comments\/(\d+)$/))) {
      if (!issue.has(+m[1])) return json({}, 404);
      if (method === "DELETE") { issue.delete(+m[1]); return json(null, 204); }
      issue.set(+m[1], body.body);
      return json({});
    }
    if (method === "POST" && p === "/pulls/4/reviews") {
      const id = ++nextId;
      reviews.push(body);
      for (const c of body.comments) inline.set(++nextId, { body: c.body, review: id, path: c.path, line: c.line });
      return json({ id });
    }
    if ((m = p.match(/^\/pulls\/4\/reviews\/(\d+)\/comments/))) return json([...inline].filter(([, c]) => c.review === +m![1]).map(([id, c]) => ({ id, body: c.body })));
    if ((m = p.match(/^\/pulls\/comments\/(\d+)$/))) {
      if (!inline.has(+m[1])) return json({}, 404);
      inline.get(+m[1])!.body = body.body;
      return json({});
    }
    return json({ unexpected: p }, 500);
  });
});
afterEach(() => vi.unstubAllGlobals());

const run = (o: PrCheckOutcome, over: Partial<typeof ev> = {}, opts = {}) =>
  commentOnPull("t", { ...ev, ...over }, o, { ruleChanges: [], pageUrl: "https://vx.test/repos/5/pulls/4", isLatest: async () => true, pullFiles: () => listPullFiles("t", "o/r", 4), ...opts });
const bodies = () => [...issue.values()];
const inlineBodies = () => [...inline.values()].map((c) => c.body);

describe("summary comment", () => {
  it("is not written on a clean pull request", async () => {
    await run(outcome([]));
    expect(calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
  });

  it("is written once, edited in place, and says when all is well", async () => {
    await run(outcome([violation(1), violation(2)]));
    await run(outcome([violation(1)]));
    expect(issue.size).toBe(1);
    expect(bodies()[0]).toContain("### ❌ Voxium: 1 new violation\n");
    await run(outcome([]));
    expect(issue.size).toBe(1);
    expect(bodies()[0]).toContain("### ✅ Voxium: no new violations");
  });

  it("names the rule, file, line, reason and fix", async () => {
    await run(outcome());
    expect(bodies()[0]).toContain("#### LAYER01: [`src/d1.ts:2`](https://github.com/o/r/blob/abc1234def/src/d1.ts#L2)");
    expect(bodies()[0]).toContain("**Why:** Because");
    expect(bodies()[0]).toContain("**Fix:** Move it");
    expect(bodies()[0]).toContain("1 new · 3 accepted as existing debt");
  });

  it("explains what the rules change and who can approve it", async () => {
    await run(outcome([], { state: "failure", protectedChanges: ["voxium/architecture.json"] }), {}, { ruleChanges: ["Removes rule LAYER01"] });
    expect(bodies()[0]).toContain("Voxium: the rules change, and that needs approval");
    expect(bodies()[0]).toContain("* Removes rule LAYER01");
    expect(bodies()[0]).toContain("(https://vx.test/repos/5/pulls/4)");
    await run(outcome([], { protectedChanges: ["voxium/architecture.json"], approvedBy: "ann" }));
    expect(bodies()[0]).toContain("approved by ann");
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://vx.localhost"])("does not link to %s, which only its owner can open", async (url) => {
    appUrl = url;
    await run(outcome([], { state: "failure", protectedChanges: ["voxium/architecture.json"] }), {}, { pageUrl: `${url}/repos/5/pulls/4` });
    expect(bodies()[0]).not.toContain(url);
  });

  it("says what is wrong when no violation does, and lists exceptions that run out", async () => {
    await run(outcome([], { state: "error", description: "2 source file(s) could not be read", uncheckedCount: 2, complete: false, expiring: [{ rule: "L", file: "src/x.ts", owner: "ann", reason: "r", expires: "2026-01-02" }] }));
    expect(bodies()[0]).toContain("could not be read");
    expect(bodies()[0]).toContain("* L for `src/x.ts` on 2026-01-02 (ann)");
  });

  it("lists warnings as not blocking, and a clean pull request with only warnings still gets no comment", async () => {
    const warn = violation(7, { id: "N1:src/d7.ts", ruleId: "NAME01", severity: "warn", message: "src/d7.ts is named Bad_Name", fix: "Rename it" });
    await run(outcome([], { warnings: [warn], warningCount: 1 }));
    expect(calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
    await run(outcome([violation(1)], { warnings: [warn], warningCount: 3 }));
    const body = bodies()[0];
    expect(body).toContain("1 new · 3 accepted as existing debt · 3 warnings, not blocking");
    expect(body).toContain("#### Warnings, not blocking");
    expect(body).toContain("* NAME01: [`src/d7.ts:2`](https://github.com/o/r/blob/abc1234def/src/d7.ts#L2) src/d7.ts is named Bad\\_Name Fix: Rename it");
    expect(body).toContain("* And 2 more.");
    // Warnings get no comment of their own on the lines.
    expect(inlineBodies().some((b) => b.includes("NAME01"))).toBe(false);
  });

  it("says when warnings could not be worked out, and still gives a clean pull request no comment", async () => {
    await run(outcome([], { warnings: [], warningCount: 0, warningsUnknown: true }));
    expect(calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
    const text = renderSummary({ fullName: "o/r", headSha: "h", outcome: outcome([violation(1)], { state: "failure", warnings: [], warningCount: 0, warningsUnknown: true }), ruleChanges: [], pageUrl: null });
    expect(text).toContain("#### Warnings, not blocking\n\nThey could not be worked out, because the code where this pull request branched off could not be read.");
    expect(renderSummary({ fullName: "o/r", headSha: "h", outcome: outcome([violation(1)], { state: "failure" }), ruleChanges: [], pageUrl: null })).not.toContain("Warnings");
  });

  it("stays within GitHub's limit with many warnings too", () => {
    const many = Array.from({ length: 50 }, (_, i) => violation(i, { message: "m".repeat(3000) }));
    const warnings = Array.from({ length: 50 }, (_, i) => violation(i, { severity: "warn" as const, message: "w".repeat(3000) }));
    const text = renderSummary({ fullName: "o/r", headSha: "h", outcome: outcome(many, { warnings, warningCount: 400 }), ruleChanges: [], pageUrl: null });
    expect(text.length).toBeLessThan(65_536);
    const quiet = renderSummary({ fullName: "o/r", headSha: "h", outcome: outcome([], { state: "failure", warnings, warningCount: 400 }), ruleChanges: [], pageUrl: null });
    expect(quiet.length).toBeLessThan(65_536);
    expect(quiet).toMatch(/\* And \d+ more\./);
  });

  it("stays within GitHub's limit", () => {
    const many = Array.from({ length: 500 }, (_, i) => violation(i, { message: "m".repeat(3000) }));
    const text = renderSummary({ fullName: "o/r", headSha: "h", outcome: outcome(many), ruleChanges: [], pageUrl: null });
    expect(text.length).toBeLessThan(65_536);
    expect(text).toMatch(/And \d+ more\./);
  });

  it("comes back after people delete it only when there is something to say", async () => {
    await run(outcome());
    issue.clear();
    await run(outcome([]));
    expect(issue.size).toBe(0);
    await run(outcome());
    expect(issue.size).toBe(1);
  });

  it("stays a single one when two checks write it at the same time", async () => {
    await Promise.all([run(outcome([violation(1)])), run(outcome([violation(1)]))]);
    expect(issue.size).toBe(1);
    expect((await listComments(db, key)).filter((c) => c.kind === "summary")).toHaveLength(1);
  });
});

describe("inline comments", () => {
  it("are posted together, as a comment, on lines of this commit", async () => {
    await run(outcome([violation(1), violation(2)]));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ event: "COMMENT", commit_id: ev.headSha, comments: [{ path: "src/d1.ts", line: 2, side: "RIGHT" }, { path: "src/d2.ts", line: 2 }] });
  });

  it("are not repeated", async () => {
    await run(outcome());
    await run(outcome());
    await Promise.all([run(outcome([violation(2)])), run(outcome([violation(2)]))]);
    expect(inline.size).toBe(2);
  });

  it("say when the violation is gone, and come back with it", async () => {
    await run(outcome());
    await run(outcome([]));
    expect(inlineBodies()[0]).toContain("✅ No longer a violation as of `abc1234`");
    await run(outcome());
    expect(inlineBodies()).toHaveLength(1);
    expect(inlineBodies()[0]).toContain("**Why:**");
    await run(outcome([]));
    expect(inlineBodies()[0]).toContain("No longer a violation");
  });

  it("are not called gone by a check that did not see everything", async () => {
    await run(outcome());
    await run(outcome([], { state: "error", complete: false }));
    expect(inlineBodies()[0]).toContain("**Why:**");
  });

  it("stay away once people delete them", async () => {
    await run(outcome());
    inline.clear();
    await run(outcome([]));
    await run(outcome());
    expect(inline.size).toBe(0);
  });

  it("skip lines GitHub does not show in the diff, and violations without a line", async () => {
    files[1].patch = undefined;
    await run(outcome([violation(1, { line: 9 }), violation(2), violation(3, { line: undefined }), violation(4)]));
    expect(inline.size).toBe(0);
    expect(issue.size).toBe(1);
  });

  it("are limited to twenty at a time", async () => {
    files = Array.from({ length: 30 }, (_, n) => ({ filename: `src/d${n}.ts`, status: "modified", patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c" }));
    await run(outcome(Array.from({ length: 30 }, (_, n) => violation(n))));
    expect(inline.size).toBe(20);
  });

  it("can be posted later when GitHub refused them once", async () => {
    fail = /POST .*reviews/;
    await run(outcome());
    fail = null;
    await run(outcome());
    expect(inline.size).toBe(1);
  });

  describe("about a cycle", () => {
    const cycle = (over = {}) => violation(1, { id: "CYCLE01:a+b", ruleId: "CYCLE01", message: "cycle at d1", ...over });
    const withCycle = (list: ReturnType<typeof violation>[]) => outcome(list, { cycles: new Map([["CYCLE01:a+b", { modules: ["a", "b"], imports: [] }]]) });

    it("are posted on the import that causes it", async () => {
      await run(withCycle([cycle()]));
      expect([...inline.values()]).toMatchObject([{ path: "src/d1.ts", line: 2 }]);
      expect(inlineBodies()[0]).toContain("cycle at d1");
    });

    it("do not add a second comment to an import that breaks another rule too", async () => {
      await run(withCycle([violation(1), cycle()]));
      expect(inlineBodies()).toHaveLength(1);
      expect(inlineBodies()[0]).toContain("LAYER01");
      expect(bodies()[0]).toContain("#### CYCLE01");
      // The other violation is accepted later, and the cycle is not.
      await run(withCycle([cycle()]));
      expect(inlineBodies()).toHaveLength(2);
      expect(inlineBodies()[0]).toContain("No longer a violation");
      expect(inlineBodies()[1]).toContain("CYCLE01");
    });

    it("are posted next to another violation on a different line or file", async () => {
      await run(withCycle([violation(1, { line: 3 }), violation(2), cycle()]));
      expect(inline.size).toBe(3);
    });

    it("follow the cycle when another import keeps it going, and end when it is gone", async () => {
      await run(withCycle([cycle()]));
      await run(withCycle([cycle({ file: "src/d2.ts", message: "cycle at d2" })]));
      expect(inlineBodies()).toHaveLength(1);
      expect(inlineBodies()[0]).toContain("cycle at d2");
      await run(outcome([]));
      expect(inlineBodies()[0]).toContain("No longer a violation");
      await run(withCycle([cycle()]));
      expect(inlineBodies()[0]).toContain("cycle at d1");
    });

    it("stay deleted when people delete them", async () => {
      await run(withCycle([cycle()]));
      inline.clear();
      await run(withCycle([cycle()]));
      await run(withCycle([cycle()]));
      expect(inline.size).toBe(0);
    });
  });

  it("know which lines are new", () => {
    const patch = "@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d";
    const at = (f: object) => changedLines([{ filename: "f", status: "modified", patch, ...f }]).map((c) => c.added && [...c.added]);
    expect(at({})).toEqual([[2, 3]]);
    expect(at({ status: "added" })).toEqual([[2, 3]]);
    expect(at({ status: "renamed" })).toEqual([null]);
    expect(at({ patch: undefined })).toEqual([null]);
    expect(at({ status: "removed" })).toEqual([]);
  });

  it("read diff hunks", () => {
    expect([...commentableLines("@@ -1,2 +1,3 @@ x\n a\n-b\n+c\n+d\n@@ -10 +11,0 @@\n-x\n@@ -20,0 +30 @@\n+z\n\\ No newline at end of file")]).toEqual([1, 2, 3, 30]);
    expect(commentableLines(undefined).size).toBe(0);
    expect(commentableLines("+x").size).toBe(0);
  });
});

describe("comments in general", () => {
  it.each<[string, () => void, object, object]>([
    ["the pull request moved on", () => void (pull.head.sha = "newer"), {}, {}],
    ["it moved to another base", () => void (pull.base.ref = "dev"), {}, {}],
    ["it is closed", () => void (pull.state = "closed"), {}, {}],
    ["it is gone", () => void (pull = null), {}, {}],
    ["a newer check has started", () => {}, {}, { isLatest: async () => false }],
  ])("are not written when %s", async (_n, change, over, opts) => {
    change();
    await run(outcome(), over, opts);
    expect(calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
  });

  it("never throw, whatever GitHub does", async () => {
    for (const f of [/./, /POST/, /PATCH/, /GET .*files/, /reviews/]) {
      fail = f;
      await run(outcome([violation(1), violation(2)]));
      await run(outcome([]));
    }
  });

  it("a claim that never got its comment is free again after ten minutes, a finished one never", async () => {
    expect(await claimComment(db, key, "inline:x", null)).toBe(true);
    expect(await claimComment(db, key, "inline:x", null)).toBe(false);
    await db.prepare("UPDATE pr_comments SET updated_at = datetime('now', '-11 minutes')").run();
    expect(await claimComment(db, key, "inline:x", null)).toBe(true);
    await setComment(db, key, "inline:x", 5, "open");
    await db.prepare("UPDATE pr_comments SET updated_at = datetime('now', '-11 minutes')").run();
    expect(await claimComment(db, key, "inline:x", null)).toBe(false);
  });
});

describe("text from a pull request", () => {
  it("cannot format, link, mention or hide anything", () => {
    const nasty = "a\n# H\n[x](http://evil.test) <img src=x> @everyone `c` **b** owner/r#1 www.evil.test <!-- z --> ‮bidi &lt;";
    const text = plain(nasty);
    expect(text).not.toMatch(/\n|‮|@everyone|:\/\/|www\.evil/);
    expect(text).not.toMatch(/(^|[^\\])[[\]<>`*#&]/);
    expect(code("a`b\nc")).toBe("`a'b c`");
    expect(urlPath("a b/(x)[y]/#é?.ts")).toBe("a%20b/%28x%29%5By%5D/%23%C3%A9%3F.ts");
  });

  it("stays inside its place in both comments", () => {
    const v = violation(1, { file: "src/`](http://evil.test)\n## x.ts", message: "m --> \n# Approved by @admin", ruleId: "R\n# x", rationale: "<script>", fix: "``` @admin <script>" });
    for (const body of [renderInline(v), renderSummary({ fullName: "o/r", headSha: "h", outcome: outcome([v], { protectedChanges: ["voxium/architecture.json"] }), ruleChanges: ["\n# y @admin <script>"], pageUrl: null })]) {
      expect(body.split("\n").filter((l) => /^#+ /.test(l) && !/^###? ?❌|^#### |^### /.test(l))).toEqual([]);
      const outside = body.replace(/`[^`]*`/g, ""); // nothing inside code is a link, a mention or HTML
      expect(outside).not.toMatch(/(^|[^\\])<script|@admin|\]\(http:\/\/evil/);
      expect(body.match(/-->/g) ?? []).toHaveLength(body.includes("<!--") ? 1 : 0);
    }
  });
});
