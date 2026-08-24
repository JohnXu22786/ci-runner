/**
 * ci-runner — public package surface.
 *
 * This module is the npm `main` entry and stays free of harness imports, so
 * embedding plugins, the CLI and test suites can use it without any
 * dependency on the dsh ecosystem. The Cordis plugin contract lives on the
 * `./adapter` subpath (`dsh-ci-runner/adapter`) and is what the bundle patch
 * row mounts.
 */

export {
  DEFAULT_CONFIG, mergeConfig, normalizeConfig,
  templateMap, resolveTemplate, parseRepoArg,
} from './config.js'
export { GitHubApi, GithubError } from './github.js'
export { LocalRunner, runLocalCommand } from './local.js'
export { BoundedBuffer, tailChars, tailLines, stripAnsi, cleanLog, maskOccurrences } from './logs.js'
export { CATEGORY_LABELS, CATEGORY_ORDER, classifyFailure, categoryLabel } from './classify.js'
export {
  DEFAULT_LLM_BASE_URL, AnalysisError, SYSTEM_PROMPT,
  OpenAiCompatibleClient, buildDiagnosisPrompt, extractCompletionText, extractSections,
} from './llm.js'
export { buildRunMeta, assembleReport } from './diagnose.js'
export {
  CiService, githubFailedStage,
} from './service.js'
export { defineCiTools } from './tools.js'
