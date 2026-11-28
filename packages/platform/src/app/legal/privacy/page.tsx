import { Fill, LegalPage, Mail } from "@/components/site";
import { TableWrap } from "@/components/ui";
import { LEGAL } from "@/lib/legal";

// The header shows who is signed in, so every page is rendered for its request.
export const dynamic = "force-dynamic";

export const metadata = { title: "Privacy Policy · Voxium" };

const SECTIONS: Array<[string, string]> = [
  ["controller", "Who is responsible"],
  ["collect", "What we collect"],
  ["not", "What we do not collect"],
  ["why", "Why we use it"],
  ["share", "Who we share it with"],
  ["keep", "How long we keep it"],
  ["rights", "Your rights"],
  ["changes", "Changes"],
  ["contact", "Contact"],
];

const DATA: Array<[string, string, string]> = [
  ["Your GitHub account", "Id, login, name and avatar URL", "From GitHub when you sign in"],
  ["Your access", "The organizations you belong to, your role in them, and the repositories you can open with your level of access", "From GitHub at every sign in, and checked again when you open a repository or approve a change"],
  ["Organizations and repositories", "Account names, repository names, default branches and the GitHub App installation", "From GitHub when the app is installed"],
  ["Analysis results", "Module names, globs, rule ids, counts, and violations with their file paths, lines and messages, and snapshots of a branch by module and rule", "Worked out by Voxium from your repositories"],
  ["What you write", "Proposals, the reasons for approvals and rejections, organization rule sets and their notes, setup drafts", "From you, in the service or in proposal files in your pull requests"],
  ["Decisions and the audit log", "Who changed, approved or merged what, and when", "Recorded as you use the service"],
];

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" sections={SECTIONS}>
      <h2 id="controller">1. Who is responsible</h2>
      <p>
        <Fill value={LEGAL.company} />, <Fill value={LEGAL.address} />, is responsible for the personal data described here. Contact:{" "}
        <Mail value={LEGAL.privacyEmail} />.
      </p>

      <h2 id="collect">2. What we collect</h2>
      <TableWrap>
        <table>
          <thead><tr><th>What</th><th>Details</th><th>Where it comes from</th></tr></thead>
          <tbody>
            {DATA.map(([what, details, from]) => (
              <tr key={what}><td>{what}</td><td>{details}</td><td className="muted">{from}</td></tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <p>
        We set two cookies that the service needs to work, described in the <a href="/legal/cookies">Cookie Notice</a>. Our hosting provider records
        technical request data, such as IP addresses, in its logs. <Fill value="[Describe log retention at the hosting provider]" />
      </p>

      <h2 id="not">3. What we do not collect</h2>
      <ul>
        <li>The contents of your source files. A check reads the repository archive into memory and drops it when the check is done.</li>
        <li>Your GitHub password. You sign in on GitHub.</li>
        <li>Your GitHub sign in token. It is used once, when you sign in, to read your organizations and repositories, and is not kept.</li>
        <li>Analytics or advertising data. There are no tracking cookies and no third party scripts.</li>
      </ul>

      <h2 id="why">4. Why we use it</h2>
      <ul>
        <li>To provide the service: to sign you in, to show you what you may see, to check pull requests and to open the pull requests you ask for.</li>
        <li>To keep the rules trustworthy: to decide who may approve a change, and to keep the decision log and the audit log that your organization's Owners read.</li>
        <li>To keep the service secure and working.</li>
      </ul>
      <p>
        Legal basis: <Fill value="[for example, performance of a contract and legitimate interests, as applicable in your jurisdiction]" />.
      </p>

      <h2 id="share">5. Who we share it with</h2>
      <p>We do not sell personal data. We use these providers to run the service:</p>
      <ul>
        <li>GitHub, which Voxium reads from and writes pull requests, statuses and comments to, as you ask.</li>
        <li>Cloudflare, which hosts the service and its database.</li>
      </ul>
      <p>
        Within an organization, what you do in Voxium is visible to the people who can see it there: for example, your proposals to those who can open
        the repository, and the audit log to the organization's Owners. <Fill value="[International transfers, if any]" />
      </p>

      <h2 id="keep">6. How long we keep it</h2>
      <ul>
        <li>Snapshots of a branch: the newest 400 for each repository.</li>
        <li>Checks of pull requests: the newest 500 for each repository.</li>
        <li>Account, organization, decision and audit data: while your account or organization uses the service, and <Fill value={LEGAL.retention} /> after.</li>
      </ul>

      <h2 id="rights">7. Your rights</h2>
      <p>
        Depending on where you live, you may have the right to access, correct, delete or export your personal data, and to object to or restrict its
        use. Write to <Mail value={LEGAL.privacyEmail} />. You can also complain to your data protection authority.{" "}
        <Fill value="[Name the authority, if required]" />
      </p>

      <h2 id="changes">8. Changes</h2>
      <p>We will post changes here and update the effective date. Material changes will be announced before they take effect.</p>

      <h2 id="contact">9. Contact</h2>
      <p>
        <Mail value={LEGAL.privacyEmail} />
      </p>
    </LegalPage>
  );
}
