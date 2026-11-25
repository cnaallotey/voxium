import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  bad_state: "Sign in expired or was opened twice. Please try again.",
  oauth_failed: "GitHub did not complete the sign in. Please try again.",
  github_unavailable: "Could not read your access from GitHub, so you were not signed in. Please try again.",
};

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const message = error ? ERRORS[error] : undefined;
  const user = await currentUser();
  return (
    <>
      {message && <div className="card error">{message}</div>}
      <h1>Keep developers and coding agents inside your architecture.</h1>
      <p className="lead">
        Define your architecture once. Voxium gives it to every developer and coding agent, checks every pull
        request against it, and makes changing it a deliberate, approved act.
      </p>
      <p>
        {user ? (
          <a className="btn" href="/dashboard">Open dashboard</a>
        ) : (
          <a className="btn" href="/api/auth/login">Sign in with GitHub</a>
        )}
      </p>
    </>
  );
}
