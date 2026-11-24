export const dynamic = "force-dynamic";

/** Landing page for the GitHub App manifest flow. It only shows the one time code and the next command. */
export default async function GithubAppCreated({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const safe = code && /^[A-Za-z0-9_-]{8,128}$/.test(code) ? code : null;
  return (
    <>
      <h1>GitHub App created</h1>
      {safe ? (
        <>
          <p className="lead">
            Run this on your machine within one hour. The code works once and turns into the app's credentials.
          </p>
          <pre>node packages/platform/github-app/convert-manifest.mjs {safe}</pre>
          <p className="muted">Then follow the steps it prints to store the secrets, and install the app on a repository.</p>
        </>
      ) : (
        <p className="lead">No valid code in the address. Create the app again from the setup page.</p>
      )}
    </>
  );
}
