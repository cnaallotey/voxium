import { Cta, Intro } from "@/components/site";

// The header shows who is signed in, so every page is rendered for its request.
export const dynamic = "force-dynamic";

export const metadata = { title: "How it works · Voxium" };

const LOOP: Array<[string, string]> = [
  ["Define", "Voxium scans a repository's import graph, detects folders, layers and frameworks, and proposes modules, a layer order and rules, each with how sure it is. You keep, rename, re-path, reorder or switch off what it found, or start from a template: layered, hexagonal, feature-sliced, modular monolith, Next or Nuxt."],
  ["Feed agents", "The rules go into a managed block in CLAUDE.md, AGENTS.md and the Cursor rules, with every rule's rationale, because agents follow rules better when they know why. The MCP server answers get_rules_for_path, check_import and check_change before an agent writes."],
  ["Enforce", "Every pull request is checked by the rules on its base branch, so it cannot pass by editing its own. New violations fail the voxium/rules status; today's violations are baseline debt that is tracked down over time. Warnings are listed and never block."],
  ["Evolve", "Changing the rules is a proposal: from the editor, as JSON, from an agent through propose_architecture_change, or from the CLI. Voxium writes the pull request, lists what would newly fail, and a Team Leader approves that exact commit in Voxium. Every merged change lands in a decision log."],
];

const SETUP: Array<[string, string]> = [
  ["Install the GitHub App", "On the account or organization, for the repositories you choose."],
  ["Review the draft", "Voxium infers the architecture from the default branch and shows each module's files, each layer's share of imports that go down the order, and each rule's violations today."],
  ["Open the setup pull request", "It adds voxium/architecture.json, the baseline, the agent rules and a suggested CODEOWNERS naming your Team Leaders. Nothing is written before you open it."],
  ["Merge, and require the check", "Require voxium/rules, with the Voxium app as its source, in branch protection. From then on every pull request is judged."],
];

export default function HowItWorks() {
  return (
    <>
      <Intro kicker="How it works" title="Define once. Feed every agent. Enforce on every change.">
        The platform is where the architecture is defined, approved and watched. The repository is where it lives and where it is enforced, so CI and
        agents keep working even when the platform is not there.
      </Intro>

      <section className="band">
        <h2>The loop</h2>
        <ol className="steps">
          {LOOP.map(([title, text]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p className="muted">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="band split">
        <div>
          <h2>Setting up a repository</h2>
          <p className="muted">From signing in to the first enforced rule, without writing a rule by hand.</p>
        </div>
        <ol className="steps">
          {SETUP.map(([title, text]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p className="muted">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="band">
        <h2>What the rules can say</h2>
        <div className="grid-3">
          <div className="card">
            <h3>Layers and dependencies</h3>
            <p className="muted">A module may import only from layers below it. Deny a dependency between two modules, or forbid cycles between modules.</p>
          </div>
          <div className="card">
            <h3>Packages</h3>
            <p className="muted">"No direct database client outside data": keep a package to the modules that may use it.</p>
          </div>
          <div className="card">
            <h3>Conventions</h3>
            <p className="muted">File naming styles, where files of a kind belong, and the public entry points other modules may import.</p>
          </div>
          <div className="card">
            <h3>Limits</h3>
            <p className="muted">Maximum file size, and imports that cannot be told from the code, which are found and reported.</p>
          </div>
          <div className="card">
            <h3>Exceptions</h3>
            <p className="muted">Scoped to a rule and some files, with an owner, a reason and an expiry date. An expired exception fails the check.</p>
          </div>
          <div className="card">
            <h3>Organization rules</h3>
            <p className="muted">One rule set for every repository, taken through an approved pull request, with per-repository overrides that expire.</p>
          </div>
        </div>
      </section>

      <section className="band">
        <h2>Watching it over time</h2>
        <p className="muted">
          After every merge Voxium analyses the default branch and keeps a snapshot: debt by rule and module, exceptions by expiry, and a diagram of the
          modules with the imports the rules forbid highlighted. An overview shows every repository you can open, and Owners get an audit log of who
          did what, with CSV and JSON export.
        </p>
      </section>

      <Cta />
    </>
  );
}
