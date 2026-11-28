import { Cta, Intro, Mail } from "@/components/site";
import { TableWrap } from "@/components/ui";
import { LEGAL } from "@/lib/legal";

// The header shows who is signed in, so every page is rendered for its request.
export const dynamic = "force-dynamic";

export const metadata = { title: "Security · Voxium" };

const PERMISSIONS: Array<[string, string, string]> = [
  ["Metadata", "read", "List the repositories the app is installed on."],
  ["Contents", "write", "Read a commit's files for a check, and write branches and commits for the pull requests Voxium opens. Never the default branch itself."],
  ["Pull requests", "write", "Open the setup, proposal and regenerate pull requests, read reviews, and comment on violations."],
  ["Commit statuses", "write", "Publish the voxium/rules status that branch protection requires."],
  ["Workflows", "write", "Add the CI workflow to a pull request, when you choose a pinned CLI version."],
  ["Members", "read", "Confirm who is an Owner and who belongs to the organization, at the moment it matters."],
];

const STORED: Array<[string, string]> = [
  ["Your GitHub account", "Id, login, name and avatar URL, and your role and repository access as GitHub reports them."],
  ["Analysis results", "Module names, globs, rule ids, counts, and violations with their file and line. Never the contents of a file."],
  ["Rules and their history", "Setup drafts, proposals with their words, approvals with their reasons, the decision log and organization rule sets."],
  ["Audit log", "Who did what and when, for Owners to read and export."],
];

export default function Security() {
  return (
    <>
      <Intro kicker="Security" title="Read what it needs, keep only results, and write only through pull requests.">
        Teams have to trust a tool with their repositories. Here is what Voxium can access, what it keeps, and what stops anyone, people or agents, from
        getting around the rules.
      </Intro>

      <section className="band">
        <h2>Your code is not stored</h2>
        <p className="muted">
          A check reads the repository archive into memory, works out the result and drops the code when it is done. Only the analysis output listed below
          is kept. Every file read is compared with its git hash, so the check sees exactly what is committed.
        </p>
        <TableWrap>
          <table>
            <thead><tr><th>What Voxium keeps</th><th>What it is</th></tr></thead>
            <tbody>
              {STORED.map(([what, text]) => (
                <tr key={what}><td>{what}</td><td>{text}</td></tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section className="band">
        <h2>What the GitHub App may do</h2>
        <p className="muted">You choose the repositories when you install it. Everything Voxium writes arrives as a pull request for you to review.</p>
        <TableWrap>
          <table>
            <thead><tr><th>Permission</th><th>Access</th><th>Why</th></tr></thead>
            <tbody>
              {PERMISSIONS.map(([name, level, why]) => (
                <tr key={name}><td>{name}</td><td><span className={`badge ${level === "read" ? "" : "warn"}`}>{level}</span></td><td>{why}</td></tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section className="band">
        <h2>Checks that cannot be talked around</h2>
        <div className="grid-3">
          <div className="card">
            <h3>Rules from the base branch</h3>
            <p className="muted">A pull request is judged by the rules it would merge into, so editing its own rules does not help it pass.</p>
          </div>
          <div className="card">
            <h3>Protected files</h3>
            <p className="muted">The rules, the baseline, the check's workflows and the rules block in agent files need an approval of that exact commit.</p>
          </div>
          <div className="card">
            <h3>Unreadable is an error</h3>
            <p className="muted">Code or config that cannot be read to its end makes the check an error, never a pass. Imports are read with a real parser.</p>
          </div>
          <div className="card">
            <h3>Agents cannot approve</h3>
            <p className="muted">Approving in Voxium takes a signed in browser session, so a GitHub token, such as an agent's, can propose but never approve.</p>
          </div>
          <div className="card">
            <h3>Access checked at the moment</h3>
            <p className="muted">Opening a repository, approving or changing rules asks GitHub again right then. If GitHub cannot answer, access is refused.</p>
          </div>
          <div className="card">
            <h3>Nothing unpinned runs</h3>
            <p className="muted">Generated files never tell a machine to run a package that is not pinned to an exact published version.</p>
          </div>
        </div>
      </section>

      <section className="band">
        <h2>Accounts and sessions</h2>
        <p className="muted">
          You sign in with GitHub. Sessions last 8 hours in an HTTP-only cookie, and your roles and repositories are read from GitHub again at every sign
          in. Owners are the organization's admins on GitHub; nobody becomes an Owner by signing in first. Voxium runs on Cloudflare.
        </p>
      </section>

      <section className="band">
        <h2>Reporting a vulnerability</h2>
        <p className="muted">
          Write to <Mail value={LEGAL.securityEmail} /> with what you found and how to reproduce it. Please do not test against other people's
          repositories or accounts.
        </p>
      </section>

      <Cta />
    </>
  );
}
