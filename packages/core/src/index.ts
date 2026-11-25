// Runtime agnostic entry point. No node:* imports, safe for Cloudflare Workers.
// Disk helpers live in "@voxium/core/node".
export * from "./types.js";
export { buildGraphFromFiles, expandSymlinks, isSourcePath, IGNORE_DIRS, SOURCE_EXT } from "./graph.js";
export type { FileMap, BuildGraphOptions } from "./graph.js";
export { extractImports, blankCommentsAndTemplates } from "./imports.js";
export { checkArchitecture, failing, assignModules, findCycles, moduleDependencies } from "./check.js";
export type { Dependency } from "./check.js";
export { inferArchitecture, orderLayers, detectBuildOutput } from "./infer.js";
export { validateArchitecture } from "./schema.js";
export {
  renderAgentRules,
  renderWorkflow,
  renderCodeowners,
  upsertBlock,
  mergeMcpConfig,
  parseCliPackage,
  cliPackageInWorkflow,
  buildSetupFiles,
  BLOCK_START,
  BLOCK_END,
} from "./generate.js";
export type { SetupFilesInput } from "./generate.js";
export { globToRegExp, matchesAny } from "./glob.js";
export {
  ARCH_FILE_PATH,
  BASELINE_FILE_PATH,
  WORKFLOW_FILE_PATH,
  PROTECTED_FILES,
  parseBaseline,
  tightenBaseline,
  findProtectedChanges,
} from "./protect.js";
export type { ProtectedContents } from "./protect.js";
export {
  getArchitectureSummary,
  getRulesForPath,
  checkImport,
  checkChange,
  createProposal,
} from "./tools.js";
export type { ToolContext, ChangedFile, ProposalInput } from "./tools.js";
