import { Fill, LegalPage, Mail } from "@/components/site";
import { LEGAL } from "@/lib/legal";

// The header shows who is signed in, so every page is rendered for its request.
export const dynamic = "force-dynamic";

export const metadata = { title: "Terms of Service · Voxium" };

const SECTIONS: Array<[string, string]> = [
  ["who", "Who we are"],
  ["service", "The service"],
  ["accounts", "Accounts and GitHub"],
  ["content", "Your repositories and content"],
  ["use", "Acceptable use"],
  ["plans", "Plans and fees"],
  ["availability", "Availability and changes"],
  ["warranty", "No warranty"],
  ["liability", "Limitation of liability"],
  ["ending", "Suspension and termination"],
  ["law", "Governing law"],
  ["contact", "Contact"],
];

export default function Terms() {
  return (
    <LegalPage title="Terms of Service" sections={SECTIONS}>
      <h2 id="who">1. Who we are</h2>
      <p>
        Voxium is operated by <Fill value={LEGAL.company} />, <Fill value={LEGAL.address} /> ("we", "us"). These terms govern your use of the Voxium
        platform at this website ("the service"). By signing in or installing the Voxium GitHub App you agree to them. If you use the service for an
        organization, you agree on its behalf and confirm that you may.
      </p>

      <h2 id="service">2. The service</h2>
      <p>
        Voxium lets a team define the architecture of its software, gives it to developers and coding agents, and checks pull requests against it. It
        acts on your repositories through the Voxium GitHub App, which you install on the accounts and repositories you choose. The Voxium command line
        tool and MCP server can be used on their own; their use is governed by the terms they are distributed with.
      </p>
      <p>
        The service checks code against rules you define. It does not judge whether your architecture is good, find bugs or security problems in your
        code, or replace code review.
      </p>

      <h2 id="accounts">3. Accounts and GitHub</h2>
      <p>
        You sign in with your GitHub account. What you can see and do in Voxium follows what GitHub reports about your organizations and repositories;
        we never grant more than GitHub would. You are responsible for your GitHub account, for who you give access to, and for the GitHub settings,
        such as branch protection and required status checks, that make the service's checks binding on your repositories.
      </p>

      <h2 id="content">4. Your repositories and content</h2>
      <p>
        Your code, your rules and everything you write in the service, such as proposals, reasons and notes, remain yours. You give us the rights we
        need to provide the service: to read your repositories through the GitHub App, to analyse them, to store the results, and to open pull requests
        and post statuses and comments on them as you ask. We do not store the contents of your files; see the <a href="/legal/privacy">Privacy
        Policy</a> for what we keep.
      </p>
      <p>Changes Voxium proposes to your repositories arrive as pull requests. Reviewing and merging them is your decision.</p>

      <h2 id="use">5. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>use the service on repositories or accounts you are not allowed to act on;</li>
        <li>try to get around access checks, read other customers' data, or approve changes you are not entitled to approve;</li>
        <li>overload, probe or attack the service, except as part of good faith security research reported as described on the <a href="/security">Security</a> page;</li>
        <li>use the service in breach of the law or of GitHub's terms.</li>
      </ul>

      <h2 id="plans">6. Plans and fees</h2>
      <p>
        Plans and prices are not final. Any fees, billing periods and payment terms will be agreed with you before you are charged, and will be
        described here or in an order form. Until then, use of the service is free of charge. <Fill value="[Payment, renewal and refund terms]" />
      </p>

      <h2 id="availability">7. Availability and changes</h2>
      <p>
        We work to keep the service available, but we do not promise that it will be uninterrupted. Because the rules live in your repository, the
        command line tool keeps enforcing them in your CI when the service is not available. We may change the service and these terms; we will
        announce material changes to the terms <Fill value="[notice period]" /> before they take effect.
      </p>

      <h2 id="warranty">8. No warranty</h2>
      <p>
        The service is provided "as is" and "as available". To the extent the law allows, we disclaim all warranties, express or implied, including
        that the service will catch every violation of your rules or that its checks are free of errors.
      </p>

      <h2 id="liability">9. Limitation of liability</h2>
      <p>
        To the extent the law allows, we are not liable for indirect, incidental or consequential damages, or for lost profits, revenue or data, and our
        total liability for any claim related to the service is limited to <Fill value="[liability cap]" />. Nothing in these terms limits liability
        that cannot be limited by law.
      </p>

      <h2 id="ending">10. Suspension and termination</h2>
      <p>
        You can stop using the service at any time by uninstalling the GitHub App and signing out. We may suspend or end access that breaks these terms,
        and will tell you why unless the law or the security of the service prevents it. The rules already merged into your repositories stay there and
        keep working with the command line tool.
      </p>

      <h2 id="law">11. Governing law</h2>
      <p>
        These terms are governed by <Fill value={LEGAL.jurisdiction} />.
      </p>

      <h2 id="contact">12. Contact</h2>
      <p>
        Questions about these terms: <Mail value={LEGAL.contactEmail} />.
      </p>
    </LegalPage>
  );
}
