// Runtime agnostic entry point. No node:* imports, safe for Cloudflare Workers.
// Disk helpers live in "@voxium/core/node".
export * from "./types.js";
export { buildGraphFromFiles, isSourcePath, IGNORE_DIRS, SOURCE_EXT } from "./graph.js";
export type { FileMap, BuildGraphOptions } from "./graph.js";
export { extractImports, blankCommentsAndTemplates } from "./imports.js";
export { checkArchitecture, failing, assignModules, findCycles } from "./check.js";
export { inferArchitecture, orderLayers } from "./infer.js";
export { validateArchitecture } from "./schema.js";
export {
  renderAgentRules,
  renderWorkflow,
  renderCodeowners,
  upsertBlock,
  mergeMcpConfig,
  buildSetupFiles,
  BLOCK_START,
  BLOCK_END,
} from "./generate.js";
export type { SetupFilesInput } from "./generate.js";
export { globToRegExp, matchesAny } from "./glob.js";
export const ARCH_FILE_PATH = "voxium/architecture.json";
export const BASELINE_FILE_PATH = "voxium/baseline.json";
export {
  getArchitectureSummary,
  getRulesForPath,
  checkImport,
  checkChange,
  createProposal,
} from "./tools.js";
export type { ToolContext, ChangedFile, ProposalInput } from "./tools.js";
