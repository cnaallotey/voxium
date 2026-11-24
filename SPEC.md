# Voxium Product Spec

Status: Draft v0.3 (platform centered, open questions resolved)
Owner: Charles Allotey
Date: 2026 11 24

## 1. Summary

AI coding agents write code well but make poor architectural decisions. Tests pass, features work, and the codebase slowly drifts away from the design the team intended.

Voxium is a platform where a team defines its system architecture once, then manages how that architecture reaches every developer and coding agent, and how it is enforced on every change. The platform is the control plane. The repo and CI are the enforcement points. A thin CLI and MCP server connect developers and agents to the platform.

The architecture can always be updated, but only through a deliberate, approved change.

## 2. Problem

* Agents optimize for code that runs and passes tests. They will cross a module boundary if it is the shortest path.
* Architecture docs rot in wikis. Agents do not read wikis and do not attend standups.
* PR reviewers have minutes per PR and cannot spot structural drift across large AI generated diffs.
* AI reviewers share the same blind spot, because they have no durable access to the team's decisions.
* Existing rule checkers (ArchUnit, dependency cruiser, import linter) work, but someone has to hand write every rule, they are language specific, and they know nothing about agents.
* Nobody has one place to see, change and govern architecture across many repos.

## 3. Goals

* Give teams one platform to define, edit, approve and monitor architecture across all their repos.
* Keep the architecture versioned in each repo so enforcement works even if the platform is offline.
* Reduce setup cost by inferring a first draft of the architecture from an existing codebase.
* Give agents the relevant rules before they write, not after CI fails.
* Block violating changes in CI with clear, fixable messages.
* Make changing the architecture an explicit, reviewable act that agents cannot do quietly.

## 4. Non goals (v1)

* Judging whether an architecture is good. The tool enforces intent, it does not design for you.
* Replacing general AI code review (bugs, security, style).
* Supporting every language. v1 targets TypeScript and JavaScript projects.
* Runtime monitoring or tracing of deployed systems.

## 5. Users

* Tech leads and architects who want their decisions to stick.
* Teams using Claude Code, Cursor, Copilot or Codex heavily.
* Engineering managers who want visibility into drift across repos.
* Solo developers and small agencies who ship fast with agents and want guardrails without process overhead.

## 6. Product model: platform as control plane

### 6.1 Roles of each part

* **Platform (web app):** where architecture is defined, edited, approved and monitored. Holds org level rules, change history, dashboards and settings.
* **Repo:** holds the approved architecture file, ADR log, generated tests and generated agent context. This is the source of truth that CI and agents read.
* **CI:** runs generated tests on every PR and reports to the platform.
* **CLI and MCP server:** thin clients. They read rules from the repo (offline capable), sync with the platform when online, and let agents check plans and changes.
* **GitHub App:** the main way the platform acts on repos: installs workflows, opens PRs, posts reviews and sets status checks.

### 6.2 Source of truth rule

The platform never becomes the only home of the rules. Edits in the platform produce a PR against the repo. When the PR is approved and merged, the repo file is the new truth, and the platform reads it back. This keeps CI working when the platform is down and lets agents read rules offline.

## 7. What is managed from the platform

* **Connect repos:** install the GitHub App, select repos, and the platform opens a setup PR with the CI workflow, config and agent context files.
* **Define architecture:** guided templates, repo inference, and a visual editor for modules, layers and rules.
* **Review inference:** accept, edit or reject each proposed module and rule, with a confidence score.
* **Approve changes:** architecture change requests, approvers, ADR entries and expiring exceptions.
* **Sync agent context:** CLAUDE.md, AGENTS.md and Cursor rules regenerate after each approved change, delivered by PR.
* **Monitor:** violations per PR, drift over time, baseline debt, exception expiry, and how often agents checked rules before writing.
* **Org level rules:** shared rule sets applied across many repos, with per repo overrides that need approval.
* **Access and audit:** who changed what, who approved, and when.

## 7b. Roles and permissions

* **Owner:** manages the org, billing, connected repos and roles.
* **Team Leader:** the architecture authority at the organization level. Approves architecture changes and exceptions for every repo in the org, and edits org level rules. An org can have several Team Leaders. There is no per repo scoping in v1.
* **Member:** views the architecture, runs checks, and proposes changes or exceptions. Cannot approve their own proposals.
* **Agent or service identity:** read access to rules and the check tools. Can propose changes but can never approve them.

Solo mode: when an org has one person, that person holds both Owner and Team Leader roles. Self approval is allowed, but it requires a written reason that is logged in the ADR history, so the protected change flow still leaves a trail.

## 8. Core loop

