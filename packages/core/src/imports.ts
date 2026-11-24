/**
 * Small, dependency free import scanner. It runs anywhere (Node, Workers, browsers).
 * It blanks out comments and template literals, then finds module specifiers.
 * It is a scanner, not a parser, so exotic code (imports inside regex literals) can be missed.
 */

export function blankCommentsAndTemplates(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && code[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && d === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
    } else if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < n && code[i] !== c && code[i] !== "\n") {
        if (code[i] === "\\") {
          out += code[i];
          i++;
        }
        if (i < n) out += code[i];
        i++;
      }
      if (i < n) {
        out += code[i];
        i++;
      }
    } else if (c === "`") {
      out += "`";
      i++;
      while (i < n && code[i] !== "`") {
        if (code[i] === "\\") {
          out += " ";
          i++;
        }
        if (i < n) out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "`";
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const PATTERNS = [
  // import x from "a", import { x } from "a", export * from "a", export type { X } from "a"
  /\b(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"'\n]+)["']/g,
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
