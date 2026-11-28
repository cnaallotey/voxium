/**
 * True when a form was submitted from Voxium itself. The session cookie alone does not prove that: on localhost,
 * pages on other ports count as the same site and their forms would carry it.
 */
export function fromThisSite(req: { headers: Headers }, appUrl: string): boolean {
  return req.headers.get("origin") === new URL(appUrl).origin;
}
