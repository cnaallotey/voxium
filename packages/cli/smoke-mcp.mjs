// End to end smoke test: talk to `voxium mcp` over stdio with the official MCP client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert";

const root = process.argv[2];
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist/cli.js");
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: "node", args: [cli, "mcp", "--root", root] }));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { error: r.isError === true, text, data: r.isError ? null : JSON.parse(text) };
};

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["check_change", "check_import", "get_architecture", "get_rules_for_path", "propose_architecture_change"]);

const arch = await call("get_architecture");
assert.deepEqual(arch.data.layers, ["ui", "services", "data", "shared"]);

const rules = await call("get_rules_for_path", { path: "src/services/new.ts" });
assert.equal(rules.data.module, "services");
assert.deepEqual(rules.data.mustNotImportFromModules, ["ui"]);

const up = await call("check_import", { from: "src/data/x.ts", target: "src/services/orders.ts" });
assert.equal(up.data.allowed, false);
const down = await call("check_import", { from: "src/ui/Page.ts", target: "src/data/db.ts" });
assert.equal(down.data.allowed, true);

const good = await call("check_change", {
  changes: [{ path: "src/ui/Page.ts", content: 'import { list } from "../services/orders";\nimport { money } from "../shared/format";\nexport const render = () => [list(), money(2)];\n' }],
});
assert.equal(good.data.ok, true);

const bad = await call("check_change", {
  changes: [{ path: "src/shared/format.ts", content: 'import { render } from "../ui/Page";\nexport const money = (n: number) => render() + n;\n' }],
});
assert.equal(bad.data.ok, false);
assert.ok(bad.data.introduced.some((v) => v.rule === "LAYER01"));

const esc = await call("get_rules_for_path", { path: "../secret" });
assert.equal(esc.error, true);
assert.match(esc.text, /inside the project/);

const prop = await call("propose_architecture_change", {
  title: "Add notifications module",
  summary: "New module between services and data",
  rationale: "Orders need to send emails without importing ui",
});
assert.equal(prop.data.status, "pending_approval");
assert.equal(prop.data.approvedBy, null);

await client.close();
console.log("MCP smoke test passed:", tools.join(", "));
console.log("good change ok, bad change introduced:", bad.data.introduced.map((v) => v.rule).join(", "));
