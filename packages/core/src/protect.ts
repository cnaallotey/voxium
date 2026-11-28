/**
 * Which files carry the rules, and how a change to them is recognised.
 * Shared by the CLI and the platform so both treat the same edits as architecture changes.
 */
export const ARCH_FILE_PATH = "voxium/architecture.json";
export const BASELINE_FILE_PATH = "voxium/baseline.json";
export const WORKFLOW_FILE_PATH = ".github/workflows/voxium.yml";
/** The GitLab job, for a .gitlab-ci.yml that includes it. */
export const GITLAB_FILE_PATH = "voxium/gitlab-ci.yml";

/** Files a change must not be able to alter in order to make itself pass. */
export const PROTECTED_FILES = [ARCH_FILE_PATH, BASELINE_FILE_PATH, WORKFLOW_FILE_PATH, GITLAB_FILE_PATH] as const;

export const BLOCK_START = "<!-- voxium:start -->";
export const BLOCK_END = "<!-- voxium:end -->";
export const CURSOR_RULES_PATH = ".cursor/rules/voxium.mdc";
/** What Cursor needs to read the rules in every chat. */
export const CURSOR_FRONTMATTER = "---\ndescription: Architecture rules of this repository, enforced by Voxium\nalwaysApply: true\n---\n";
/** Files that tell coding agents the rules in a block Voxium manages. */
export const AGENT_FILES = ["CLAUDE.md", "AGENTS.md", CURSOR_RULES_PATH] as const;

/** File contents by path. Null means the file does not exist. */
export type ProtectedContents = Record<string, string | null | undefined>;

/** Violation ids in a baseline file. A missing file accepts nothing. Null means the file is malformed. */
export function parseBaseline(text: string | null | undefined): string[] | null {
  if (text === null || text === undefined) return [];
  try {
    const ids = (JSON.parse(text) as { violations?: unknown } | null)?.violations;
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) return null;
    return ids as string[];
  } catch {
    return null;
  }
}

/**
 * The baseline to judge a change by. A change may drop accepted debt without asking, because that
 * only makes the check stricter. Anything that adds debt is ignored in favour of the trusted baseline.
 */
export function tightenBaseline(trusted: string | null | undefined, proposed: string | null | undefined): string[] {
  const a = parseBaseline(trusted) ?? [];
  const b = parseBaseline(proposed);
  if (b === null) return a;
  const known = new Set(a);
  return b.every((id) => known.has(id)) ? b : a;
}

/**
 * Protected files a change really alters. A file counts when it differs from the point the change
 * branched from and from the current base, so a branch that is merely behind is not blamed.
 */
export function findProtectedChanges(base: ProtectedContents, mergeBase: ProtectedContents, head: ProtectedContents): string[] {
  const get = (c: ProtectedContents, p: string) => c[p] ?? null;
  return PROTECTED_FILES.filter((p) => {
    const h = get(head, p);
    if (h === get(mergeBase, p) || h === get(base, p)) return false;
    if (p === BASELINE_FILE_PATH) {
      const ids = parseBaseline(h);
      const trusted = new Set(parseBaseline(get(base, p)) ?? []);
      if (ids !== null && ids.every((id) => trusted.has(id))) return false; // only removes debt
    }
    return true;
  });
}

export interface BlockState {
  /**
   * current: one block, in the open, as expected. stale: one block in the open, but another one. missing: no marker.
   * altered: markers that are not exactly one block in the open, such as a second block, or one inside a code fence.
   */
  status: "current" | "stale" | "missing" | "altered";
  /** What the block is made of. Two versions of a file with the same key have the same block. */
  key: string;
}

/** A marker however it is spelled: in another case or width, with invisible characters or accents, or spaces around the colon. */
const MARKER = /voxium\s*:\s*(?:start|end)/i;
// ASCII has no marks or format characters, and NFKD leaves it as it is, so only other lines are normalized.
export const looksLikeMarker = (line: string) => MARKER.test(/^[\x00-\x7f]*$/.test(line) ? line : line.normalize("NFKD").replace(/[\p{M}\p{Cf}]/gu, ""));

/** Whether a line closes a code fence opened with `len` of `ch`: up to three spaces, at least as many of them, then only spaces. */
function closesFence(line: string, ch: string, len: number): boolean {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  let n = 0;
  while (line[i + n] === ch) n++;
  return n >= len && /^\s*$/.test(line.slice(i + n));
}

/** Whether text leaves an HTML comment open. */
const opensComment = (s: string) => {
  const at = s.lastIndexOf("<!--");
  return at !== -1 && !s.includes("-->", at + 4);
};

/** The fence a line opens, as up to three spaces and then at least three backticks or tildes, or null. */
function opensFence(line: string): { ch: string; len: number } | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  const ch = line[i];
  if (ch !== "`" && ch !== "~") return null;
  let n = 0;
  while (line[i + n] === ch) n++;
  return n >= 3 ? { ch, len: n } : null;
}

