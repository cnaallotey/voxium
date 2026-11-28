/** One step of a glob. DIRS is "**\/" and takes two steps: it may be left out, and once entered it has to end in a slash. */
const CHAR = 0;
const ONE = 1;
const STAR = 2;
const ANY = 3;
const DIRS = 4;
const IN_DIRS = 5;

const NEWLINE = /[\n\r\u2028\u2029]/;
const isNewline = (c: string) => c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";

/**
 * Whether a glob (supports **, *, ?) matches a repo relative posix path. Globs come from pull requests, so this follows
 * every way to match at once, which takes no longer than the two lengths multiplied, whatever the glob.
 */
export function matchesGlob(path: string, glob: string): boolean {
  return compileGlob(glob)(path);
}

/**
 * What every path a glob matches has, which rules most paths out without following the glob: the text before its first
 * wildcard, the text after its last one, and the start of the longest run of plain characters between them, which has to
 * come after the prefix. Literal is a glob without wildcards, which only the path equal to it matches.
 */
export interface GlobAnchors {
  prefix: string;
  suffix: string;
  inner: string;
  literal: boolean;
}

/**
 * The most characters of a glob's plain text in the middle that are looked for. Looking for a longer text costs more for
 * each character of the path, so a glob with a long one could cost far more than its budget says; the start of the text
 * rules out about as many paths.
 */
export const MAX_INNER = 16;

export function globAnchors(glob: string): GlobAnchors {
  let start = 0;
  while (start < glob.length && glob[start] !== "*" && glob[start] !== "?") start++;
  const prefix = glob.slice(0, start);
  if (start === glob.length) return { prefix, suffix: "", inner: "", literal: true };
  let tail = glob.length;
  while (tail > start && glob[tail - 1] !== "*" && glob[tail - 1] !== "?") tail--;
  // The slash of "**/" belongs to the wildcard, which may match nothing.
  const suffix = glob.slice(glob.startsWith("**/", tail - 2) ? tail + 1 : tail);
  // Read as compileGlob reads it: "**/" is one wildcard with its slash, "**" another and "*" a third.
  let inner = "";
  let run = "";
  for (let i = start; i < tail; i++) {
    if (glob[i] !== "*" && glob[i] !== "?") {
      run += glob[i];
      continue;
    }
    if (run.length > inner.length) inner = run;
    run = "";
    if (glob[i] === "*" && glob[i + 1] === "*") i += glob[i + 2] === "/" ? 2 : 1;
  }
  if (run.length > inner.length) inner = run;
  return { prefix, suffix, inner: inner.slice(0, MAX_INNER), literal: false };
}

/**
 * Whether a path has what a glob's anchors ask for. The start and the end are compared as slices, which costs a fraction
 * of what startsWith and endsWith cost for long ones when there are many globs.
 */
export function passesAnchors(path: string, a: GlobAnchors): boolean {
  const p = a.prefix.length;
  const s = a.suffix.length;
  return (
    path.length >= p + s &&
    (!p || path.slice(0, p) === a.prefix) &&
    (!s || path.slice(path.length - s) === a.suffix) &&
    (!a.inner || path.includes(a.inner, p))
  );
}

/** matchesGlob for one glob and many paths, which reads the glob once. */
export function compileGlob(glob: string): (path: string) => boolean {
  const anchors = globAnchors(glob);
  const { prefix } = anchors;
  const start = prefix.length;
  if (anchors.literal) return (path) => path === prefix;

  const steps: number[] = [];
  const chars: string[] = [];
  const step = (kind: number, char = "") => {
    steps.push(kind);
    chars.push(char);
  };
  for (let i = start; i < glob.length; i++) {
    if (glob[i] === "?") step(ONE);
    else if (glob[i] !== "*") step(CHAR, glob[i]);
    else if (glob[i + 1] !== "*") step(STAR);
    else if (glob[i + 2] !== "/") {
      step(ANY);
      i++;
    } else {
      step(DIRS);
      step(IN_DIRS);
      i += 2;
    }
  }
  const end = steps.length;
  if (end === 1 && steps[0] === ANY) return (path) => path.length >= start && path.slice(0, start) === prefix && !NEWLINE.test(path.slice(start));
  return (path) => passesAnchors(path, anchors) && follow(path, start, steps, chars);
}

function follow(path: string, start: number, steps: number[], chars: string[]): boolean {
  const end = steps.length;
  let now: number[] = [];
  let next: number[] = [];
  const seen = new Array<number>(end + 1).fill(-1); // the position in the path at which a step was last reached
  /** Reach a step, and those behind it that need nothing. */
  const reach = (into: number[], at: number, s: number) => {
    while (seen[s] !== at) {
      seen[s] = at;
      into.push(s);
      if (s < end && (steps[s] === STAR || steps[s] === ANY)) s++;
      else if (s < end && steps[s] === DIRS) {
        reach(into, at, s + 1); // goes no deeper, because IN_DIRS needs a slash
        s += 2;
      } else return;
    }
  };
  reach(now, start, 0);
  for (let i = start; i < path.length && now.length; i++) {
    const c = path[i];
    next.length = 0;
    for (const s of now) {
      if (s === end) continue;
      const kind = steps[s];
      if (kind === CHAR ? c === chars[s] : kind === ONE && c !== "/") reach(next, i + 1, s + 1);
      else if (kind === STAR ? c !== "/" : kind === ANY && !isNewline(c)) reach(next, i + 1, s);
      else if (kind === IN_DIRS) {
        if (!isNewline(c)) reach(next, i + 1, s);
        if (c === "/") reach(next, i + 1, s + 1);
      }
    }
    [now, next] = [next, now];
  }
  return now.includes(end);
}

export interface GlobMatcher {
  test(path: string): boolean;
}

/** The name is from when globs became a RegExp, which could take exponential time. */
export function globToRegExp(glob: string): GlobMatcher {
  return { test: (path) => matchesGlob(path, glob) };
}

/** Whether a path matches any of the globs. For many paths use compileGlobs, which reads each glob once. */
export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}

/**
 * matchesAny for one list of globs and many paths. Reading a glob costs as much as its length, so a check that read
 * each glob again for each file would cost the length of the globs times the files, which no budget for matching counts.
 */
export function compileGlobs(globs: string[]): (path: string) => boolean {
  const matchers = globs.map(compileGlob);
  if (!matchers.length) return () => false;
  if (matchers.length === 1) return matchers[0];
  return (path) => matchers.some((m) => m(path));
}
