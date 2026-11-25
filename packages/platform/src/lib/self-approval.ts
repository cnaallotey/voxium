import { githubRepoLevel, githubStanding, type Account, type GithubUser } from "./access";
import { isOnlyMember } from "./github";
import type { Role } from "./store";

export const MIN_REASON = 10;
export const MAX_REASON = 2000;

/**
 * Why someone may not approve their own pull request, or null when they may. Asked from GitHub every time, also when
 * an earlier approval is counted, so it stops counting when they lose access or someone else joins.
 */
export async function selfApprovalProblem(
  token: string,
  account: Account,
  fullName: string,
  user: GithubUser,
  storedRole: Role | null,
): Promise<string | null> {
  if (!storedRole) return "You have no role in this organization.";
  if (account.account_type !== "User" && account.account_type !== "Organization") return "This kind of account does not allow it.";
  if ((await githubStanding(token, account, user)) !== "owner") return "Only an Owner can approve their own pull request.";
  // Nobody but the holder of a personal account can be an Owner or Team Leader there.
  if (account.account_type === "Organization" && !(await isOnlyMember(token, account.account_login, user.github_id))) {
    return "You are not alone in this organization, so someone else has to approve: another Owner, or a Team Leader you choose on the People page. They approve with a GitHub review.";
  }
  const level = await githubRepoLevel(token, fullName, user);
  if (level !== "write" && level !== "admin") return "You need write access to this repository.";
  return null;
}

/** The written reason, tidied, or null when it is too short or too long to be one. */
export function cleanReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n?/g, "\n").replace(/[^\P{C}\n]/gu, "").trim();
  // Count letters and digits, so spaces or dots do not pass for a reason.
  const said = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return said >= MIN_REASON && text.length <= MAX_REASON ? text : null;
}
