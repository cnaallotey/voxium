# Voxium

Keep developers and coding agents inside your architecture.

Voxium infers or defines your architecture, writes it to `voxium/architecture.json`, gives agents the rules (CLAUDE.md, AGENTS.md), and blocks pull requests that violate it.

See SPEC.md for the full product spec.

## Packages

* `packages/core` (`@voxium/core`): import graph, rule checker, inference, generators. Shared by the CLI and the future platform.
* `packages/cli` (`voxium`): the command line and the local MCP server.
* `packages/platform` (`@voxium/platform`): Next.js on Cloudflare Workers (OpenNext). GitHub sign in, GitHub App webhooks, repo analysis, setup pull requests, PR status checks, D1 for results.

## Try it

    npm install
    npm run build
    npm test
    node packages/cli/dist/cli.js init --root /path/to/a/ts/project
    node packages/cli/dist/cli.js check --root /path/to/a/ts/project
    node packages/cli/smoke-mcp.mjs /path/to/an/initialised/project   # MCP end to end test

## Platform setup

1. Create the GitHub App with the manifest helper in `packages/platform/github-app/` (see its README for the full walkthrough, including the end to end test steps).
2. `cd packages/platform`, copy `.dev.vars.example` to `.dev.vars` and fill it in.
3. `npx wrangler d1 create voxium`, put the id in `wrangler.jsonc`, then `npm run db:migrate:local`.
4. `npm run cf:preview` to run it locally in the Workers runtime. `npm run cf:deploy` to deploy.
5. Production secrets: `wrangler secret put GITHUB_APP_PRIVATE_KEY` (and GITHUB_CLIENT_SECRET, GITHUB_WEBHOOK_SECRET, SESSION_SECRET).

How it works: the repo holds the rules (`voxium/architecture.json`). The platform reads the repo tarball in memory, never stores source, and writes results to D1. Pull requests are judged by the rules on the BASE branch, so a PR cannot weaken the rules it is checked against. Setup opens a PR, it never pushes to the default branch.

## What stops a PR from getting around the rules

* A PR that changes `voxium/architecture.json`, `voxium/baseline.json` or `.github/workflows/voxium.yml` fails `voxium/rules` until an Owner or Team Leader with write access approves that exact commit in a GitHub review. It is then judged by the rules they approved. If the rules on the base branch changed meanwhile, the branch has to be updated first. Removing baseline debt needs no approval.
* `voxium/rules` is only ever written by a check against the default branch. PRs into another branch report as `voxium/rules (branch name)`. Require that name if you protect the branch.
* Files outside every module are followed: importing one counts as importing everything it leads to.
* Committed files are not skipped because of their folder name. List build output in `ignore` in the architecture file. Ignored files are not judged themselves, but importing one still counts as importing what it leads to.
* Every file is compared with its git hash, so `.gitattributes` cannot show the check something else than what is committed. If a source file cannot be read as committed (over 4 MB, over the 40 MB total, symlinked, or changed by `.gitattributes`), the check is an error, not a pass. Ignored files are exempt as long as no checked code leads to them.
* When several checks of one commit overlap, only the newest one reports.

Repository settings that this depends on: require the `voxium/rules` status **with the Voxium app as its source** (otherwise anyone who can push can post that status), require branches to be up to date, and put `voxium/CODEOWNERS.suggested` in `.github/CODEOWNERS` with code owner review required.

## Running the CLI from npm

Generated files never tell a machine to run an unpinned package. `.github/workflows/voxium.yml`, the `.mcp.json` entry and the `npx` line in the agent rules are only written when you name an exact published version, such as `voxium@1.2.3`: set `VOXIUM_CLI_PACKAGE` for the platform, or pass `--cli-package` to `init` and `generate`. Leave it empty until the CLI is on npm under an account you control. Anyone can register a name that is not taken, and those files would run their code. The `voxium/rules` status does not use npm.

That GitHub Actions job uses the rules from the default branch, but a PR can still edit workflow files. Without the platform, CODEOWNERS review is what protects them.

## Who can see and do what

GitHub decides, and the platform never grants more than GitHub would.

* Owner is an admin of the GitHub organization, or the account holder of a personal account. Nobody becomes Owner by signing in first.
* Roles and the list of repos are refreshed from GitHub at every sign in. Sessions last 8 hours. "Refresh access" on the dashboard does it sooner. Losing sight of an organization (suspended app, no SSO session) takes access away but keeps a Team Leader's role for when it returns. Leaving the organization ends it.
* Opening a repo page, starting setup and counting an approval each ask GitHub again at that moment. If GitHub cannot answer, access is refused.

## Commands

* `init`: infer an architecture, write it with a baseline and agent rules. `--cli-package <name@version>` adds the CI workflow and `.mcp.json`.
* `infer`: print the inferred architecture only.
* `check`: exit 1 on new blocking violations. Formats: text, json, github. `--rules-from <ref>` takes the rules and baseline from a git ref instead of the working tree.
* `generate`: regenerate agent rules from the architecture file, and the workflow and `.mcp.json` when the workflow already pins a version or `--cli-package` gives one.
* `mcp`: run the MCP server over stdio. Tools: `get_architecture`, `get_rules_for_path`, `check_import`, `check_change`, `propose_architecture_change`.

## Rule types

`layers`, `no_cycles`, `deny_dependency`, `deny_external`, `max_file_lines`. Exceptions need an owner, reason and expiry date.

## Known limits

* TypeScript, JavaScript and Vue files only. Imports resolve relative paths and `@/`, `~/` aliases, not tsconfig `paths`.
* Inference proposes modules from top level folders and orders layers by import direction. Modules with no imports between them are ordered arbitrarily, so review the layers.
* Agents can suggest architecture changes through MCP (saved as pending proposals), but nothing approves them yet. The approval flow belongs to the platform.
* Approval works through GitHub reviews, and GitHub does not let authors approve their own PR. A solo owner has to merge an architecture change with an admin override. The logged self approval in the spec is not built.
* There is no screen for making someone a Team Leader yet, so for now only Owners can approve architecture changes.
* Imports in forms the import scanner does not recognise are not seen. The CLI follows symlinks and reads submodules. The platform does neither: a symlinked source file is an error there, and imports through a symlinked folder or into a submodule are not seen.
* Without the platform, an exception that has already expired can be removed in a PR but not renewed without an admin override.
* Not built yet: org level approval flow for architecture changes, remote MCP server on Workers, billing, generated test files, Queues for large repos.
* The platform has been verified with unit tests and in the local Workers runtime with a local D1. It has not been run against a real GitHub App yet.
