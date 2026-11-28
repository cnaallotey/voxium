import { Cta, Intro } from "@/components/site";
import { TableWrap } from "@/components/ui";

// The header shows who is signed in, so every page is rendered for its request.
export const dynamic = "force-dynamic";

export const metadata = { title: "For agents · Voxium" };

const TOOLS: Array<[string, string]> = [
  ["get_architecture", "The whole architecture: modules, layers, rules with their rationale, and exceptions."],
  ["get_rules_for_path", "What applies to the file an agent is about to edit: its module, what it may import, the naming style, where a file like it belongs, and the entry points of the modules it may use."],
  ["check_import", "Whether one import is allowed, and if not, which rule it breaks and what to import instead."],
  ["check_change", "The planned contents of the files an agent means to write, checked before it writes them, including cycles the change would add."],
  ["propose_architecture_change", "A suggestion to change the rules, an exception or accepting debt, written as a proposal for a Team Leader. Agents can propose; they cannot approve."],
];

const COMMANDS: Array<[string, string]> = [
  ["voxium init", "Infer the architecture, or start from a template, and write it with a baseline and the agent rules."],
  ["voxium check", "Exit 1 on new blocking violations, 2 when some code could not be read. Formats for people, JSON and GitHub annotations."],
  ["voxium check --staged", "Check what git has staged, by the rules of the last commit. What the pre-commit hook runs."],
  ["voxium check --changed <ref>", "Only the violations in files changed since a ref and in the files that import them, for quick feedback while working."],
  ["voxium generate", "Regenerate the agent rules, the CI workflow, a GitLab job, a pre-commit hook and dependency-cruiser rules from the architecture."],
  ["voxium mcp", "Run the MCP server over stdio for Claude Code, Cursor or any MCP client."],
  ["voxium propose", "Save a proposal in voxium/proposals for the platform to pick up from a pull request."],
];

export default function Agents() {
  return (
    <>
      <Intro kicker="For agents" title="Give agents the rules before they write, not after CI fails.">
        Voxium puts the architecture where coding agents look: in the files they read at the start of every session, and in tools they can call while
        they work. Everything runs from the repository, offline.
      </Intro>

      <section className="band split">
        <div>
          <h2>In the files agents read</h2>
          <p className="muted">
            CLAUDE.md, AGENTS.md and <code>.cursor/rules/voxium.mdc</code> get a block managed by Voxium: the layers top to bottom, every rule with why
            it exists, the conventions in words, and how to work within them. Your own text around it stays yours.
          </p>
          <p className="muted">
            The block is protected like the rules: a pull request that edits it, removes it or hides it in a code fence needs a Team Leader's approval, so
            an agent cannot rewrite its own instructions.
          </p>
        </div>
        <div className="terminal" role="img" aria-label="Example of the Voxium block in CLAUDE.md">
          <span className="dim">{"<!-- voxium:start -->"}</span>{"\n"}
          ## Architecture rules (managed by Voxium){"\n\n"}
          ### Layers, top to bottom{"\n"}
          1. `ui` (src/ui/**){"\n"}
          2. `services` (src/services/**){"\n"}
          3. `data` (src/data/**){"\n\n"}
          ### Rules{"\n"}
          * LAYER01 [block]: Modules only import{"\n"}
          {"  "}from layers below them. Why: …{"\n"}
          <span className="dim">{"<!-- voxium:end -->"}</span>
        </div>
      </section>

      <section className="band">
        <h2>Tools for agents</h2>
        <p className="muted">The MCP server, from <code>voxium mcp</code>, works from the rules in the repository.</p>
        <TableWrap>
          <table>
            <thead><tr><th>Tool</th><th>What it does</th></tr></thead>
            <tbody>
              {TOOLS.map(([name, text]) => (
                <tr key={name}><td><code>{name}</code></td><td>{text}</td></tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section className="band">
        <h2>The CLI</h2>
        <TableWrap>
          <table>
            <thead><tr><th>Command</th><th>What it does</th></tr></thead>
            <tbody>
              {COMMANDS.map(([name, text]) => (
                <tr key={name}><td><code>{name}</code></td><td>{text}</td></tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p className="muted small">
          Generated files never run an unpinned package: the CI workflow, the GitLab job, the pre-commit hook and the MCP entry name an exact published
          version of the CLI, or are not written at all.
        </p>
      </section>

      <Cta title="Let your agents see the architecture." />
    </>
  );
}
