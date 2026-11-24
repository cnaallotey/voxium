import type { GhReview } from "./github";

export interface Approver {
  id: number;
  login: string;
}

/**
 * People whose latest verdict is an approval of exactly this commit. An approval does not survive a new push,
 * and neither the author nor a bot can approve.
 */
export function currentApprovals(reviews: GhReview[], headSha: string, authorId: number): Approver[] {
  const latest = new Map<number, GhReview>();
  for (const r of reviews) {
    // Plain comments do not change a person's verdict.
    if (r.user && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latest.set(r.user.id, r);
  }
  return [...latest.values()]
    .filter((r) => r.state === "APPROVED" && r.commit_id === headSha && r.user!.type === "User" && r.user!.id !== authorId)
    .map((r) => ({ id: r.user!.id, login: r.user!.login }));
}
