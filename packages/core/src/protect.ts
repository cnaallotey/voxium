/**
 * Which files carry the rules, and how a change to them is recognised.
 * Shared by the CLI and the platform so both treat the same edits as architecture changes.
 */
export const ARCH_FILE_PATH = "voxium/architecture.json";
export const BASELINE_FILE_PATH = "voxium/baseline.json";
export const WORKFLOW_FILE_PATH = ".github/workflows/voxium.yml";

/** Files a change must not be able to alter in order to make itself pass. */
export const PROTECTED_FILES = [ARCH_FILE_PATH, BASELINE_FILE_PATH, WORKFLOW_FILE_PATH] as const;

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
