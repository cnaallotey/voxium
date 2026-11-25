# Create and connect the Voxium GitHub App

You need a public URL first, because GitHub sends webhooks to it.

* Production: deploy once with `npm run cf:deploy` and use the `*.workers.dev` URL (or your own domain).
* Local testing: run `npm run cf:preview -- --port 3000` and, in another terminal, `cloudflared tunnel --url http://localhost:3000`. Use `http://localhost:3000` as your URL and the tunnel as the webhook URL. A quick tunnel gets a new address every time, so update the webhook URL in the app settings on GitHub when you restart it. Sign in keeps working without a tunnel.

## 1. Create the app

1. Open `github-app/create-app.html` in your browser.
2. Enter your URL, pick an app name (names are unique on GitHub), and an organization login if the app should belong to an org.
3. Click **Create GitHub App** and confirm on GitHub.
4. GitHub redirects to `<URL>/setup/github-app`, which shows a one time code and the command to run.

Permissions requested: Contents (write), Pull requests (write), Commit statuses (write), Workflows (write), Metadata (read), organization Members (read). Members is how the platform tells who is an organization admin, and means an organization owner has to approve the installation. Workflows is needed because the setup pull request adds `.github/workflows/voxium.yml` once `VOXIUM_CLI_PACKAGE` names a published CLI. Events: Pull request and Pull request review (reviews carry Team Leader approvals). GitHub always sends installation events for apps with webhooks on, so those need no extra subscription.

## 2. Get the credentials

    node packages/platform/github-app/convert-manifest.mjs <code>

This writes `private-key.pem` and `secrets.env` to `packages/platform/github-app/out` (both mode 600, git ignored, wherever you run it from) and prints the next steps:

* Put `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_CLIENT_ID` in `wrangler.jsonc` under `vars`. Set `APP_URL` to your URL.
* Store the rest as secrets with `npx wrangler secret put NAME`.
* For local dev add `--dev-vars` to the command. It writes everything to `.dev.vars` and nothing to `out`. Restart Voxium afterwards.
* Delete `github-app/out` once the secrets are stored.

## 3. Create the database and deploy

    npx wrangler d1 create voxium          # put the id in wrangler.jsonc
    npm run db:migrate:remote
    npm run cf:deploy

## 4. Try it end to end

1. Visit your URL and sign in with GitHub.
2. Install the app on a small test repository (the dashboard has an install link). GitHub then sends you through sign in again, which is when your role and repos are read.
3. Back on the dashboard, click **Set up Voxium** on the repo. A pull request appears with the architecture file, baseline and agent rules (and, once `VOXIUM_CLI_PACKAGE` is set, the CI workflow and MCP config).
4. Review `voxium/architecture.json` and merge.
5. Open a pull request that breaks a layer rule. A `voxium/rules` status appears on it within a few seconds and fails with the rule names. Open the repo page on the dashboard to see the check result.
6. In the PR, edit `voxium/architecture.json` to weaken a rule. The check fails and asks for Team Leader approval, whatever the code looks like. Approve the PR from another account that is an Owner or Team Leader and has write access, and it is checked again by the new rules.

## 5. Make it required

In branch protection or a ruleset for the default branch, require the status `voxium/rules` and choose the Voxium app as its source. Also require branches to be up to date and review from code owners.

## If something does not work

* The dashboard says it could not read your access: the app is suspended or the organization Members permission is not approved yet. After that use **Refresh access**. With single sign on, start a session at GitHub first.
* Setup refuses because of a file it cannot read: code imports that file, so it cannot be left out. Files over 4 MB that nothing imports are proposed under `ignore` in the setup PR.

* Webhook deliveries are listed under the app's **Advanced** tab on GitHub. A 401 means `GITHUB_WEBHOOK_SECRET` does not match.
* `wrangler tail` shows Worker logs, including failed repo syncs and failed checks.
* Setup failed with an access message: make sure the repository is selected in the app installation.
* No status on a PR: the base branch needs `voxium/architecture.json`, so merge the setup PR first.
