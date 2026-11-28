import { createHash } from "node:crypto";
import type { ChangedLines, PrCheckOutcome } from "./analysis";
import { getEnv, type Env } from "./env";
import {
  createIssueComment,
  createReview,
  deleteIssueComment,
  getPull,
  listReviewComments,
  updateIssueComment,
  updateReviewComment,
  type GhPullFile,
} from "./github";
import { code, plain, urlPath } from "./markdown";
import type { PrEvent } from "./repo-job";
import { claimComment, listComments, releaseComment, setComment } from "./store";

type NewViolation = PrCheckOutcome["newViolations"][number];

const MAX_INLINE = 20;
const MAX_LISTED = 40;
const MAX_BODY = 60_000;
const SUMMARY = "summary";
const inlineKind = (v: NewViolation) => `inline:${v.id}`;
const marker = (kind: string) => `<!-- voxium:${createHash("sha256").update(kind).digest("hex").slice(0, 24)} -->`;

function patchLines(patch: string | undefined): Array<{ line: number; added: boolean }> {
  const lines: Array<{ line: number; added: boolean }> = [];
  let next = 0;
  for (const l of (patch ?? "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) next = Number(hunk[1]);
    else if (next && (l.startsWith("+") || l.startsWith(" "))) lines.push({ line: next++, added: l.startsWith("+") });
  }
  return lines;
}

/** Lines of the new version of a file that GitHub lets a review comment on. */
export function commentableLines(patch: string | undefined): Set<number> {
  return new Set(patchLines(patch).map((l) => l.line));
}

/** The new lines of every file in the diff. A moved file is all new, because its imports now belong to another place. */
export function changedLines(files: GhPullFile[]): ChangedLines[] {
  return files
    .filter((f) => f.status !== "removed")
    .map((f) => ({
      path: f.filename,
      added: f.status === "renamed" || !f.patch ? null : new Set(patchLines(f.patch).filter((l) => l.added).map((l) => l.line)),
    }));
}

function explain(v: NewViolation): string[] {
  return [plain(v.message), "", `**Why:** ${plain(v.rationale)}`, "", `**Fix:** ${plain(v.fix)}`];
}

export function renderInline(v: NewViolation): string {
  return [`**${plain(v.ruleId)}**`, "", ...explain(v), "", marker(inlineKind(v))].join("\n");
}

export function renderResolved(kind: string, headSha: string): string {
  return `✅ No longer a violation as of ${code(headSha.slice(0, 7))}.\n\n${marker(kind)}`;
}

export interface SummaryInput {
  fullName: string;
  headSha: string;
  outcome: PrCheckOutcome;
  /** What the pull request does to the rules, in sentences. */
  ruleChanges: string[];
  /** The pull request's page in Voxium, when other people can open it. */
  pageUrl: string | null;
}

export function renderSummary({ fullName, headSha, outcome, ruleChanges, pageUrl }: SummaryInput): string {
  const n = outcome.newViolations.length;
  const warnings = outcome.warnings ?? [];
  const warningCount = outcome.warningCount ?? warnings.length;
  const waiting = outcome.protectedChanges.length > 0 && !outcome.approvedBy;
  const icon = outcome.state === "success" ? "✅" : outcome.state === "failure" ? "❌" : "⚠️";
  const title =
    outcome.state === "success" ? "no new violations"
    : n ? `${n} new violation${n === 1 ? "" : "s"}`
    : waiting ? "the rules change, and that needs approval"
    : outcome.state === "failure" ? "this cannot pass yet"
    : "the check could not be completed";
  const counts = [
    `${n} new`,
    `${outcome.baselineCount} accepted as existing debt`,
    ...(warningCount ? [`${warningCount} warning${warningCount === 1 ? "" : "s"}, not blocking`] : []),
    ...(outcome.expiring.length ? [`${outcome.expiring.length} exception${outcome.expiring.length === 1 ? "" : "s"} expiring soon`] : []),
  ];
  const out = [`### ${icon} Voxium: ${title}`, "", `Commit ${code(headSha.slice(0, 7))} · ${counts.join(" · ")}`, ""];
  // Says what is wrong when no violation does, such as rules that changed meanwhile or files that cannot be read.
  if (outcome.state !== "success" && (!n || outcome.uncheckedCount > 0)) out.push(plain(outcome.description), "");

  if (waiting) {
    const page = pageUrl ? `[this pull request's page in Voxium](${pageUrl})` : "this pull request's page in Voxium, which the `voxium/rules` status links to";
    out.push(
      "#### The rules change",
      "",
      ...ruleChanges.map((c) => `* ${plain(c)}`),
      "",
      `An Owner or Team Leader with write access has to approve this commit in a GitHub review. Someone who works alone can approve their own change on ${page}.`,
      "",
    );
  } else if (outcome.approvedBy) {
    out.push(`The rules change, approved by ${plain(outcome.approvedBy)}.`, "");
  }

  const link = (v: NewViolation) => {
    const at = `${v.file}${v.line ? `:${v.line}` : ""}`;
    return `[${code(at)}](https://github.com/${fullName}/blob/${headSha}/${urlPath(v.file)}${v.line ? `#L${v.line}` : ""})`;
  };
  let listed = 0;
  for (const v of outcome.newViolations.slice(0, MAX_LISTED)) {
    const item = [`#### ${plain(v.ruleId)}: ${link(v)}`, "", ...explain(v), ""];
    if (out.join("\n").length + item.join("\n").length > MAX_BODY) break;
    out.push(...item);
    listed++;
  }
  if (n > listed) out.push(`And ${n - listed} more.`, "");
  if (warnings.length) {
    out.push("#### Warnings, not blocking", "");
    let shown = 0;
    for (const v of warnings.slice(0, MAX_LISTED)) {
      const item = `* ${plain(v.ruleId)}: ${link(v)} ${plain(v.message)} Fix: ${plain(v.fix)}`;
      if (out.join("\n").length + item.length > MAX_BODY) break;
      out.push(item);
      shown++;
    }
    if (warningCount > shown) out.push(`* And ${warningCount - shown} more.`);
    out.push("");
  } else if (outcome.warningsUnknown) {
    out.push("#### Warnings, not blocking", "", "They could not be worked out, because the code where this pull request branched off could not be read.", "");
  }
  if (outcome.expiring.length) {
    out.push("#### Exceptions expiring soon", "", ...outcome.expiring.slice(0, 20).map((e) => `* ${plain(e.rule)} for ${code(e.file)} on ${plain(e.expires)} (${plain(e.owner)})`), "");
  }
  return out.join("\n").trimEnd().slice(0, MAX_BODY + 5000);
}

/** The page's address, or null when Voxium runs on someone's own machine. */
function publicPage(env: Env, url: string): string | null {
  const host = new URL(env.APP_URL).hostname;
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost") ? null : url;
}

async function syncSummary(env: Env, token: string, ev: PrEvent, outcome: PrCheckOutcome, body: string): Promise<void> {
  const key = { githubRepoId: ev.repoId, number: ev.number };
  const row = (await listComments(env.DB, key)).find((c) => c.kind === SUMMARY);
  if (row?.comment_id && (await updateIssueComment(token, ev.fullName, row.comment_id, body))) return;
  // A clean pull request gets no comment, and one that people deleted only comes back when there is something to say.
  if (outcome.state === "success") return;
  if (row) await releaseComment(env.DB, key, SUMMARY);
  const id = await createIssueComment(token, ev.fullName, ev.number, body);
  if (await claimComment(env.DB, key, SUMMARY, id)) return;
  // Another check got there first. Keep one comment, with the newest text.
  await deleteIssueComment(token, ev.fullName, id);
  const other = (await listComments(env.DB, key)).find((c) => c.kind === SUMMARY);
  if (other?.comment_id) await updateIssueComment(token, ev.fullName, other.comment_id, body);
}

async function syncInline(env: Env, token: string, ev: PrEvent, outcome: PrCheckOutcome, pullFiles: () => Promise<GhPullFile[]>): Promise<void> {
  const key = { githubRepoId: ev.repoId, number: ev.number };
  const rows = new Map((await listComments(env.DB, key)).filter((c) => c.kind.startsWith("inline:")).map((c) => [c.kind, c]));
  const now = new Map(outcome.newViolations.map((v) => [inlineKind(v), v]));

  for (const [kind, row] of rows) {
    if (row.comment_id === null || row.state === "deleted") continue;
    const v = now.get(kind);
    // A cycle stays the same violation when other imports keep it going, so what its comment says is kept up to date.
    if (v && (row.state === "resolved" || outcome.cycles.has(v.id))) {
      const there = await updateReviewComment(token, ev.fullName, row.comment_id, renderInline(v));
      await setComment(env.DB, key, kind, row.comment_id, there ? "open" : "deleted");
    } else if (!v && row.state === "open" && outcome.complete) {
      const there = await updateReviewComment(token, ev.fullName, row.comment_id, renderResolved(kind, ev.headSha));
      await setComment(env.DB, key, kind, row.comment_id, there ? "resolved" : "deleted");
    }
  }

  // An import that breaks another rule too already has a comment, so a cycle does not add a second one to it.
  const told = new Set(outcome.newViolations.filter((v) => v.line && !outcome.cycles.has(v.id)).map((v) => `${v.line} ${v.file}`));
  const missing = outcome.newViolations.filter(
    (v) =>
      v.line &&
      (!rows.has(inlineKind(v)) || rows.get(inlineKind(v))!.comment_id === null) &&
      !(outcome.cycles.has(v.id) && told.has(`${v.line} ${v.file}`)),
  );
  if (!missing.length) return;
  const files = new Map<string, GhPullFile>((await pullFiles()).map((f) => [f.filename, f]));
  const wanted: NewViolation[] = [];
  for (const v of missing) {
    if (wanted.length === MAX_INLINE) break;
    if (!commentableLines(files.get(v.file)?.patch).has(v.line!)) continue;
    if (await claimComment(env.DB, key, inlineKind(v), null)) wanted.push(v);
  }
  if (!wanted.length) return;
  try {
    const reviewId = await createReview(token, ev.fullName, ev.number, {
      commit_id: ev.headSha,
      body: `Voxium found ${wanted.length} import${wanted.length === 1 ? "" : "s"} here that break${wanted.length === 1 ? "s" : ""} the architecture rules.`,
      comments: wanted.map((v) => ({ path: v.file, line: v.line!, side: "RIGHT" as const, body: renderInline(v) })),
    });
    const posted = await listReviewComments(token, ev.fullName, ev.number, reviewId);
    for (const v of wanted) {
      const kind = inlineKind(v);
      const c = posted.find((p) => p.body.includes(marker(kind)));
      // One that cannot be found again is left alone instead of being posted twice.
      await setComment(env.DB, key, kind, c?.id ?? null, c ? "open" : "deleted");
    }
  } catch (err) {
    for (const v of wanted) await releaseComment(env.DB, key, inlineKind(v));
    throw err;
  }
}

/**
 * Explain a check on the pull request itself. Only for the commit the pull request is at now, so a slow check of an
 * older one cannot replace newer text. Trouble here never changes the verdict, which is already published.
 */
export async function commentOnPull(
  token: string,
  ev: PrEvent,
  outcome: PrCheckOutcome,
  opts: { ruleChanges: string[]; pageUrl: string | null; isLatest: () => Promise<boolean>; pullFiles: () => Promise<GhPullFile[]> },
): Promise<void> {
  const env = getEnv();
  try {
    const pull = await getPull(token, ev.fullName, ev.number);
    if (!pull || pull.state !== "open" || pull.head.sha !== ev.headSha || pull.base.ref !== ev.baseRef || !(await opts.isLatest())) return;
    const pageUrl = opts.pageUrl && publicPage(env, opts.pageUrl);
    await syncSummary(env, token, ev, outcome, renderSummary({ fullName: ev.fullName, headSha: ev.headSha, outcome, ruleChanges: opts.ruleChanges, pageUrl }));
    await syncInline(env, token, ev, outcome, opts.pullFiles);
  } catch (err) {
    console.error("voxium could not comment", ev.fullName, ev.number, err);
  }
}
