import type { PrEvent } from "./repo-job";

export interface WebhookPayload {
  action?: string;
  installation?: { id: number; account?: { login: string; type: string } };
  repositories_removed?: Array<{ id: number }>;
  repository?: { id: number; full_name: string; default_branch: string };
  pull_request?: {
    number: number;
    state?: string;
    user: { id: number };
    head: { sha: string };
    base: { ref: string };
  };
  changes?: { base?: unknown };
}

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const REVIEW_ACTIONS = new Set(["submitted", "edited", "dismissed"]);

/** The check a webhook calls for, or null when it calls for none. */
export function prEventFrom(event: string | null, body: WebhookPayload): PrEvent | null {
  const { action = "", installation, repository, pull_request: pr } = body;
  if (!installation || !repository || !pr) return null;
  const wanted =
    event === "pull_request"
      ? PR_ACTIONS.has(action) || (action === "edited" && body.changes?.base !== undefined) // moved to another base
      : event === "pull_request_review"
        ? REVIEW_ACTIONS.has(action) && pr.state !== "closed"
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
  };
}
