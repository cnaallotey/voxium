/** Finds the code in .vue single file components. */

import { TOO_MANY } from "./parse.js";

export interface VueScript {
  /** Start of its tag, and where the code in it starts and ends. */
  tag: number;
  start: number;
  end: number;
  lang: string;
  /** False when it may be something else that only looks like a script. */
  certain: boolean;
  /** The module that <script src> loads. */
  src?: string;
  /** Why it cannot be told what it loads. */
  problem?: string;
}

interface Tag {
  name: string;
  /** What it stands for, "&" when that is not known, and how often it is there. */
  lang: string;
  langs: number;
  src?: string;
  /** It has another src as well. */
  sources: number;
  /** After its ">". */
  end: number;
  closed: boolean;
  /** Some compilers end it earlier, at a "</". */
  odd: boolean;
  /** Each attribute with a value, its name in lower case, and where the value starts. */
  attributes: Attribute[];
}

interface Attribute {
  name: string;
  /** The name as it is written. Vue tells directives apart by case, so that V-PRE is no v-pre. */
  written: string;
  value: string;
  at: number;
}

/** Longer ones are too much for a regular expression. */
const MAX_NAME = 200;

const isLetter = (c: string | undefined) => c !== undefined && /[a-z]/i.test(c);
const SPACE = /[ \n\t\r\f/]*/y;
const NAME = /[^ \n\t\r\f/>]+/y;
const ATTRIBUTE = /.[^ \n\t\r\f=/>]*/sy;
const EQUALS = /[ \n\t\r\f]*(?:(=)[ \n\t\r\f]*)?/y;
const VALUE = /[^ \n\t\r\f>]*/y;

/** The opening tag at "<", or null when it does not end. */
function readTag(text: string, at: number): Tag | null {
  let p = at + 1;
  const read = (re: RegExp): string => {
    re.lastIndex = p;
    const found = re.exec(text)?.[0] ?? "";
    p += found.length;
    return found;
  };
  const tag: Tag = { name: read(NAME).toLowerCase(), lang: "", langs: 0, sources: 0, end: 0, closed: false, odd: false, attributes: [] };
  for (;;) {
    const closed = /\/[ \n\t\r\f]*$/.test(read(SPACE));
    if (p >= text.length) return null;
    if (text[p] === ">") return { ...tag, end: p + 1, closed };
    if (text[p] === "<" && text[p + 1] === "/") tag.odd = true;
    const written = read(ATTRIBUTE);
    const attribute = written.toLowerCase();
    let value = "";
    let at = p;
    if (read(EQUALS).includes("=")) {
      const quote = text[p];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, p + 1);
        if (close === -1) return null;
        value = text.slice(p + 1, close);
        at = p + 1;
        p = close + 1;
      } else {
        at = p;
        value = read(VALUE);
      }
    }
    tag.attributes.push({ name: attribute, written, value, at });
    if (attribute === "lang" && !tag.langs++) tag.lang = undecoded(value) ? "&" : unescapeHtml(value);
    if (attribute === "src" && !tag.sources++) tag.src = value;
  }
}

/** Named references that stand for a character of code. Any other one stands for none. */
const ENTITY: Record<string, string> = {
  amp: "&", period: ".", sol: "/", commat: "@", lowbar: "_", num: "#", colon: ":", quot: '"', apos: "'", lt: "<", gt: ">", lpar: "(", rpar: ")", lsqb: "[", rsqb: "]", lbrack: "[", rbrack: "]",
  lcub: "{", rcub: "}", lbrace: "{", rbrace: "}", comma: ",", semi: ";", excl: "!", quest: "?", equals: "=", plus: "+", ast: "*", midast: "*", dollar: "$", percnt: "%", grave: "`", bsol: "\\",
  hat: "^", vert: "|", verbar: "|", verticalline: "|", tab: "\t", newline: "\n", nbsp: "\u00a0",
};

