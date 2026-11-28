import { currentUser } from "@/lib/auth";
import { Notice } from "@/components/ui";
import { Cta } from "@/components/site";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  bad_state: "Sign in expired or was opened twice. Please try again.",
  oauth_failed: "GitHub did not complete the sign in. Please try again.",
  github_unavailable: "Could not read your access from GitHub, so you were not signed in. Please try again.",
};

const PROBLEMS: Array<[string, string]> = [
  ["Agents take the shortest path", "They optimise for code that runs and passes tests, so they cross a module boundary whenever it is quicker."],
  ["The design lives in a wiki", "Agents do not read wikis or attend standups. The architecture you agreed on never reaches the code they write."],
  ["Reviews cannot see drift", "A reviewer has minutes for a large generated diff. One import upward at a time, the structure slips away."],
];

const PILLARS: Array<[string, string]> = [
  ["Inferred, not hand-written", "Voxium reads your import graph, proposes modules, a layer order and rules with how sure it is of each, and records today's violations as a baseline so day one is green."],
  ["Told to every agent", "The rules go into CLAUDE.md, AGENTS.md and Cursor rules, and an MCP server lets an agent check an import or a planned change before it writes."],
  ["Enforced on every pull request", "A required status check blocks new violations, with the rule, the file and line, why the rule exists and how to fix it, judged by the rules of the base branch."],
  ["Changed on purpose", "A change to the rules is a proposal that a Team Leader approves in Voxium, for one exact commit. Agents can suggest changes; they can never approve them."],
];

const FAQ: Array<[string, string]> = [
  ["Does Voxium keep my source code?", "No. Each check reads the repository archive in memory and keeps only the result: module names, rule ids, counts and the violations it found. The code itself is never stored."],
  ["Does it write to my default branch?", "No. Everything Voxium writes, from the setup to a regenerated CLAUDE.md, arrives as a pull request for you to review and merge."],
  ["What if Voxium is down?", "The rules live in voxium/architecture.json in your repository, so the CLI and CI keep enforcing them without the platform."],
  ["Which languages?", "TypeScript and JavaScript, including Vue single file components. Imports are read with a real parser, so a comment or a string cannot hide one."],
  ["Can an agent loosen the rules to make its code pass?", "Not quietly. A pull request that changes the rules, the baseline, the check's workflow or the rules block in CLAUDE.md fails until an Owner or Team Leader approves that exact commit."],
];

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const message = error ? ERRORS[error] : undefined;
  const user = await currentUser();
  return (
    <>
      {message && <Notice tone="error">{message}</Notice>}
      <section className="hero">
        <p className="kicker">Architecture guardrails for coding agents</p>
        <h1>Keep developers and coding agents inside your architecture.</h1>
        <p className="lead">
          Define your architecture once. Voxium gives it to every developer and coding agent, checks every pull
          request against it, and makes changing it a deliberate, approved act.
        </p>
        <div className="form-actions">
          {user ? (
            <a className="btn" href="/dashboard">Open dashboard</a>
          ) : (
            <a className="btn" href="/api/auth/login">Sign in with GitHub</a>
          )}
          <a className="btn secondary" href="/how-it-works">See how it works</a>
        </div>
        <p className="muted small">For teams using Claude Code, Cursor, Copilot, Codex and any agent that reads AGENTS.md or speaks MCP.</p>
      </section>

      <section className="band">
        <p className="kicker">The problem</p>
        <h2>Tests pass, features work, and the codebase drifts.</h2>
        <div className="grid-3">
          {PROBLEMS.map(([title, text]) => (
            <div className="card" key={title}>
              <h3>{title}</h3>
              <p className="muted">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="band split">
        <div>
          <p className="kicker">What a pull request sees</p>
          <h2>A clear, fixable reason, on the line that broke it.</h2>
          <p className="muted">
            The check names the rule, the import and the file and line, says why the rule exists, and suggests the fix. The same message reaches the
            pull request as a comment, and an agent sees it before it writes, through <code>check_import</code> and <code>check_change</code>.
          </p>
          <p className="muted small">Example output.</p>
        </div>
        <div className="terminal" role="img" aria-label="Example output of voxium check, failing on one import from services into ui">
          <span className="dim">$ npx voxium check</span>{"\n"}
          Checked 412 files (398 in 5 modules, 1904 imports).{"\n\n"}
          New violations: 1{"\n"}
          {"  "}<span className="bad">LAYER01</span> src/services/billing.ts:3{"\n"}
          {"  "}src/services/billing.ts (services) imports{"\n"}
          {"  "}src/ui/Button.tsx (ui). Layer order puts ui{"\n"}
          {"  "}above services.{"\n"}
          {"  "}<span className="dim">Fix: have ui pass the data in, or move the{"\n"}
          {"  "}shared code into a lower layer such as "shared".</span>{"\n\n"}
          <span className="bad">FAILED: 1 blocking violation(s).</span>
        </div>
      </section>

      <section className="band">
        <p className="kicker">How Voxium fixes it</p>
        <h2>One architecture, everywhere it matters.</h2>
        <div className="grid-3">
          {PILLARS.map(([title, text]) => (
            <div className="card" key={title}>
              <h3>{title}</h3>
              <p className="muted">{text}</p>
            </div>
          ))}
        </div>
        <p>
          <a href="/how-it-works">Read how it works →</a>
        </p>
      </section>

      <section className="band">
        <p className="kicker">Questions</p>
        <h2>What teams ask first</h2>
        <div className="faq">
          {FAQ.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>

      {!user && <Cta />}
    </>
  );
}
