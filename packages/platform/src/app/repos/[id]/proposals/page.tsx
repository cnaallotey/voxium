import { ARCH_FILE_PATH } from "@voxium/core";
import { notFound, redirect } from "next/navigation";
import { ArchitectureEditor } from "@/components/architecture-editor";
import { parseArch } from "@/lib/analysis";
import { currentUser } from "@/lib/auth";
import { getBranchSha, getFileAtRef } from "@/lib/github";
import { openRepo } from "@/lib/open-repo";
import { PROPOSAL_STATUS, rulesHash } from "@/lib/proposals";
import { listProposals } from "@/lib/store";
import { canManage } from "@/lib/access";
import { Empty, ErrorNotice, PageHeader, ProposalBadge, RepoTabs, Section } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}

/** What every proposal says: what should change and why. */
function Words({ reason }: { reason: string }) {
  return (
    <>
      <label>
        Title
        <input type="text" name="title" required maxLength={200} />
      </label>
      <label>
        What should change
        <textarea name="summary" required maxLength={2000} rows={2} />
      </label>
      <label>
        {reason}
        <textarea name="rationale" required maxLength={4000} rows={3} />
      </label>
    </>
  );
}

export default async function ProposalsPage({ params, searchParams }: Props) {
  if (!(await currentUser())) redirect("/api/auth/login");
  const open = await openRepo((await params).id);
  if (!open) notFound();
  const { env, repo, token, role, level } = open;
  const manager = canManage(role) && level !== "read";
  const { error } = await searchParams;
  const proposals = await listProposals(env.DB, repo.id);
  const archText = await getFileAtRef(token, repo.full_name, ARCH_FILE_PATH, await getBranchSha(token, repo.full_name, repo.default_branch));
  const current = parseArch(archText);
  const action = `/api/repos/${repo.id}/proposals`;
  const against = await rulesHash(archText);

  const open_ = proposals.filter((p) => p.status === "pending" || p.status === "pr_open").length;
  return (
    <>
      <PageHeader
        crumbs={[["Dashboard", "/dashboard"], [repo.full_name, `/repos/${repo.id}`], ["Proposals"]]}
        title="Proposals"
        meta={proposals.length > 0 && <span>{open_} open of {proposals.length}</span>}
        lead={
          <>
            Anyone who can open the repository can propose a change to the rules. Agents do it with <code>propose_architecture_change</code>, people
            with <code>voxium propose</code> or the forms below. An Owner or Team Leader turns a proposal into a pull request, and someone other than
            whoever asked approves it in Voxium.
          </>
        }
      />
      <RepoTabs id={repo.id} current="proposals" active={repo.status === "active"} manager={manager} />
      <ErrorNotice error={error} />
      {proposals.length === 0 ? (
        <Empty>No proposals yet.</Empty>
      ) : (
        <div className="list">
          {proposals.map((p) => (
            <div className="item" key={p.id}>
              <span>
                <a className="item-title" href={`/repos/${repo.id}/proposals/${p.id}`}>#{p.id} {p.title}</a> <ProposalBadge status={p.status} label={PROPOSAL_STATUS[p.status]} />
              </span>
              <span className="muted small">
                {p.requester_login} · {p.created_at}
              </span>
            </div>
          ))}
        </div>
      )}

      {!current ? (
        <Empty>Voxium is not set up on {repo.default_branch}, or its rules are invalid, so there is nothing to propose a change to.</Empty>
      ) : (
        <>
          <h2>Propose a change</h2>
          <Section title="Edit the architecture" hint="modules, layers and rules, with the editor" open id="edit">
            <form method="post" action={action}>
              <input type="hidden" name="kind" value="edits" />
              <input type="hidden" name="against" value={against} />
              <Words reason="Why the rules should change" />
              <ArchitectureEditor arch={current} />
              <label className="check">
                <input type="checkbox" name="acceptDebt" /> Accept as debt the violations these rules would make new
              </label>
              <div className="form-actions">
                <button type="submit">Propose</button>
              </div>
            </form>
          </Section>

          <Section title="Propose an exception" hint="one rule, some files, until a date">
            <form method="post" action={action}>
              <input type="hidden" name="kind" value="exception" />
              <Words reason="Why it is needed (kept as the reason of the exception)" />
              <label>
                Rule
                <select name="rule" required>
                  {current.rules.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id}: {r.description}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Files it covers (a glob, such as src/legacy/**)
                <input type="text" name="file" required maxLength={300} />
              </label>
              <label>
                Runs out on
                <input type="date" name="expires" required />
              </label>
              <div className="form-actions">
                <button type="submit">Propose</button>
              </div>
            </form>
          </Section>

          <Section title="Accept the current violations as debt" hint="only later ones fail">
            <form method="post" action={action}>
              <input type="hidden" name="kind" value="debt" />
              <p className="muted">
                Adds to voxium/baseline.json exactly the violations on {repo.default_branch} that are not accepted yet, so that only later ones fail.
                The pull request lists each of them.
              </p>
              <Words reason="Why they should be accepted" />
              <div className="form-actions">
                <button type="submit">Propose</button>
              </div>
            </form>
          </Section>

          <Section title="Change the architecture as JSON" hint="the whole voxium/architecture.json">
            <form method="post" action={action}>
              <input type="hidden" name="kind" value="architecture" />
              <input type="hidden" name="against" value={against} />
              <Words reason="Why the rules should change" />
              <label>
                voxium/architecture.json as it should be
                <textarea name="architecture" required rows={16} defaultValue={JSON.stringify(current, null, 2)} className="mono" spellCheck={false} />
              </label>
              <label className="check">
                <input type="checkbox" name="acceptDebt" /> Accept as debt the violations these rules would make new
              </label>
              <div className="form-actions">
                <button type="submit">Propose</button>
              </div>
            </form>
          </Section>
        </>
      )}
    </>
  );
}
