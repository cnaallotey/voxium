#!/usr/bin/env node
// Exchange the one time manifest code for the app's credentials.
// Usage: node github-app/convert-manifest.mjs <code> [--out dir | --dev-vars [file]]
//   --dev-vars  put everything straight into .dev.vars for local development, and nowhere else.
// Writes to the git ignored "out" folder next to this script, wherever it is run from.
// Writes the private key to a file (mode 600) and prints the settings to copy.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** Set keys in a .dev.vars file, keeping every other line. A real session secret that is already there stays. */
export function mergeDevVars(text, values, sessionSecret) {
  const lines = text ? text.replace(/\n+$/, "").split("\n") : [];
  const keyOf = (l) => /^([A-Z_]+)=/.exec(l)?.[1];
  const session = lines.find((l) => keyOf(l) === "SESSION_SECRET")?.slice("SESSION_SECRET=".length);
  const all = { ...values };
  if (!session || session.startsWith("change-me")) all.SESSION_SECRET = sessionSecret;
  const kept = lines.filter((l) => !(keyOf(l) in all));
  if (!kept.some((l) => keyOf(l) === "APP_URL")) kept.unshift("APP_URL=http://localhost:3000");
  return `${[...kept, ...Object.entries(all).map(([k, v]) => `${k}=${v}`)].join("\n")}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outIdx = args.indexOf("--out");
  const devIdx = args.indexOf("--dev-vars");
  const valueAfter = (i) => (i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? i + 1 : -1);
  // The code comes first. A value after --dev-vars is a file only when the code was given before it.
  const code = args.find((a, i) => !a.startsWith("--") && i !== valueAfter(outIdx));
  const devFile = devIdx > args.indexOf(code) && valueAfter(devIdx) !== -1 ? path.resolve(args[devIdx + 1]) : path.join(here, "../.dev.vars");
  const outDir = outIdx !== -1 ? path.resolve(args[outIdx + 1]) : path.join(here, "out");
  if (!code) {
    console.error("Usage: node github-app/convert-manifest.mjs <code> [--out dir | --dev-vars [file]]");
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
  const sessionSecret = (await import("node:crypto")).randomBytes(32).toString("hex");

  if (devIdx !== -1) {
    const values = Object.fromEntries(vars.map((v) => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)]));
    // One line with \n in it. Both wrangler and the app accept that.
    Object.assign(values, secrets, { GITHUB_APP_PRIVATE_KEY: `"${pem.trim().replace(/\r?\n/g, "\\n")}"` });
    const old = fs.existsSync(devFile) ? fs.readFileSync(devFile, "utf8") : "";
    fs.writeFileSync(devFile, mergeDevVars(old, values, sessionSecret), { mode: 0o600 });
    fs.chmodSync(devFile, 0o600);
    console.log(`GitHub App created. Credentials stored in ${devFile} (git ignored, keep it private).`);
    console.log("Restart Voxium so it reads them, then sign in.");
    return;
  }

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const pemPath = path.join(outDir, "private-key.pem");
  fs.writeFileSync(pemPath, pem, { mode: 0o600 });
  const secretsPath = path.join(outDir, "secrets.env");
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
  console.log("\n3. For local development use --dev-vars instead, which fills .dev.vars for you.");
  console.log("\nThen delete the out folder once the secrets are stored.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
