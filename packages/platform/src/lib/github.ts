import { b64urlEncode } from "./crypto";

const API = "https://api.github.com";
const UA = "voxium-platform";

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----[A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/** GitHub issues PKCS1 keys. WebCrypto wants PKCS8, so wrap the RSA key. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const rsaAlg = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const inner = [0x02, 0x01, 0x00, ...rsaAlg, ...octet];
  const total = inner.length + pkcs1.length;
  return Uint8Array.from([0x30, ...derLength(total), ...inner, ...pkcs1]);
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  let der = pemToDer(pem);
  if (pem.includes("BEGIN RSA PRIVATE KEY")) der = pkcs1ToPkcs8(der);
  return crypto.subtle.importKey("pkcs8", der as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** Short lived JWT that authenticates as the GitHub App itself. */
export async function createAppJwt(appId: string, privateKeyPem: string, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64urlEncode(JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importPrivateKey(privateKeyPem), new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export interface GithubAuthConfig {
  appId: string;
  privateKey: string;
}

export async function gh(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path.startsWith("http") ? path : `${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function ok<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`GitHub ${what} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export async function getInstallationToken(cfg: GithubAuthConfig, installationId: number): Promise<string> {
  const jwt = await createAppJwt(cfg.appId, cfg.privateKey);
  const res = await gh(jwt, `/app/installations/${installationId}/access_tokens`, { method: "POST" });
  return (await ok<{ token: string }>(res, "installation token")).token;
}

export interface GhRepo {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
  archived?: boolean;
}

export async function listInstallationRepos(token: string): Promise<GhRepo[]> {
  const out: GhRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = await ok<{ repositories: GhRepo[] }>(
      await gh(token, `/installation/repositories?per_page=100&page=${page}`),
      "list repositories",
    );
    out.push(...data.repositories);
    if (data.repositories.length < 100) break;
  }
  return out;
}

/** Download a repo tarball at a ref. Returns the gzip stream, following GitHub's redirect. */
export async function fetchTarball(token: string, fullName: string, ref: string): Promise<ReadableStream<Uint8Array>> {
  const res = await gh(token, `/repos/${fullName}/tarball/${encodeURIComponent(ref)}`, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`GitHub tarball failed: ${res.status}`);
  return res.body;
}

export async function getFileAtRef(token: string, fullName: string, path: string, ref: string): Promise<string | null> {
  const res = await gh(token, `/repos/${fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub contents failed: ${res.status}`);
  return res.text();
}

/** Commit a branch points at. Uses the full branch ref, so a tag with the same name cannot stand in for it. */
export async function getBranchSha(token: string, fullName: string, branch: string): Promise<string> {
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  const data = await ok<{ object: { sha: string } }>(await gh(token, `/repos/${fullName}/git/ref/heads/${ref}`), "read branch");
  return data.object.sha;
}

/** The commit where head branched off base. */
export async function getMergeBase(token: string, fullName: string, baseSha: string, headSha: string): Promise<string> {
  const data = await ok<{ merge_base_commit: { sha: string } }>(
    await gh(token, `/repos/${fullName}/compare/${baseSha}...${headSha}?per_page=1`),
    "compare",
  );
  return data.merge_base_commit.sha;
}

/**
 * Every file path in a commit, or null when GitHub cannot list them all. The tarball alone is not proof of
 * what a commit holds: .gitattributes "export-ignore" removes files from it.
 */
export async function listTreePaths(token: string, fullName: string, sha: string): Promise<string[] | null> {
  const data = await ok<{ truncated: boolean; tree: Array<{ path: string; type: string }> }>(
    await gh(token, `/repos/${fullName}/git/trees/${sha}?recursive=1`),
    "list files",
  );
  return data.truncated ? null : data.tree.filter((t) => t.type === "blob").map((t) => t.path);
}

export interface GhReview {
  user: { id: number; login: string; type: string } | null;
  state: string;
  commit_id: string | null;
}

/** All reviews, oldest first. Throws rather than returning part of a very long list. */
export async function listReviews(token: string, fullName: string, number: number): Promise<GhReview[]> {
  const out: GhReview[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = await ok<GhReview[]>(
      await gh(token, `/repos/${fullName}/pulls/${number}/reviews?per_page=100&page=${page}`),
      "list reviews",
    );
    out.push(...data);
    if (data.length < 100) return out;
  }
  throw new Error("GitHub list reviews failed: too many reviews to read");
}

/** True when the user can push to the repo. */
export async function canWrite(token: string, fullName: string, login: string): Promise<boolean> {
  const res = await gh(token, `/repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`);
  if (res.status === 404) return false;
  const { permission } = await ok<{ permission: string }>(res, "read permission");
  return permission === "admin" || permission === "write";
}

export async function setCommitStatus(
  token: string,
  fullName: string,
  sha: string,
  context: string,
  state: "success" | "failure" | "pending" | "error",
  description: string,
  targetUrl?: string,
): Promise<void> {
  const res = await gh(token, `/repos/${fullName}/statuses/${sha}`, {
    method: "POST",
    body: JSON.stringify({
      state,
      context,
      description: description.slice(0, 140),
      ...(targetUrl ? { target_url: targetUrl } : {}),
    }),
  });
  if (!res.ok) throw new Error(`GitHub status failed: ${res.status}`);
}

export interface SetupPrResult {
  url: string;
  number: number;
  branch: string;
  reused: boolean;
}

/** Create (or update) a branch with the given files and open a pull request. Never pushes to the default branch. */
export async function createSetupPr(
  token: string,
  fullName: string,
  defaultBranch: string,
  files: Record<string, string>,
  pr: { title: string; body: string; branch?: string },
): Promise<SetupPrResult> {
  const branch = pr.branch ?? "voxium/setup";
  const base = await ok<{ object: { sha: string } }>(
    await gh(token, `/repos/${fullName}/git/ref/heads/${encodeURIComponent(defaultBranch)}`),
    "read default branch",
  );
  const baseCommit = await ok<{ tree: { sha: string } }>(
    await gh(token, `/repos/${fullName}/git/commits/${base.object.sha}`),
    "read base commit",
  );
  const tree = await ok<{ sha: string }>(
    await gh(token, `/repos/${fullName}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseCommit.tree.sha,
        tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
      }),
    }),
    "create tree",
  );
  const commit = await ok<{ sha: string }>(
    await gh(token, `/repos/${fullName}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: pr.title, tree: tree.sha, parents: [base.object.sha] }),
    }),
    "create commit",
  );

  const refRes = await gh(token, `/repos/${fullName}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  });
  if (refRes.status === 422) {
    // Branch exists from an earlier attempt: move it to the new commit.
    await ok(
      await gh(token, `/repos/${fullName}/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: true }),
      }),
      "update setup branch",
    );
  } else if (!refRes.ok) {
    throw new Error(`GitHub create branch failed: ${refRes.status}`);
  }

  const owner = fullName.split("/")[0];
  const existing = await ok<Array<{ html_url: string; number: number }>>(
    await gh(token, `/repos/${fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`),
    "find existing pull request",
  );
  if (existing.length) return { url: existing[0].html_url, number: existing[0].number, branch, reused: true };

  const created = await ok<{ html_url: string; number: number }>(
    await gh(token, `/repos/${fullName}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: pr.title, head: branch, base: defaultBranch, body: pr.body }),
    }),
    "create pull request",
  );
  return { url: created.html_url, number: created.number, branch, reused: false };
}
