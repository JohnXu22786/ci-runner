/**
 * Heuristic failure classification — a fast, dependency-free pre-analysis that
 * runs before the model is consulted. It feeds the deterministic "Error
 * Classification" section of the report (so a report is still useful without
 * an LLM endpoint) and gives the model a strong prior to build on.
 */

/** Human-readable labels for every category. */
export const CATEGORY_LABELS = {
  build: 'Build / compile error',
  dependency: 'Dependency resolution failure',
  test: 'Test failure',
  syntax: 'Syntax / parse error',
  lint: 'Lint / formatting error',
  config: 'CI / workflow configuration error',
  timeout: 'Timeout / hang',
  auth: 'Authentication / permission error',
  infra: 'Infrastructure / network error',
  unknown: 'Unclassified',
}

/** Categories in priority order (first match wins for the headline). */
export const CATEGORY_ORDER = [
  'config',
  'auth',
  'dependency',
  'build',
  'syntax',
  'lint',
  'test',
  'timeout',
  'infra',
]

/**
 * Regex rules, ordered most-specific first. The first rule whose regex
 * matches decides the category; every matched rule's category is reported as
 * a hint. Anchored alternations avoid false positives on short logs.
 */
const RULES = [
  { category: 'timeout', re: /\b(time limit exceeded|timed out|maximum execution time|killed by (timeout|signal)|command terminated|did not finish within)\b|run exceeded the maximum/i },
  { category: 'config', re: /the workflow is not valid|workflow_dispatch|no .*trigger|unexpected value|invalid.*workflow|\.github[\\/]workflows|error while parsing|not a valid (branch|value)/i },
  { category: 'auth', re: /resource not accessible|permission denied|not authorized|unauthorized|authentication failed|insufficient permissions|credentials? (invalid|wrong|expired)|remote:.*denied/i },
  { category: 'dependency', re: /cannot find module|module not found|no such file or directory|no such module|import error|internal error|npm err! 404|eresolve|etarget|enetget|eintegrity|404.*registry|resolution failed|unable to resolve|could not be resolved|not found:|command not found|npx:.*not found|download.*failed|install.*failed/i },
  { category: 'build', re: /error ts\d{4}|cannot find name|failed to compile|compilation error|failed building|\[tsc\]|\btsc\b.*error|\.tsx?:\d.*error|\.tsx?:\d|error:\s*cannot|gcc:|collect2:|make:\s*\*\*\*|build.*failed/i },
  { category: 'syntax', re: /\bsyntaxerror\b|unexpected token|unexpected identifier|parsing error|invalid syntax|missing final }|unterminated string/i },
  { category: 'lint', re: /\beslint\b|\bprettier\b|\blint(ing)?\b|\bno-undef\b|\bno-unused-vars\b|rule:\s*\d+$/i },
  { category: 'test', re: /assertion|assert\b|failed to run|tests? failed|test failure|\bfailures?:\s*[1-9]|\btotal: \d+.*failed|expected .* to (equal|be|match|contain|throw)|pytest.*error|mocha.*fail|check.*failed|unittest.*fail|\b1 failed\b/i },
  { category: 'infra', re: /connection (refused|reset|closed)|econnrefused|enetunreach|enetdown|eai_again|network is unreachable|temporarily unavailable|\b(502|503|504|429)\b|rate limit|ssl certificate|self-signed|socket hang up|read econnreset|no route to host/i },
]

/**
 * Classify a failure from its log tail and run metadata.
 * @param {object} input
 * @param {string} [input.log] cleaned log text
 * @param {number} [input.exitCode] process exit code
 * @param {boolean} [input.killed] true when the run was killed by a timeout
 * @returns {{category: string, hints: string[], exitCode: number|null, killed: boolean}}
 */
export function classifyFailure(input = {}) {
  const log = typeof input.log === 'string' ? input.log : String(input.log ?? '')
  const killed = Boolean(input.killed)
  const exitCode = typeof input.exitCode === 'number' ? input.exitCode : null

  if (killed) {
    return { category: 'timeout', hints: ['killed by timeout or cancellation'], exitCode, killed }
  }

  const hints = []
  let headline = 'unknown'
  for (const rule of RULES) {
    if (rule.re.test(log)) {
      hints.push(rule.category)
      if (headline === 'unknown') headline = rule.category
    }
  }
  // Non-zero exit with no matching pattern is still worth flagging as a
  // "test" style failure when it comes from a test runner convention.
  if (headline === 'unknown' && exitCode > 0 && /\b(test|spec|suite)\b/i.test(log)) {
    headline = 'test'
    if (!hints.includes('test')) hints.push('test')
  }
  return { category: headline, hints: [...new Set(hints)], exitCode, killed }
}

/** Label for a category id. */
export function categoryLabel(category) {
  return CATEGORY_LABELS[category] ?? category
}
