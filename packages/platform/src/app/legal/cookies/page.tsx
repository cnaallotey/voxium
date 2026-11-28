import { LegalPage, Mail } from "@/components/site";
import { TableWrap } from "@/components/ui";
import { LEGAL } from "@/lib/legal";

// The header shows who is signed in, so every page is rendered for its request.
export const dynamic = "force-dynamic";

export const metadata = { title: "Cookie Notice · Voxium" };

const SECTIONS: Array<[string, string]> = [
  ["what", "The cookies we set"],
  ["none", "What we do not use"],
  ["control", "Your choices"],
  ["contact", "Contact"],
];

const COOKIES: Array<[string, string, string]> = [
  ["voxium_session", "Keeps you signed in. It holds a signed session, not your GitHub token.", "8 hours, or until you sign out"],
  ["voxium_oauth_state", "Protects the sign in with GitHub against forged requests.", "10 minutes, removed once you are signed in"],
];

export default function Cookies() {
  return (
    <LegalPage title="Cookie Notice" sections={SECTIONS}>
      <h2 id="what">1. The cookies we set</h2>
      <p>Voxium sets only the cookies it needs to work. Both are HTTP-only, so scripts on a page cannot read them, are sent only to Voxium, and are marked secure on HTTPS.</p>
      <TableWrap>
        <table>
          <thead><tr><th>Name</th><th>What it is for</th><th>How long</th></tr></thead>
          <tbody>
            {COOKIES.map(([name, what, how]) => (
              <tr key={name}><td><code>{name}</code></td><td>{what}</td><td className="muted">{how}</td></tr>
            ))}
          </tbody>
        </table>
      </TableWrap>

      <h2 id="none">2. What we do not use</h2>
      <p>No analytics, advertising or tracking cookies, no third party scripts, and nothing stored in your browser's local storage.</p>

      <h2 id="control">3. Your choices</h2>
      <p>
        Because these cookies are strictly necessary, the service does not ask for consent to them. You can delete them in your browser at any time;
        you will then be signed out.
      </p>

      <h2 id="contact">4. Contact</h2>
      <p>
        <Mail value={LEGAL.privacyEmail} />
      </p>
    </LegalPage>
  );
}