### 8.1 Define
* Guided setup: pick a template (layered, hexagonal, feature sliced, modular monolith, Nuxt or Next conventions) and answer a short set of questions.
* Inference: scan a connected repo, build the dependency graph, detect folders, layers and import patterns, and propose a draft. A human reviews and approves it in the platform.
* Result is written to the repo as `voxium/architecture.json` plus an ADR log.

### 8.2 Feed agents
* Condensed rules in `CLAUDE.md`, `AGENTS.md` and Cursor rules, kept in sync by the platform through PRs.
* MCP server with tools such as `get_rules_for_path`, `check_change` and `propose_architecture_change`, so an agent can ask what applies to the file it is about to edit and validate a plan before writing code.
* Optional pre commit hook that runs a fast local check.

### 8.3 Enforce
* Generated architecture tests (ArchUnitTS or dependency cruiser in v1).
* Generated CI workflow (GitHub Actions first, GitLab CI later), installed by the platform through a PR.
* PR review comments per violation: which rule, which file and line, why the rule exists, and a suggested fix.
* Required status checks so violations block merge.
* Optional AI pass for rules that cannot be expressed as static checks, labeled advisory and never blocking.

### 8.4 Evolve
* Changes start in the platform (or through `voxium propose`) and become a PR against the architecture file.
* Any PR touching the architecture definition or generated rule files needs a named approver, enforced through CODEOWNERS and a required check. An agent cannot edit the rules to make its own code pass.
* Every change appends an ADR entry (what changed, why, who approved).
* Exceptions carry an owner, a reason and an expiry date. Expired exceptions fail CI.
* After a change, tests, agent context files and the CI workflow regenerate together.

## 9. Architecture definition format

A single JSON file in the repo, readable by humans and agents:

* `modules`: named areas with path globs (for example `ui`, `services`, `data`, `shared`).
* `layers`: ordering and allowed direction between modules.
* `dependencies`: allow and deny rules between modules, plus external package rules (for example "no direct database client imports outside `data`").
* `conventions`: naming, file placement, public API entry points per module.
* `limits`: optional thresholds such as maximum file size or cyclic dependencies.
* `rules`: each with an id, plain English description, rationale, severity (block or warn) and check type (static or advisory AI).
* `exceptions`: scoped, owned, expiring.
* `meta`: version, last approved by, link to ADR log, optional link to org level rule sets.

Every rule must carry a rationale. Agents follow rules better when they know why, and reviewers judge exceptions faster.

## 10. Inference engine

Inputs: file tree, import graph, framework detection (Nuxt, Next, Express, Nest), git history for change coupling.
Outputs: proposed modules, proposed layer order, detected existing violations, and a confidence score per proposal.

Trust rules:
* Inference only proposes. A human approves before anything is enforced.
* Existing violations are stored as a baseline so day one CI does not fail. New violations fail, old ones are tracked down over time.

## 11. CI and PR experience

* Setup is one click in the platform, or `npx voxium init` for the CLI path. Both detect the stack and CI provider.
* Fast mode: only analyze files changed in the PR plus their dependents.
* Clear failure output, for example: "services/billing imports ui/Button. Rule LAYER 02: services must not depend on ui. Move shared logic to shared or pass it in as a parameter."
* PR summary comment with counts: new violations, baseline violations, expiring exceptions.
* Status checks: `voxium/rules` (blocking) and `voxium/advisory` (non blocking).
* Results report back to the platform for dashboards and drift history.

## 12. Tech approach

* **Hosting:** everything runs on Cloudflare.
* **Platform:** Next.js on Cloudflare Workers through the OpenNext adapter. D1 stores orgs, repos, rule sets, change requests, ADR index, violations and the audit log (Hyperdrive to an external Postgres is the fallback). R2 holds analysis snapshots. Durable Objects coordinate approvals per org.
* **GitHub App:** a Worker receives webhooks and enqueues jobs on Queues. Handles the installation flow, PR creation, reviews and status checks.
* **Analysis workers:** Queue consumers fetch the repo tarball through the GitHub API and analyze it in memory. The core takes a map of file paths to contents, with no filesystem access, so the same code runs in the CLI and in Workers. Imports are parsed with a small WASM lexer instead of the full TypeScript package. Cloudflare Containers is the fallback for repos too large for Worker limits (check current availability).
* **CLI and MCP server:** TypeScript on Node, distributed through npx. Works offline from the repo file, syncs with the platform when online.
* **Test generation:** ArchUnitTS in v1.
* **Diagram view:** interactive graph of modules and allowed dependencies, with violations highlighted.
* **LLM usage:** inference narration, rule drafting and advisory checks only. Blocking checks stay deterministic.
* **Security:** read only repo access by default, write access only through PRs, and a full audit log.
* **Analysis only storage:** source is cloned into short lived isolated workers and deleted when each job ends. The platform stores only analysis output (module maps, dependency edges, violation records, rule and change history), never source code.

