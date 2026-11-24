#!/usr/bin/env node
// Exchange the one time manifest code for the app's credentials.
// Usage: node github-app/convert-manifest.mjs <code> [--out ./github-app/out]
// Writes the private key to a file (mode 600) and prints the settings to copy.
import fs from "node:fs";
import path from "node:path";

export function describeApp(app) {
  const vars = [
    `GITHUB_APP_ID=${app.id}`,
    `GITHUB_APP_SLUG=${app.slug}`,
    `GITHUB_CLIENT_ID=${app.client_id}`,
  ];
  const secrets = {
    GITHUB_CLIENT_SECRET: app.client_secret,
    GITHUB_WEBHOOK_SECRET: app.webhook_secret,
  };
  return { vars, secrets, pem: app.pem };
}

async function main() {
  const args = process.argv.slice(2);
  const code = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const outDir = path.resolve(outIdx !== -1 ? args[outIdx + 1] : "github-app/out");
  if (!code) {
    console.error("Usage: node github-app/convert-manifest.mjs <code> [--out dir]");
    process.exit(1);
  }
  const api = process.env.GITHUB_API ?? "https://api.github.com";
  const res = await fetch(`${api}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "voxium-setup" },
  });
  if (!res.ok) {
    console.error(`GitHub said ${res.status}. The code is single use and expires after one hour. Create the app again if needed.`);
    process.exit(1);
  }
  const { vars, secrets, pem } = describeApp(await res.json());

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const pemPath = path.join(outDir, "private-key.pem");
  fs.writeFileSync(pemPath, pem, { mode: 0o600 });
  const secretsPath = path.join(outDir, "secrets.env");
  const sessionSecret = (await import("node:crypto")).randomBytes(32).toString("hex");
  fs.writeFileSync(
    secretsPath,
    [...vars, ...Object.entries(secrets).map(([k, v]) => `${k}=${v}`), `SESSION_SECRET=${sessionSecret}`].join("\n") + "\n",
    { mode: 0o600 },
  );

  console.log("GitHub App created. Credentials saved (keep them private, never commit them):");
  console.log(`  ${pemPath}`);
  console.log(`  ${secretsPath}\n`);
  console.log("1. Put these in wrangler.jsonc under vars:");
  vars.forEach((v) => console.log(`     ${v}`));
  console.log("\n2. Set these as secrets (each command asks you to paste the value from secrets.env):");
  for (const k of [...Object.keys(secrets), "SESSION_SECRET"]) console.log(`     npx wrangler secret put ${k}`);
  console.log(`     npx wrangler secret put GITHUB_APP_PRIVATE_KEY < ${pemPath}`);
  console.log("\n3. For local development copy the same values into .dev.vars.");
  console.log("\nThen delete the out folder once the secrets are stored.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
