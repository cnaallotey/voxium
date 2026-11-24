import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  return (
    <>
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
