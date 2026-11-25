/**
 * Small, dependency free import scanner. It runs anywhere (Node, Workers, browsers).
 * It blanks out comments and template literals, then finds module specifiers.
 * It is a scanner, not a parser, so exotic code (imports inside regex literals) can be missed.
 */

export function blankCommentsAndTemplates(code: string): string {
  const parts: string[] = [];
  const n = code.length;
  let kept = 0; // start of the run that is copied as it is
  let i = 0;
  // Blank from..to, keeping newlines so positions stay the same.
  const blank = (from: number, to: number) => {
    parts.push(code.slice(kept, from), code.slice(from, to).replace(/[^\n]/g, " "));
    kept = to;
  };
  while (i < n) {
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i);
      const end = nl === -1 ? n : nl;
      blank(i, end);
      i = end;
    } else if (c === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && code[i] !== c && code[i] !== "\n") i += code[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "`") {
      const start = ++i;
      while (i < n && code[i] !== "`") i += code[i] === "\\" ? 2 : 1;
      i = Math.min(i, n);
      blank(start, i);
      i++;
    } else {
      i++;
    }
  }
  parts.push(code.slice(kept));
  return parts.join("");
}

const PATTERNS = [
  // import x from "a", import { x } from "a", export * from "a", export type { X } from "a"
  // Never reads past another import or export keyword: the last one before "from" is enough to match, and
  // without that limit a file with many of them takes quadratic time.
  /\b(?:import|export)\b(?:(?!\b(?:import|export)\b)[^;'"`])*?\bfrom\s*["']([^"'\n]+)["']/g,
  // import "a"
  /\bimport\s*["']([^"'\n]+)["']/g,
  // import("a")
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  // require("a")
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];

export function extractImports(code: string): string[] {
  const clean = blankCommentsAndTemplates(code);
  const found = new Set<string>();
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (const m of clean.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}

/** Pull the code out of a .vue single file component. */
export function extractVueScript(content: string): string {
  const blocks = [...content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  return blocks.map((b) => b[1]).join("\n");
}
