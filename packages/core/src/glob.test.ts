import { describe, expect, it } from "vitest";
import { compileGlobs, globAnchors, globToRegExp, matchesAny, matchesGlob } from "./glob.js";

/** What globs meant when they became a RegExp, which is what they mean still. */
function oldRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) [out, i] = [`${out}(?:.*/)?`, i + 3];
    else if (glob.startsWith("**", i)) [out, i] = [`${out}.*`, i + 2];
    else if (glob[i] === "*") [out, i] = [`${out}[^/]*`, i + 1];
    else if (glob[i] === "?") [out, i] = [`${out}[^/]`, i + 1];
    else [out, i] = [out + glob[i].replace(/[.+^${}()|[\]\\]/g, "\\$&"), i + 1];
  }
  return new RegExp(`^${out}$`);
}

function random(seed: number): (n: number) => number {
  let s = seed;
  return (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.floor((s / 2 ** 32) * n);
  };
}

describe("globs", () => {
  it("mean the same as before, on generated globs and paths", () => {
    const pick = random(7);
    const parts = ["a", "b", "ab", "/", "/", "*", "*", "**", "**/", "?", ".", "a/", "/b", "{", "[", "\n", " "];
    const text = ["a", "b", "ab", "/", "/", "a/", "/b", ".", "b.a", "{", "[", "\n", " "];
    const join = (from: string[], max: number) => Array.from({ length: pick(max) }, () => from[pick(from.length)]).join("");
    let matched = 0;
    for (let i = 0; i < 20_000; i++) {
      const glob = join(parts, 8);
      // Half of the paths are the glob itself with something in place of what is variable, so that many match.
      const path = i % 2 ? join(text, 8) : glob.replace(/\*\*\/?|\*|\?/g, () => join(text, 4));
      const expected = oldRegExp(glob).test(path);
      expect(matchesGlob(path, glob), JSON.stringify([path, glob])).toBe(expected);
      expect(globToRegExp(glob).test(path)).toBe(expected);
      if (expected) matched++;
    }
    expect(matched).toBeGreaterThan(5000);
  });

  it("mean what people write them for", () => {
    for (const [path, glob, is] of [
      ["src/a/b.ts", "src/**", true], ["src", "src/**", false], ["src/b.ts", "src/**/b.ts", true], ["src/a/c/b.ts", "src/**/b.ts", true], ["src/ab.ts", "src/**/b.ts", false],
      ["a/b/c", "a/*", false], ["a.ts", "*.ts", true], ["a/a.ts", "*.ts", false], ["a/a.ts", "**/*.ts", true], ["a.ts", "**/*.ts", true], ["src/[id]/a.ts", "src/[id]/**", true], ["", "", true], ["a", "", false],
    ] as const) expect(matchesGlob(path, glob), `${path} ${glob}`).toBe(is);
    // The plain text between wildcards rules paths out before the glob is followed, read as the glob is read.
    for (const [path, glob, is] of [
      ["x1", "****/x*", true], ["a/x1", "****/x*", true], ["src/a/__tests__/b.ts", "**/__tests__/**", true], ["src/a/__tests_/b.ts", "**/__tests__/**", false],
      ["__tests__/", "**/__tests__/**", true], ["src/__tests__", "src/**/__tests__/**", false], ["ab/cab", "a*/c*b", true], ["ab/cb", "a*/c?b", false], ["src/x.ab", "src/*.a?", true],
    ] as const) expect(matchesGlob(path, glob), `${path} ${glob}`).toBe(is);
    expect(globAnchors("src/**/__tests__/*.ts")).toEqual({ prefix: "src/", suffix: ".ts", inner: "__tests__/", literal: false });
    expect(globAnchors("****/x*")).toEqual({ prefix: "", suffix: "", inner: "x", literal: false });
    expect(globAnchors("src/a.ts")).toEqual({ prefix: "src/a.ts", suffix: "", inner: "", literal: true });
    // Only the start of a long plain text is looked for, which costs the same whatever its length.
    expect(globAnchors(`src/*${"abcdefghij".repeat(4)}*`).inner).toBe("abcdefghijabcdef");
    for (const [path, is] of [[`src/x${"abcdefghij".repeat(4)}y`, true], [`src/x${"abcdefghij".repeat(3)}abcdefghiy`, false], [`src/${"abcdefghij".repeat(2)}`, false]] as const) {
      expect(matchesGlob(path, `src/*${"abcdefghij".repeat(4)}*`), path).toBe(is);
    }
    expect(matchesAny("a/b", ["c", "a/*"])).toBe(true);
    expect(matchesAny("a/b", [])).toBe(false);
  });

  it("take no time, however they are written", () => {
    const hostile: Array<[string, string]> = [
      ["a/".repeat(30), `${"**/".repeat(30)}b`],
      ["a/".repeat(200), `${"**/".repeat(200)}b`],
      ["a".repeat(2000), `${"*a".repeat(40)}b`],
      ["a".repeat(2000), `${"**a".repeat(40)}b`],
      ["a/".repeat(500), `${"**/?*".repeat(20)}/b`],
    ];
    const ms = (since: NodeJS.CpuUsage) => {
      const { user, system } = process.cpuUsage(since);
      return (user + system) / 1000;
    };
    const start = process.cpuUsage();
    for (const [path, glob] of hostile) expect(matchesGlob(path, glob)).toBe(false);
    const all = ms(start);
    const first = process.cpuUsage();
    expect(matchesGlob("a/".repeat(30), `${"**/".repeat(30)}b`)).toBe(false); // 15 seconds as a RegExp
    expect(ms(first)).toBeLessThan(50);
    expect(all).toBeLessThan(2000);
  });
});

describe("a list of globs read once", () => {
  it("matches what matchesAny matches, for none, one and many globs", () => {
    const paths = ["src/a.ts", "src/ui/b.tsx", "lib/x/y.js", "a\nb.ts", "", "src/ui", "docs/readme.md"];
    const lists = [[], ["src/**"], ["**/*.tsx", "lib/*/y.js"], ["src/?.ts", "docs/*", "nothing"], ["src/ui", "**"], ["*"]];
    for (const globs of lists) {
      const matches = compileGlobs(globs);
      for (const p of paths) expect([globs, p, matches(p)]).toEqual([globs, p, matchesAny(p, globs)]);
    }
  });
});
