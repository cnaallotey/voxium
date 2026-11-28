import { Cta, Intro, Mail } from "@/components/site";
import { Notice } from "@/components/ui";
import { LEGAL } from "@/lib/legal";

// The header shows who is signed in, so every page is rendered for its request.
export const dynamic = "force-dynamic";

export const metadata = { title: "Pricing · Voxium" };

const TIERS: Array<{ name: string; for: string; featured?: boolean; items: string[]; action: [string, string] }> = [
  {
    name: "Free",
    for: "For solo developers, and to try Voxium",
    items: [
      "The CLI and the MCP server, for any repository, offline",
      "init, check, generate and propose",
      "Agent rules for Claude Code, Cursor and AGENTS.md",
      "The platform for public repositories or one private repository",
    ],
    action: ["Sign in with GitHub", "/api/auth/login"],
  },
  {
    name: "Team",
    for: "For teams that ship with agents",
    featured: true,
    items: [
      "The GitHub App on many repositories",
      "Inference with a review editor and templates",
      "Pull request checks, status and comments",
      "Proposals approved in Voxium, and a decision log",
      "Drift history, the diagram and regenerated agent files",
    ],
    action: ["Contact us", "contact"],
  },
  {
    name: "Organization",
    for: "For organizations with many repositories",
    items: [
      "Everything in Team",
      "Organization rule sets for every repository",
      "Per-repository overrides that expire",
      "An overview across repositories",
      "The audit log, with CSV and JSON export",
    ],
    action: ["Contact us", "contact"],
  },
];

export default function Pricing() {
  return (
    <>
      <Intro kicker="Pricing" title="Free on one repository. Plans for teams and organizations.">
        The CLI and the MCP server work on any repository without the platform. The platform adds the GitHub App, approvals, history and organization
        rules.
      </Intro>
      <Notice tone="info">Plans and prices are not final yet. Get in touch and we will tell you where things stand.</Notice>

      <div className="tiers">
        {TIERS.map((t) => (
          <div className={`card tier${t.featured ? " featured" : ""}`} key={t.name}>
            <h3>{t.name}</h3>
            <p className="price">{t.name === "Free" ? "Free" : "Price to be announced"}</p>
            <p className="muted small">{t.for}</p>
            <ul className="checklist">
              {t.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
            {t.action[1] === "contact" ? (
              <p className="muted small">
                Write to <Mail value={LEGAL.salesEmail} />
              </p>
            ) : (
              <a className="btn" href={t.action[1]}>{t.action[0]}</a>
            )}
          </div>
        ))}
      </div>

      <section className="band faq">
        <h2>Questions</h2>
        <details>
          <summary>Do I need the platform to enforce the rules?</summary>
          <p>No. The rules live in your repository, and the CLI checks them in CI or before a commit without Voxium's servers.</p>
        </details>
        <details>
          <summary>What does the platform add?</summary>
          <p>Setup from the browser, checks and comments on every pull request, approvals that agents cannot give, history, the diagram and rules for the whole organization.</p>
        </details>
        <details>
          <summary>Is my code stored on any plan?</summary>
          <p>No. On every plan Voxium keeps analysis results only, never the contents of a file. See Security.</p>
        </details>
      </section>

      <Cta />
    </>
  );
}
