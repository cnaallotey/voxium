import type { ClosedPr, PrEvent } from "./repo-job";

export interface WebhookPayload {
  action?: string;
  installation?: { id: number; account?: { id: number; login: string; type: string } };
  repositories_removed?: Array<{ id: number }>;
  repository?: { id: number; full_name: string; default_branch: string };
  pull_request?: {
    number: number;
    state?: string;
    merged?: boolean;
    html_url?: string;
    title?: string;
    merged_by?: { login: string } | null;
    closed_at?: string | null;
    user: { id: number };
    head: { sha: string };
    base: { ref: string; sha?: string };
  };
  changes?: { base?: unknown };
  review?: { state?: string; user: { id: number } | null };
}

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/** Plain comments arrive as reviews too. Only a verdict, or taking one back, can change an approval. */
function changesVerdict(action: string, state: string | undefined): boolean {
  return action === "dismissed" || (action === "submitted" && (state === "approved" || state === "changes_requested"));
}

/** The check a webhook calls for, or null when it calls for none. */
export function prEventFrom(event: string | null, body: WebhookPayload): PrEvent | null {
  const { action = "", installation, repository, pull_request: pr } = body;
  if (!installation || !repository || !pr) return null;
  const wanted =
    event === "pull_request"
      ? PR_ACTIONS.has(action) || (action === "edited" && body.changes?.base !== undefined) // moved to another base
      : event === "pull_request_review"
        ? changesVerdict(action, body.review?.state) && pr.state !== "closed" && Boolean(body.review?.user)
        : false;
  if (!wanted) return null;
  return {
    installationId: installation.id,
    repoId: repository.id,
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    number: pr.number,
    authorId: pr.user.id,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    ...(event === "pull_request_review" ? { reviewerId: body.review!.user!.id } : {}),
  };
}

/** A pull request into the default branch that was merged or closed, which can change whether a repo is set up. */
export function closedPrFrom(event: string | null, body: WebhookPayload): ClosedPr | null {
  const { action, installation, repository, pull_request: pr } = body;
  if (event !== "pull_request" || action !== "closed" || !installation || !repository || !pr) return null;
  if (pr.base.ref !== repository.default_branch) return null;
  return {
    installationId: installation.id,
    repoId: repository.id,
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    merged: pr.merged === true,
    url: pr.html_url ?? null,
    number: pr.number,
    title: pr.title ?? `Pull request ${pr.number}`,
    authorId: pr.user.id,
    headSha: pr.head.sha,
    baseSha: pr.base.sha ?? "",
    baseRef: pr.base.ref,
    mergedBy: pr.merged_by?.login ?? null,
    closedAt: pr.closed_at ?? new Date().toISOString(),
  };
}