function unescapeHtml(text: string): string {
  return text.replace(/&(?:#x([\da-f]+);?|#(\d+);?|([a-z]{1,10});)/gi, (all, hex: string, dec: string, name: string) => {
    if (name) return ENTITY[name.toLowerCase()] ?? all;
    const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/** Whether there is an "&" in an attribute that may stand for something, and it is not known for what. */
function undecoded(text: string): boolean {
  return /&(?![a-z\d]+=)[a-z#]/i.test(text.replace(/&(?:#x[\da-f]+;?|#\d+;?|[a-z]{1,10};)/gi, (e) => (unescapeHtml(e) === e ? e : "")));
}

/** The white space of HTML, which is less than that of a regular expression. */
const SPACES = "[ \\n\\t\\r\\f]";

/** The next "<name" of any case from p on, as a whole word, or -1. */
const opening = /<script(?=[ \n\t\r\f/>]|$)/gi;

function find(re: RegExp, text: string, p: number): number {
  re.lastIndex = p;
  return re.exec(text)?.index ?? -1;
}

/** The end of the text of an element, from p on. Compilers do not agree on what else than white space and ">" may follow "</name". */
function closing(name: string): (text: string, p: number) => { end: number; certain: boolean } {
  if (name.length > MAX_NAME) return () => ({ end: -1, certain: false });
  const escaped = name.replace(/[^a-z\d]/g, "\\$&");
  const strict = new RegExp(`</${escaped}(?=[ \\n\\t\\r\\f>])`, "gi");
  const loose = new RegExp(`[<\\x1c][/\\x0f]${escaped}(?=[^\\w-]|$)`, "gi");
  return (text, p) => {
    const end = find(strict, text, p);
    return { end, certain: end !== -1 && find(loose, text, p) === end };
  };
}

/** After the template that starts before p, or -1 when it does not end. */
function templateEnd(text: string, p: number): number {
  for (let depth = 1; ; ) {
    const at = text.indexOf("<", p);
    if (at === -1) return -1;
    if (text[at + 1] === "/") {
      if (CLOSES_TEMPLATE.test(text.slice(at, at + 100)) && --depth === 0) return at;
      p = skip(text, at);
      if (p === -1) return -1;
    } else if (text[at + 1] === "!" || text[at + 1] === "?") {
      p = skip(text, at);
      if (p === -1) return -1;
    } else if (isLetter(text[at + 1])) {
      const tag = readTag(text, at);
      if (!tag) return -1;
      if (tag.name === "template" && !tag.closed) depth++;
      p = tag.end;
    } else p = at + 1;
  }
}

/** After a comment, a declaration, an instruction or a closing tag, or -1 when it does not end. */
function skip(text: string, at: number): number {
  const ends = text.startsWith("<!--", at) ? "-->" : text.startsWith("<![CDATA[", at) ? "]]>" : ">";
  const close = text.indexOf(ends, at + 2); // "<!-->" is a whole comment
  return close === -1 ? -1 : close + ends.length;
}

const CLOSES_TEMPLATE = new RegExp(`^</${SPACES}*template(?:${SPACES}|[/>]|$)`, "i");
const MENTIONS_SCRIPT = /<script(?:[ \n\t\r\f/>]|$)/i;
const MENTIONS_TEMPLATE = new RegExp(`</?${SPACES}*template`, "i");
/** Text that is not taken for tags, inside of a template. */
const RAW_TEXT = /<(?:script|style|textarea|title)[ \n\t\r\f/>]|<!\[/i;

/** Whether {{ }} may hide where a template ends. */
function hidesTags(inside: string): boolean {
  for (let p = inside.indexOf("{{"); p !== -1; ) {
    const close = inside.indexOf("}}", p + 2);
    if (close === -1 || MENTIONS_TEMPLATE.test(inside.slice(p, close))) return true;
    p = inside.indexOf("{{", close + 2);
  }
  return false;
}

/** Where the content of a template is. Vue compiles the expressions in an HTML template into the module of the component. */
export interface VueTemplate {
  start: number;
  end: number;
  html: boolean;
  /** Its src, a file that is compiled in its place. */
  src?: string;
}

/** Where the content of a <style> is. Vue compiles what v-bind() in it has into the script of the component. */
export interface VueStyle {
  start: number;
  end: number;
}

type Scripts = { blocks: VueScript[]; templates: VueTemplate[]; styles: VueStyle[]; unparsed?: string };

const template = (start: number, end: number, tag: Tag): VueTemplate => ({ start, end, html: /^(?:html)?$/.test(tag.lang), ...(tag.src === undefined ? {} : { src: tag.src }) });

/**
 * The scripts of a component. Comments, templates and other blocks are stepped over, the way Vue does it. When it is not
 * certain where one of them ends, as in {{ "</template>" }}, whatever else looks like a script may be one too.
 */
export function vueScripts(content: string): Scripts {
  const blocks: VueScript[] = [];
  const templates: VueTemplate[] = [];
  const styles: VueStyle[] = [];
  let sure = true;
  /** A block had tags in it, which Vue 2 reads and later versions do not, so it may end later. */
  let mixed = false;
  for (let p = 0; ; ) {
    const at = content.indexOf("<", p);
    if (/\{\{|\$\{/.test(content.slice(p, at === -1 ? content.length : at))) sure = false;
    if (at === -1) break;
    if (/[/!?]/.test(content[at + 1] ?? "")) {
      const comment = content.startsWith("<!--", at);
      p = skip(content, at);
      // Nothing else of this kind belongs between blocks.
      if (!comment || p === -1 || (mixed && MENTIONS_SCRIPT.test(content.slice(at, p)))) sure = false;
      if (p === -1) break;
      continue;
    }
    if (!isLetter(content[at + 1])) {
      p = at + 1;
      continue;
    }
    const tag = readTag(content, at);
    if (!tag) return { blocks, templates, styles, unparsed: "ends inside a tag" };
    if (tag.odd || MENTIONS_SCRIPT.test(content.slice(at + 1, tag.end)) || MENTIONS_TEMPLATE.test(content.slice(at + 1, tag.end))) sure = false;
    if (tag.name === "script") {
      const { end, certain } = tag.closed ? { end: tag.end, certain: true } : closeScript(content, tag.end);
      blocks.push(script(content, at, tag, end, true));
      if (end === -1) return { blocks, templates, styles, unparsed: "has a <script> that does not end" };
      if (!certain || tag.odd) return { blocks, templates, styles, unparsed: "has a <script> of which it is not certain where it ends" };
      // A compiler that got here in another way may take these for tags.
      const inside = content.slice(tag.end, end);
      if (MENTIONS_SCRIPT.test(inside) || MENTIONS_TEMPLATE.test(inside)) sure = false;
      p = tag.closed ? end : skip(content, end);
    } else if (tag.closed) {
      if (tag.name === "template" && tag.src !== undefined) templates.push(template(tag.end, tag.end, tag));
      p = tag.end;
    } else {
      const html = tag.name === "template" && /^(?:html)?$/.test(tag.lang);
      if (tag.name === "template" && (tag.langs > 1 || tag.lang === "&" || (!html && /^html$/i.test(tag.lang)))) sure = false;
      const { end, certain } = html ? { end: templateEnd(content, tag.end), certain: true } : closing(tag.name)(content, tag.end);
      const inside = content.slice(tag.end, end === -1 ? content.length : end);
      if (tag.name === "template") templates.push(template(tag.end, end === -1 ? content.length : end, tag));
      if (tag.name === "style") styles.push({ start: tag.end, end: end === -1 ? content.length : end });
      if (end === -1 || !certain) sure = false;
      else if (html && (hidesTags(inside) || RAW_TEXT.test(inside))) sure = false;
      else if (mixed && MENTIONS_SCRIPT.test(inside)) sure = false;
      mixed ||= !html && tag.name !== "style" && inside.includes("<");
      if (end === -1) break;
      p = skip(content, end);
    }
    if (p === -1) {
      sure = false;
      break;
    }
  }
  return sure ? { blocks, templates, styles } : withOthers(content, blocks);
}

const closeScript = closing("script");
const LANGUAGE = /^(?:|[cm]?[jt]sx?)$/i;

function script(content: string, at: number, tag: Tag, end: number, certain: boolean): VueScript {
  const found: VueScript = { tag: at, start: tag.end, end: end === -1 ? content.length : end, lang: tag.lang.toLowerCase(), certain };
  if (tag.langs > 1 || !LANGUAGE.test(tag.lang)) found.problem = "has a <script> in a language that is not known";
  if (tag.src === undefined) return found;
  if (tag.sources > 1 || undecoded(tag.src)) found.problem ??= "has a <script> with a src that cannot be read";
  return { ...found, src: unescapeHtml(tag.src).trim() };
}

/** Along with the scripts found, all else that may be one, each up to the next end of one. */
function withOthers(content: string, found: VueScript[]): Scripts {
  const known = new Map(found.map((b) => [b.tag, b]));
  const blocks: VueScript[] = [];
  const templates: VueTemplate[] = [];
  const styles: VueStyle[] = [];
  let total = 0;
  for (let at = find(opening, content, 0); at !== -1; at = find(opening, content, at + 1)) {
    const tag = readTag(content, at);
    const block = tag && (known.get(at) ?? script(content, at, tag, tag.closed ? tag.end : closeScript(content, tag.end).end, false));
    if (block) blocks.push(block);
    total += (block?.end ?? content.length) - at;
    if (total > content.length * 4) return { blocks, templates, styles, unparsed: TOO_MANY };
  }
  // So is all else that may be a template, each up to where it would end.
  for (let at = find(OPENS_TEMPLATE, content, 0); at !== -1; at = find(OPENS_TEMPLATE, content, at + 1)) {
    const tag = readTag(content, at);
    if (!tag) continue;
    if (tag.closed) {
      if (tag.src !== undefined) templates.push(template(tag.end, tag.end, tag));
      continue;
    }
    const end = templateEnd(content, tag.end);
    templates.push(template(tag.end, end === -1 ? content.length : end, tag));
    total += (end === -1 ? content.length : end) - at;
    if (total > content.length * 4) return { blocks, templates, styles, unparsed: TOO_MANY };
  }
  // And all that may be a style.
  for (let at = find(OPENS_STYLE, content, 0); at !== -1; at = find(OPENS_STYLE, content, at + 1)) {
    const tag = readTag(content, at);
    if (!tag || tag.closed) continue;
    const { end } = closeStyle(content, tag.end);
    styles.push({ start: tag.end, end: end === -1 ? content.length : end });
    total += (end === -1 ? content.length : end) - at;
    if (total > content.length * 4) return { blocks, templates, styles, unparsed: TOO_MANY };
  }
  return { blocks, templates, styles };
}

const OPENS_TEMPLATE = /<template(?=[ \n\t\r\f/>]|$)/gi;
const OPENS_STYLE = /<style(?=[ \n\t\r\f/>]|$)/gi;
const closeStyle = closing("style");

/** An expression of a template, or the like, as Vue reads it, with what it is for. */
export interface TemplateExpression {
  /** "for": "a in b", "slot": parameters, "on": a handler or statements. */
  kind: "expression" | "on" | "for" | "slot";
  text: string;
  /** Where it is in the component. */
  at: number;
  /** It has a character reference that is not known, so what it says is not known either. */
  unknown: boolean;
}

function expression(kind: TemplateExpression["kind"], raw: string, at: number): TemplateExpression {
  if (!raw.includes("&")) return { kind, text: raw, at, unknown: false };
  return { kind, text: unescapeHtml(raw), at, unknown: undecoded(raw) };
}

/** Every expression in an HTML template: {{ }}, and the values and dynamic arguments of directives. */
export function templateExpressions(content: string, { start, end }: VueTemplate): TemplateExpression[] {
  const out: TemplateExpression[] = [];
  let ends: Map<string, number[]> | undefined;
  // The next "<" and "{{", which are looked for again only once they are behind, so that it takes linear time.
  let lt = -2;
  let open = -2;
  for (let p = start; p < end; ) {
    if (lt !== -1 && lt < p) lt = content.indexOf("<", p);
    if (open !== -1 && open < p) open = content.indexOf("{{", p);
    const next = lt === -1 || lt >= end ? end : lt;
    if (open !== -1 && open < next) {
      const close = content.indexOf("}}", open + 2);
      const stop = close === -1 || close > end ? end : close;
      out.push(expression("expression", content.slice(open + 2, stop), open + 2));
      p = stop + 2;
      continue;
    }
    if (next === end) break;
    const c = content[lt + 1];
    if (c === "!" || c === "/" || c === "?") {
      p = skip(content, lt);
      if (p === -1) break;
      continue;
    }
    if (!isLetter(c)) {
      p = lt + 1;
      continue;
    }
    const tag = readTag(content, lt);
    if (!tag) break;
    // Only a v-pre in lower case makes it text. Other names are taken in lower case, so that more is read rather than less.
    if (tag.attributes.some((a) => a.written === "v-pre")) {
      // Vue takes the element and what is in it for text. It may end at the first "</" and its name, never later.
      ends ??= endTags(content, start, end);
      const close = tag.closed || VOID.has(tag.name) ? -1 : after(ends.get(tag.name) ?? [], tag.end);
      p = close === -1 ? tag.end : close;
      continue;
    }
    for (const { name, value, at } of tag.attributes) {
      if (!/^(?:v-|[:@#.])/.test(name)) continue;
      const open = name.indexOf("[");
      const close = name.lastIndexOf("]");
      if (open !== -1 && close > open) out.push(expression("expression", name.slice(open + 1, close), at));
      if (!value.trim()) continue;
      const kind = name === "v-for" ? "for" : /^(?:v-slot|#)/.test(name) ? "slot" : /^(?:v-on|@)/.test(name) ? "on" : "expression";
      out.push(expression(kind, value, at));
    }
    p = tag.end;
  }
  return out;
}

/** Elements that have no content, and no end. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/** Where each end tag is, by its name in lower case. */
function endTags(content: string, start: number, end: number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const re = /<\/([^ \n\t\r\f/>]*)/g;
  re.lastIndex = start;
  for (let m = re.exec(content); m && m.index < end; m = re.exec(content)) {
    const name = m[1].toLowerCase();
    const list = out.get(name);
    if (list) list.push(m.index);
    else out.set(name, [m.index]);
  }
  return out;
}

/** The first of some sorted positions from p on, or -1. */
function after(list: number[], p: number): number {
  let lo = 0;
  for (let hi = list.length; lo < hi; ) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < p) lo = mid + 1;
    else hi = mid;
  }
  return list[lo] ?? -1;
}

/** Comments in a style, which Vue takes out before it looks for v-bind(), in one version or another. */
const STYLE_COMMENTS = [/(?!)/g, /\/\*[^]*?\*\//g, /\/\*[^]*?\*\/|\/\/.*/g];
const V_BIND = /v-bind\s*\(/g;

/** The end of what v-bind( has, at its ")", as Vue finds it, or -1. Null when that would take too long. */
function bindingEnd(text: string, from: number, budget: { left: number }): number | null {
  let quote = "";
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (--budget.left < 0) return null;
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && depth-- === 0) return i;
  }
  return -1;
}

/**
 * Every expression of v-bind() in a style, each way that Vue versions read it. Null when there are too many that do not
 * end to look through them.
 */
export function styleExpressions(content: string, { start, end }: VueStyle): TemplateExpression[] | null {
  const out: TemplateExpression[] = [];
  const seen = new Set<string>();
  const css = content.slice(start, end);
  const budget = { left: 8 * css.length + 10_000 };
  for (const comments of STYLE_COMMENTS) {
    // The style without its comments, and where each part of it is in the component.
    let text = "";
    const parts: Array<[number, number]> = [];
    let done = 0;
    for (const m of css.matchAll(comments)) {
      parts.push([text.length, start + done]);
      text += css.slice(done, m.index);
      done = m.index + m[0].length;
    }
    parts.push([text.length, start + done]);
    text += css.slice(done);
    const at = (i: number) => {
      let lo = 0;
      for (let hi = parts.length - 1; lo < hi; ) {
        const mid = (lo + hi + 1) >> 1;
        if (parts[mid][0] <= i) lo = mid;
        else hi = mid - 1;
      }
      return parts[lo][1] + i - parts[lo][0];
    };
    for (const m of text.matchAll(V_BIND)) {
      const from = m.index + m[0].length;
      const close = bindingEnd(text, from, budget);
      if (close === null) return null;
      if (close === -1) continue;
      let raw = text.slice(from, close).trim();
      if (/^(?:'[^]*'|"[^]*")$/.test(raw)) raw = raw.slice(1, -1);
      const key = `${at(from)}:${raw}`;
      if (!seen.has(key)) out.push({ kind: "expression", text: raw, at: at(from), unknown: false });
      seen.add(key);
    }
  }
  return out;
}

/** The scripts, with everything else blanked. An import stands in for <script src>. */
export function blankExcept(content: string, blocks: VueScript[]): string {
  const parts: string[] = [];
  const blank = (from: number, to: number) => content.slice(from, to).replace(/[^\n]+/g, (line) => " ".repeat(line.length));
  let done = 0;
  for (const b of blocks) {
    if (b.start < done || (b.start === b.end && !b.src)) continue; // within the one before, or empty
    parts.push(blank(done, b.tag));
    const tag = blank(b.tag, b.start);
    parts.push(b.src ? `import ${JSON.stringify(b.src)};${tag.replace(/ /g, "")}` : tag, content.slice(b.start, b.end));
    done = b.end;
  }
  parts.push(blank(done, content.length));
  return parts.join("");
}