## 13. Competitive position

* ArchUnit family, dependency cruiser, import linter: deterministic but manual, no agent loop, no central management.
* Archgate: closest rival, ADRs as executable rules with Claude Code and Cursor plugins. Differentiate on the platform, inference, visual editing and protected change flow.
* Packmind, Mneme HQ, archfit: playbook sync, decision governance and scoring. Partial overlap.
* Greptile, CodeRabbit, Qodo: AI reviewers with custom rules. Probabilistic and review time only.
* Sonar: likely to expand into architecture guardrails. Compete on speed, agent integration and developer experience.

Differentiators:
1. One platform to manage architecture across repos, with the repo as source of truth.
2. Inference from an existing repo with baseline mode.
3. One source producing agent context, tests, CI workflow and PR reviews together.
4. Protected, approved, expiring changes to the architecture itself.
5. Visual architecture view that engineers, managers and agents all consume.

## 14. Roadmap

Phase 1: CLI core and platform foundation (6 to 8 weeks, built as two tracks sharing one analysis core)
* Shared core library: inference, rule evaluation, test generation. Both the CLI and the platform call it, so behavior stays identical.
* CLI track: `init`, `infer`, `check`, `generate`, working offline from the repo file. This is what early users and agents try first.
* Platform track: accounts, orgs, roles (Owner, Team Leader, Member) and repo connection through the GitHub App.
* Inference for TypeScript repos, with review and approval in the platform.
* Architecture JSON format, written to the repo by PR.
* Test generation and GitHub Actions workflow install by PR.
* CLAUDE.md, AGENTS.md and Cursor rules generation.
* Baseline mode and a basic violations view.

Phase 2: Enforcement and agents
* PR review comments and status checks.
* MCP server with rule lookup and plan checking.
* Protected change flow with CODEOWNERS setup, ADR log and expiring exceptions.

Phase 3: Visual and team features
* Visual editor and diagram view.
* Drift history, dashboards and exception tracking.
* Org level rule sets with per repo overrides.
* Advisory AI rules.

Phase 4: Expansion
* GitLab CI, Python support through import linter, then other languages.
* Audit log exports, SSO and enterprise controls.

## 15. Business model

* Free and open source CLI and MCP server for single repos, working fully offline.
* Paid platform: GitHub App, inference and visual editor, dashboards and drift history, multi repo and org rules, audit log.
* Monthly subscription pricing. Plan tiers and price points to be set after talking to early users (candidates: a free tier, a Team plan, and an Organization plan with org level rules and audit log).
* Free tier on public repos or one private repo to drive adoption.

## 16. Success metrics

* Time from signing up to first enforced rule under 10 minutes.
* Share of inferred rules accepted without edit (target above 60 percent).
* Violations caught in PRs per week per repo.
* Share of agent sessions that call the MCP check before writing.
* Weekly active repos with the status check required.
* Number of approved architecture changes per org per month, as a sign the platform is actually used for evolving the design.

## 17. Risks and open questions

* Rule authoring fatigue: if inference is weak, adoption stalls. Inference quality is the main product risk.
* False positives erode trust fast. Blocking checks must be deterministic and well explained.
* Rule rigidity: teams may feel frozen. The evolve flow and exceptions must be easy.
* Trust and security: teams must be comfortable granting repo access. Start read only and keep write access to PRs.
* Crowded market: Archgate and incumbents are moving. Speed and a sharp niche matter.

## 18. Decisions made

* **Build order:** CLI and platform are built together on one shared analysis core, so neither lags behind.
* **Languages:** TypeScript and JavaScript only for v1. Python comes after inference quality is proven.
* **Deployment:** hosted only. The offline CLI covers teams with strict code policies for now.
* **Name:** Voxium. Do a trademark and domain check before public launch.
* **Pricing:** monthly subscription plans.
* **Data handling:** analysis only. No source code is stored.
* **AI checks:** advisory only and never blocking in v1, so false positives cannot stop a merge.
* **Approval:** Team Leaders work at the organization level and approve architecture changes and exceptions for all repos. Solo orgs can self approve with a logged reason.
* **Agents:** agents can suggest architecture changes and open proposals, but can never approve them. Every agent proposal waits for a Team Leader.

## 19. Remaining open questions

* Exact plan tiers and price points.
* Whether per repo Team Leader scoping is needed after v1 for larger orgs.

## 20. Next steps

1. Validate inference on three real repos (a Nuxt app, a Next app, a Node API).
2. Build the shared analysis core, then the CLI commands and the GitHub App setup PR flow on top of it.
3. Dogfood on an existing project, then talk to five developers who use agents daily and watch where drift hurts them most.
