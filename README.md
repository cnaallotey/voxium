# Voxium

Keep developers and coding agents inside your architecture.

Voxium infers or defines your architecture, writes it to `voxium/architecture.json`, gives agents the rules (CLAUDE.md, AGENTS.md), and blocks violating changes in CI.

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

* A PR that changes `voxium/architecture.json`, `voxium/baseline.json` or `.github/workflows/voxium.yml` fails `voxium/rules` until an Owner or Team Leader with write access approves that exact commit in a GitHub review. It is then judged by the rules they approved. Removing baseline debt needs no approval.
* `voxium/rules` is only ever written by a check against the default branch. PRs into another branch report as `voxium/rules (branch name)`. Require that name if you protect the branch.
* Files outside every module are followed: importing one counts as importing everything it leads to.
* Committed files are not skipped because of their folder name. List build output in `ignore` in the architecture file.
* If any source file cannot be read (over 1 MB, over the 40 MB total, symlinked, or excluded from archives), the check is an error, not a pass.

Repository settings that this depends on: require the `voxium/rules` status **with the Voxium app as its source** (otherwise anyone who can push can post that status), require branches to be up to date, and put `voxium/CODEOWNERS.suggested` in `.github/CODEOWNERS` with code owner review required.

The generated GitHub Actions job uses the rules from the default branch, but a PR can still edit workflow files. Without the platform, CODEOWNERS review is what protects them.

## Commands

* `init`: infer an architecture, write it with a baseline, agent rules and the CI workflow.
* `infer`: print the inferred architecture only.
* `check`: exit 1 on new blocking violations. Formats: text, json, github. `--rules-from <ref>` takes the rules and baseline from a git ref instead of the working tree.
* `generate`: regenerate agent rules, `.mcp.json` and the workflow from the architecture file.
* `mcp`: run the MCP server over stdio. Tools: `get_architecture`, `get_rules_for_path`, `check_import`, `check_change`, `propose_architecture_change`.

## Rule types

`layers`, `no_cycles`, `deny_dependency`, `deny_external`, `max_file_lines`. Exceptions need an owner, reason and expiry date.

## Known limits

* TypeScript, JavaScript and Vue files only. Imports resolve relative paths and `@/`, `~/` aliases, not tsconfig `paths`.
* Inference proposes modules from top level folders and orders layers by import direction. Modules with no imports between them are ordered arbitrarily, so review the layers.
* Agents can suggest architecture changes through MCP (saved as pending proposals), but nothing approves them yet. The approval flow belongs to the platform.
* Approval works through GitHub reviews, and GitHub does not let authors approve their own PR. A solo owner has to merge an architecture change with an admin override. The logged self approval in the spec is not built.
* Approval is only as trustworthy as the roles behind it. The first person to sign in becomes Owner of an installation, which still needs a stricter rule.
* Imports through symlinked folders, or in forms the import scanner does not recognise, are not seen.
* Without the platform, an exception that has already expired can be removed in a PR but not renewed without an admin override.
* Not built yet: org level approval flow for architecture changes, remote MCP server on Workers, billing, generated test files, Queues for large repos.
* The platform has been verified with unit tests and in the local Workers runtime with a local D1. It has not been run against a real GitHub App yet.
