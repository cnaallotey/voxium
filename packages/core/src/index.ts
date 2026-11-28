// Runtime agnostic entry point. No node:* imports, safe for Cloudflare Workers.
// Disk helpers live in "@voxium/core/node".
export * from "./types.js";
export { buildGraphFromFiles, expandSymlinks, isSourcePath, IGNORE_DIRS, SOURCE_EXT } from "./graph.js";
export type { FileMap, BuildGraphOptions, ScanCache } from "./graph.js";
export { isConfigPath, readJsonc } from "./resolve.js";
export { extractImports, extractVueScript, findImports, scanImports, blankCommentsAndTemplates } from "./imports.js";
export type { FoundImport, ImportScan, ManyImports, OpaqueImport, ScanOptions } from "./imports.js";
export { checkArchitecture, failing, uncheckedPaths, unparsedFiles, assignModules, findCycles, fileDependencies, moduleConnections, moduleDependencies, needsConnections } from "./check.js";
export type { Dependency } from "./check.js";
export { locateCycle } from "./cycles.js";
export { inferArchitecture, orderLayers, detectBuildOutput, detectFrameworks, rateArchitecture, defaultRules, layersDescription } from "./infer.js";
export { applyTemplate, isTemplateName, TEMPLATE_NAMES } from "./templates.js";
export type { TemplateName } from "./templates.js";
export { applyEdits, globCost, globWork, MAX_GLOB_WORK, referencedModules } from "./edit.js";
export type { ArchitectureEdits, ModuleEdit, RuleEdit, EditCounts, EditResult } from "./edit.js";
export { validateArchitecture, exceptionErrors, EVERY_MODULE, NAMING_STYLES } from "./schema.js";
export { namingProblem, nameStem } from "./conventions.js";
export {
  renderAgentRules,
  renderWorkflow,
  renderCodeowners,
  upsertBlock,
  mergeMcpConfig,
  parseCliPackage,
  cliPackageInWorkflow,
  buildSetupFiles,
  renderCursorRules,
  renderGitlabCi,
  renderPreCommit,
  expectedBlock,
  BLOCK_START,
  BLOCK_END,
  PRE_COMMIT_PATH,
  CODEOWNERS_PATH,
} from "./generate.js";
export { dependencyCruiserRules, renderDependencyCruiser, globSource, DEPCRUISE_FILE_PATH } from "./depcruise.js";
export type { CruiserRule } from "./depcruise.js";
export type { SetupFilesInput } from "./generate.js";
export { compileGlobs, globToRegExp, matchesAny, matchesGlob } from "./glob.js";
export {
  ARCH_FILE_PATH,
  BASELINE_FILE_PATH,
  WORKFLOW_FILE_PATH,
  GITLAB_FILE_PATH,
  PROTECTED_FILES,
  AGENT_FILES,
  CURSOR_RULES_PATH,
  CURSOR_FRONTMATTER,
  parseBaseline,
  tightenBaseline,
  findProtectedChanges,
  blockState,
  agentFileState,
  blockLabel,
  isBlockLabel,
  blocksToCompare,
  changedBlocks,
} from "./protect.js";
export type { ProtectedContents, BlockState } from "./protect.js";
export { describeRuleChanges } from "./changes.js";
export {
  getArchitectureSummary,
  getRulesForPath,
  checkImport,
  checkChange,
  createProposal,
  parseProposal,
  MAX_PROPOSAL_BYTES,
} from "./tools.js";
export type { ToolContext, ChangedFile, ProposalInput, Proposal, ProposalChange, ParsedProposal } from "./tools.js";
export { buildSnapshot, forbiddenEdge, MAX_SNAPSHOT_BYTES } from "./snapshot.js";
export type { Snapshot } from "./snapshot.js";
export { applyOrgRules, effectiveRules, matchesOrgRule, orgRuleErrors, overrideErrors, MAX_ORG_RULES, MAX_OVERRIDES, ORG_PREFIX, ORG_RULE_TYPES } from "./org.js";
export type { OrgApplied, OrgRuleSet } from "./org.js";
