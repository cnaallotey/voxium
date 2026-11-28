/** Text from a pull request, made safe to put in Markdown: one line, no formatting, HTML, links, mentions or references. */
export function plain(text: string): string {
  return text
    .replace(/[\s\p{C}\p{Z}]+/gu, " ")
    .trim()
    .replace(/[\\`*_{}[\]<>#|~!&]/g, "\\$&")
    .replace(/@/g, "@\u2060")
    .replace(/:\/\//g, ":\u2060//")
    .replace(/www\./gi, (w) => `${w.slice(0, 3)}\u2060.`);
}

/** A name shown as code. Mentions and links do not work inside it. */
export function code(text: string): string {
  return `\`${text.replace(/[\s\p{C}\p{Z}]+/gu, " ").replace(/`/g, "'").trim() || " "}\``;
}

/** A path as part of a URL inside a Markdown link. */
export function urlPath(path: string): string {
  return path.split("/").map((p) => encodeURIComponent(p).replace(/[()!'*~_]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}
