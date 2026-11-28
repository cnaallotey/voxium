import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { openManagedOrg } from "@/lib/open-org";
import { describeNewVersion, draftHash, MAX_NOTE, parseSetRules, setRules } from "@/lib/org-rules";
import { snapshotData } from "@/lib/snapshot-view";
import { getOrgRuleDraft, listOrgRuleSets, listReposForUser, newestSnapshots } from "@/lib/store";
import { ErrorNotice, Notice, OrgTabs, PageHeader, TableWrap } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

const EXAMPLE = `[
  {
    "id": "ORG-NO-PG",
    "type": "deny_external",
    "module": "*",
    "except": ["data"],
    "packages": ["pg"],
    "severity": "block",
    "description": "Only data code talks to Postgres.",
    "rationale": "One place for queries and connections."
  }
]
`;

/** An organization's rule set: its versions, the next one while it is checked, and where each repository stands. */
export default async function OrgRulesPage({ params, searchParams }: Props) {
  const user = await currentUser();
  if (!user) redirect("/api/auth/login");
  const open = await openManagedOrg((await params).id);
  if (!open) notFound();
  const { env, org, role } = open;
  const { error } = await searchParams;
  const versions = await listOrgRuleSets(env.DB, org.id);
  const current = versions[0] ?? null;
  const draft = await getOrgRuleDraft(env.DB, org.id);
  const parsedDraft = draft ? parseSetRules(draft.rules_json) : null;
  const preview = draft && parsedDraft?.ok ? describeNewVersion(setRules(current), current?.version ?? 0, parsedDraft.rules) : null;
  // Only the repositories this person can open, so the page says nothing about others.
  const repos = await Promise.all(
    (await listReposForUser(env.DB, user.id, org.id)).map(async (repo) => {
      const newest = await newestSnapshots(env.DB, repo.id);
      const data = snapshotData(newest.any);
      return { repo, version: data ? data.orgVersion : undefined, overrides: data?.overrides ?? [] };
    }),
  );

  return (
    <>
      <PageHeader
        crumbs={[["Dashboard", "/dashboard"], [org.account_login, `/orgs/${org.id}/overview`], ["Organization rules"]]}
        title="Organization rules"
        meta={
          current ? (
            <>
              <span className="badge info">version {current.version}</span>
              <span>
                saved {current.created_at} by {current.login ?? "someone who left"}: {current.note}
              </span>
            </>
          ) : (
            <span className="badge">no version yet</span>
          )
        }
        lead="Rules that mean the same in every repository: packages a module may not use, file sizes, cycles, opaque imports, naming in every file and where files go. A repository takes a version through a pull request that someone other than whoever asked approves in Voxium, and is checked by what it merged, also without Voxium."
      />
      <OrgTabs id={org.id} current="rules" role={role} />
      <ErrorNotice error={error} />

      <h2>Next version</h2>
      <form method="post" action={`/api/orgs/${org.id}/rules`} className="card">
        <input type="hidden" name="action" value="check" />
        <label>
          Rules, as JSON
          <textarea className="mono" name="rules" rows={16} defaultValue={draft?.rules_json ?? current?.rules_json ?? EXAMPLE} spellCheck={false} />
        </label>
        <label>
          Why (saved with the version, at most {MAX_NOTE} characters)
          <input type="text" name="note" maxLength={MAX_NOTE} defaultValue={draft?.note ?? ""} />
        </label>
        <div className="form-actions">
          <button type="submit" className="secondary">Check and preview</button>
          <span className="muted small">Nothing is saved yet: you see what the version changes first.</span>
        </div>
      </form>

      {draft && preview && (
        <div className="card" id="preview">
          <h2>Version {(current?.version ?? 0) + 1}, not saved yet</h2>
          {draft.based_on !== (current?.version ?? 0) && <Notice tone="error">Version {current?.version} was saved since this draft was made. Check the rules again.</Notice>}
          {preview.length ? (
            <ul className="changes">{preview.map((l, i) => <li key={i}>{l}</li>)}</ul>
          ) : (
            <p className="muted">It has the same rules as version {current?.version}.</p>
          )}
          <p className="muted">Why: {draft.note}</p>
          <form method="post" action={`/api/orgs/${org.id}/rules`}>
            <input type="hidden" name="action" value="save" />
            <input type="hidden" name="based_on" value={draft.based_on} />
            <input type="hidden" name="draft" value={await draftHash(draft)} />
            <button type="submit">Save as version {draft.based_on + 1}</button>
          </form>
        </div>
      )}

      <h2>Repositories</h2>
      <p className="muted">From the newest analysis of each default branch. Only repositories you can open are listed.</p>
      <TableWrap>
        <table>
          <thead><tr><th>Repository</th><th>Version</th><th>Overrides</th><th></th></tr></thead>
          <tbody>
            {repos.map(({ repo, version, overrides }) => (
              <tr key={repo.id}>
                <td><a href={`/repos/${repo.id}`}>{repo.full_name}</a></td>
                <td>
                  {version === undefined ? <span className="muted">not analysed yet</span> : version === null ? "none" : `version ${version}`}
                  {current && typeof version === "number" && version < current.version && <> <span className="badge warn">behind</span></>}
                </td>
                <td>
                  {overrides.length === 0 && <span className="muted">none</span>}
                  {overrides.map((o) => (
                    <div key={o.rule}>
                      <code>{o.rule}</code> {o.action === "disable" ? "off" : "warning"} until {o.expires} {o.expired && <span className="badge bad">expired</span>}
                    </div>
                  ))}
                </td>
                <td>
                  {current && repo.level !== "read" && (
                    <form method="post" action={`/api/repos/${repo.id}/org-update`}>
                      <label className="muted"><input type="checkbox" name="acceptDebt" /> accept what newly fails as debt</label>{" "}
                      <button type="submit" className="secondary">Open update pull request</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>

      {versions.length > 1 && (
        <>
          <h2>Earlier versions</h2>
          <TableWrap>
            <table>
              <tbody>
                {versions.slice(1).map((v) => (
                  <tr key={v.version}><td>Version {v.version}</td><td className="muted">{v.created_at}</td><td>{v.login ?? "someone who left"}</td><td>{v.note}</td></tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      )}
    </>
  );
}
