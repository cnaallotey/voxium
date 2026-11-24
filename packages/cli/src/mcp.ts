import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  checkChange,
  checkImport,
  createProposal,
  getArchitectureSummary,
  getRulesForPath,
  type ToolContext,
} from "@voxium/core";
import { loadArchitecture, loadBaseline, readProjectFiles, writeJson } from "@voxium/core/node";

/** Read the project fresh on every call, so the agent always sees the current code and rules. */
function context(root: string): ToolContext {
  return { arch: loadArchitecture(root), files: readProjectFiles(root), baseline: loadBaseline(root) };
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: `Voxium error: ${(err as Error).message}` }] };
}

function guard<T>(fn: () => T) {
  try {
    return json(fn());
  } catch (err) {
    return fail(err);
  }
}

/** Repo relative posix path, never escaping the root. */
function cleanPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new Error(`Path "${p}" must stay inside the project.`);
    out.push(seg);
  }
  return out.join("/");
}

export function createServer(root: string): McpServer {
  const server = new McpServer({ name: "voxium", version: "0.0.1" });

  server.registerTool(
    "get_architecture",
    {
      description:
        "Get the project's enforced architecture: layers top to bottom, modules and their paths, and every rule with its reason. Read this before planning a change that touches several modules.",
      inputSchema: {},
    },
    async () => guard(() => getArchitectureSummary(context(root))),
  );

  server.registerTool(
    "get_rules_for_path",
    {
      description:
        "Before editing or creating a file, ask which module it belongs to and what it may and may not import. Returns allowed modules, forbidden modules, banned packages and applicable rules.",
      inputSchema: { path: z.string().describe("Repo relative path of the file you are about to edit or create") },
    },
    async ({ path }) => guard(() => getRulesForPath(context(root), cleanPath(path))),
  );

  server.registerTool(
    "check_import",
    {
      description:
        "Check one planned import before you write it. Target is a repo relative file path or a package name. Returns whether it is allowed, and if not, why and how to fix it.",
      inputSchema: {
        from: z.string().describe("Repo relative path of the importing file"),
        target: z.string().describe("Repo relative path of the imported file, or a package name such as 'pg'"),
      },
    },
    async ({ from, target }) =>
      guard(() => checkImport(context(root), cleanPath(from), /^[.\/]|\//.test(target) && !target.startsWith("@") ? cleanPath(target) : target)),
  );

  server.registerTool(
    "check_change",
    {
      description:
        "Check planned file changes against the architecture before you finish. Pass the full new content of each changed file (content null means delete). Returns only the violations your change would introduce.",
      inputSchema: {
        changes: z
          .array(
            z.object({
              path: z.string().describe("Repo relative path"),
              content: z.string().nullable().describe("Full new file content, or null to delete the file"),
            }),
          )
          .min(1),
      },
    },
    async ({ changes }) =>
      guard(() => checkChange(context(root), changes.map((c) => ({ path: cleanPath(c.path), content: c.content })))),
  );

  server.registerTool(
    "propose_architecture_change",
    {
      description:
        "Suggest a change to the architecture itself, for example a new module or a different layer order. You can suggest but cannot approve: the proposal is saved as pending and a Team Leader decides. Do not edit voxium/architecture.json yourself.",
      inputSchema: {
        title: z.string().min(3),
        summary: z.string().describe("What should change"),
        rationale: z.string().describe("Why the current architecture blocks the work"),
        suggestedChange: z.string().optional().describe("Optional concrete suggestion"),
      },
    },
    async (input) =>
      guard(() => {
        const proposal = createProposal({ ...input, requestedBy: "agent" });
        writeJson(root, `voxium/proposals/${proposal.id}.json`, proposal);
        return { saved: `voxium/proposals/${proposal.id}.json`, ...proposal };
      }),
  );

  return server;
}

export async function runMcp(root: string): Promise<void> {
  // Fail fast with a clear message if the project is not set up.
  loadArchitecture(root);
  const server = createServer(root);
  await server.connect(new StdioServerTransport());
}
