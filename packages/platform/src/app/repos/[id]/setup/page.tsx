import { notFound, redirect } from "next/navigation";
import { ArchitectureEditor } from "@/components/architecture-editor";
import { currentUser } from "@/lib/auth";
import { draftHash, openSetup, type StoredDraft } from "@/lib/setup";
import { getSetupDraft } from "@/lib/store";

import { Empty, ErrorNotice, Notice, PageHeader, RepoTabs } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

/** The inferred architecture, for an Owner or Team Leader to review and edit before Voxium opens the setup pull request. */
export default async function SetupPage({ params, searchParams }: Props) {
  if (!(await currentUser())) redirect("/api/auth/login");
  // The draft names files and folders, and only someone who may set up Voxium may change it.
  const access = await openSetup((await params).id);
  if (!access.ok) notFound();
  const { env, repo } = access.open;
  const { error } = await searchParams;
  const row = await getSetupDraft(env.DB, repo.id);
  const draft = row && (JSON.parse(row.draft_json) as StoredDraft);
  const infer = (label: string) => (
    <form method="post" action={`/api/repos/${repo.id}/setup/draft`}>
      <button type="submit" className={draft ? "secondary" : undefined}>{label}</button>
    </form>
  );

  return (
    <>
      <PageHeader
        crumbs={[["Dashboard", "/dashboard"], [repo.full_name, `/repos/${repo.id}`], ["Setup"]]}
        title="Review the architecture"
        meta={
          row &&
          draft && (
            <>
              <span>Inferred from <code>{row.commit_sha.slice(0, 12)}</code> on {row.updated_at}</span>
              <span>{draft.summary.files} files</span>
              <span>confidence in the layer order {(draft.summary.confidence * 100).toFixed(0)}%</span>
            </>
          )
        }
        actions={row && draft && infer("Infer again")}
      />
      <RepoTabs id={repo.id} current="setup" active={repo.status === "active"} manager />
      <ErrorNotice error={error} />
      {repo.status === "active" && (
        <Notice tone="info">
          Voxium is set up on this repository. <a href={`/repos/${repo.id}/proposals`}>Propose a change to its rules</a> instead.
        </Notice>
      )}
      {!row || !draft ? (
        <Empty>
          <p>Voxium reads {repo.default_branch}, proposes modules, a layer order and rules, and shows how sure it is of each. Nothing is written to the repository until you open the pull request.</p>
          {infer("Infer the architecture")}
        </Empty>
      ) : (
        <>
          {draft.summary.notes.map((n) => (
            <p className="muted small" key={n}>Note: {n}</p>
          ))}
          {draft.opening && (
            <Notice tone="info">
              {draft.opening.by} sent this draft on {draft.opening.at}, and Voxium is opening the pull request. Reload the page in a moment.
            </Notice>
          )}
          {draft.submitted && (
            <Notice tone="ok">
              {draft.submitted.by} opened the setup pull request from this draft on {draft.submitted.at}. Sending it again replaces the files in that pull request.
            </Notice>
          )}
          {(draft.errors ?? []).map((e) => (
            <Notice tone="error" key={e}>{e}</Notice>
          ))}
          <form method="post" action={`/api/repos/${repo.id}/setup`}>
            <input type="hidden" name="draft" value={await draftHash(row)} />
            <ArchitectureEditor arch={draft.architecture} edits={draft.edits} proposals={draft.proposals} violations={draft.violations} />
            {draft.warnings?.length ? (
              <Notice tone="warn">
                <strong>Please check</strong>
                <ul>
                  {draft.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
                <label className="check">
                  <input type="checkbox" name="confirm" /> Open the pull request anyway
                </label>
              </Notice>
            ) : null}
            <p className="muted">
              The baseline is worked out again from the tip of {repo.default_branch} when you send this, so commits made since the draft are counted.
            </p>
            <div className="form-actions">
              <button type="submit">Open the setup pull request</button>
            </div>
          </form>
        </>
      )}
    </>
  );
}