/** The line that opens a code fence or an HTML comment that is still open at line `end`, if any. */
function hiddenFrom(lines: string[], end: number): number | null {
  let fence: { ch: string; len: number; at: number } | null = null;
  let comment: number | null = null;
  for (let i = 0; i < end; i++) {
    const line = lines[i];
    if (fence) {
      if (closesFence(line, fence.ch, fence.len)) fence = null;
      continue;
    }
    if (comment !== null) {
      const close = line.indexOf("-->");
      if (close === -1) continue;
      comment = opensComment(line.slice(close + 3)) ? i : null;
      continue;
    }
    const open = opensFence(line);
    if (open) fence = { ...open, at: i };
    else if (opensComment(line)) comment = i;
  }
  return fence?.at ?? comment;
}

/** A marker anywhere in a text, within one line. */
const MARKERS = /voxium[^\S\n]*:[^\S\n]*(?:start|end)/gi;

/**
 * The lines of a text, without the carriage return git may add at their ends, and those that look like a marker. The
 * text is read as a whole, not line by line, so that a file of millions of short lines costs little: normalizing it does
 * not add or remove a line break, so the lines are where they were.
 */
function scan(text: string | null | undefined): { lines: string[]; markers: number[] } {
  const clean = (text ?? "").replace(/\r(?=\n|$)/g, "");
  const lines = clean.split("\n");
  const search = /^[\x00-\x7f]*$/.test(clean) ? clean : clean.normalize("NFKD").replace(/[\p{M}\p{Cf}]/gu, "");
  const markers: number[] = [];
  let line = 0;
  let from = 0;
  for (const m of search.matchAll(MARKERS)) {
    for (let at = search.indexOf("\n", from); at !== -1 && at < m.index; at = search.indexOf("\n", at + 1)) {
      line++;
      from = at + 1;
    }
    if (markers.at(-1) !== line) markers.push(line);
  }
  return { lines, markers };
}

function stateOf({ lines, markers }: { lines: string[]; markers: number[] }, expected: string): BlockState {
  if (!markers.length) return { status: "missing", key: "" };
  const [s, e] = markers;
  const hidden = hiddenFrom(lines, s);
  if (markers.length === 2 && lines[s] === BLOCK_START && lines[e] === BLOCK_END && hidden === null) {
    const block = lines.slice(s, e + 1).join("\n");
    return { status: block === expected ? "current" : "stale", key: `block\n${block}` };
  }
  return { status: "altered", key: `altered\n${lines.slice(hidden ?? s, markers[markers.length - 1] + 1).join("\n")}` };
}

/**
 * The managed block of a file. Only exactly one start marker line and one end marker line after it, outside any code
 * fence or HTML comment, make a block. Anything else that looks like a marker makes the file altered, and then
 * everything from the first marker (or what hides it) to the last one counts as the block, so that a second block, a
 * moved marker or a fence around the block is a change to it, while text outside it never is.
 */
export function blockState(text: string | null | undefined, expected: string): BlockState {
  return stateOf(scan(text), expected);
}

/**
 * blockState for an agent file. Voxium writes the whole Cursor file, and its frontmatter decides whether Cursor reads
 * the rules at all, so there what comes before the block is part of it.
 */
export function agentFileState(path: string, text: string | null | undefined, block: string): BlockState {
  const scanned = scan(text);
  const state = stateOf(scanned, block);
  if (path !== CURSOR_RULES_PATH || state.status === "missing") return state;
  const front = scanned.lines.slice(0, scanned.markers[0]).join("\n");
  const same = `${front}\n` === CURSOR_FRONTMATTER;
  return { status: same || state.status === "altered" ? state.status : "stale", key: `${front}\n${state.key}` };
}

/** How a change to the block of an agent file is named among the protected changes. */
export const blockLabel = (path: string) => `${path} (Voxium block)`;
export const isBlockLabel = (change: string) => change.endsWith(" (Voxium block)");

/** Agent files whose block is not the expected one. Only these can have been altered by a change. */
export function blocksToCompare(head: ProtectedContents, block: string): string[] {
  return AGENT_FILES.filter((p) => agentFileState(p, head[p], block).status !== "current");
}

/**
 * Of those, the ones whose block a change altered, compared with the point it branched from, as protected changes. A
 * block that is merely stale, because the rules or the way Voxium writes them changed since, is left alone.
 */
export function changedBlocks(paths: string[], mergeBase: ProtectedContents, head: ProtectedContents, block: string): string[] {
  return paths.filter((p) => agentFileState(p, mergeBase[p], block).key !== agentFileState(p, head[p], block).key).map(blockLabel);
}
