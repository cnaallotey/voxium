# Create and connect the Voxium GitHub App

You need a public URL first, because GitHub sends webhooks to it.

* Production: deploy once with `npm run cf:deploy` and use the `*.workers.dev` URL (or your own domain).
* Local testing: run `npm run cf:preview` and expose it with a tunnel (for example `cloudflared tunnel --url http://localhost:8787`). Use the tunnel URL below.

## 1. Create the app

1. Open `github-app/create-app.html` in your browser.
2. Enter your URL, pick an app name (names are unique on GitHub), and an organization login if the app should belong to an org.
3. Click **Create GitHub App** and confirm on GitHub.
4. GitHub redirects to `<URL>/setup/github-app`, which shows a one time code and the command to run.

Permissions requested: Contents (write), Pull requests (write), Commit statuses (write), Workflows (write), Metadata (read). Workflows is needed because the setup pull request adds `.github/workflows/voxium.yml`. Events: Pull request and Pull request review (reviews carry Team Leader approvals). GitHub always sends installation events for apps with webhooks on, so those need no extra subscription.

## 2. Get the credentials

    node packages/platform/github-app/convert-manifest.mjs <code>

This writes `github-app/out/private-key.pem` and `github-app/out/secrets.env` (both mode 600, git ignored) and prints the next steps:

* Put `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_CLIENT_ID` in `wrangler.jsonc` under `vars`. Set `APP_URL` to your URL.
* Store the rest as secrets with `npx wrangler secret put NAME`.
* For local dev copy the same values into `.dev.vars`.
* Delete `github-app/out` once the secrets are stored.

## 3. Create the database and deploy

    npx wrangler d1 create voxium          # put the id in wrangler.jsonc
    npm run db:migrate:remote
    npm run cf:deploy

## 4. Try it end to end

1. Visit your URL and sign in with GitHub.
2. Install the app on a small test repository (the dashboard has an install link).
3. Back on the dashboard, click **Set up Voxium** on the repo. A pull request appears with the architecture file, baseline, agent rules, CI workflow and MCP config.
4. Review `voxium/architecture.json` and merge.
5. Open a pull request that breaks a layer rule. A `voxium/rules` status appears on it within a few seconds and fails with the rule names. Open the repo page on the dashboard to see the check result.
6. In the PR, edit `voxium/architecture.json` to weaken a rule. The check fails and asks for Team Leader approval, whatever the code looks like. Approve the PR from another account that is an Owner or Team Leader and has write access, and it is checked again by the new rules.

## 5. Make it required

In branch protection or a ruleset for the default branch, require the status `voxium/rules` and choose the Voxium app as its source. Also require branches to be up to date and review from code owners.

## If something does not work

* Webhook deliveries are listed under the app's **Advanced** tab on GitHub. A 401 means `GITHUB_WEBHOOK_SECRET` does not match.
* `wrangler tail` shows Worker logs, including failed repo syncs and failed checks.
* Setup failed with an access message: make sure the repository is selected in the app installation.
* No status on a PR: the base branch needs `voxium/architecture.json`, so merge the setup PR first.
