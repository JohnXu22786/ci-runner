/**
 * Configuration model for ci-runner — the single canonical shape shared by
 * the dsh adapter, the CLI and any embedding code.
 *
 * Defaults live in {@link DEFAULT_CONFIG}; {@link normalizeConfig} folds a
 * partial user config over them via {@link mergeConfig} and validates every
 * field the plugin reads. The dsh adapter additionally exposes the same shape
 * as a Schemastery schema (see adapter.js) so the harness validates and
 * default-fills the config before it reaches {@link normalizeConfig}.
 */

/** Canonical default configuration. */
export const DEFAULT_CONFIG = {
  github: {
    /** Environment variable that holds the GitHub token. Read at call time, never logged or persisted. */
    tokenEnv: 'GITHUB_TOKEN',
    /** Default repository as `owner/repo`; overridable on every call. */
    defaultRepo: '',
    /** Default ref used by GitHub triggers that do not pass one. */
    defaultBranch: 'main',
    /** REST API base; override for GitHub Enterprise / proxies to the API. */
    apiBase: 'https://api.github.com',
    /** Poll cadence used by status tracking, in milliseconds. */
    pollIntervalMs: 5000,
    /** Hard cap on how long a watch waits for a run to finish, in milliseconds. */
    pollTimeoutMs: 10 * 60 * 1000,
    /** How long a freshly dispatched run may take to surface a run id, in milliseconds. */
    dispatchWindowMs: 20000,
    /** Per-request HTTP timeout, in milliseconds. */
    requestTimeoutMs: 30000,
    /** Default character cap when reading run logs back. */
    readLogChars: 30000,
  },
  local: {
    /** Working directory for local command runs (relative to process cwd). */
    cwd: '.',
    /** Hard timeout per command, in milliseconds. */
    timeoutMs: 120000,
    /** Per-stream output cap in characters; keeps tool results bounded. */
    maxOutputChars: 40000,
    /** Named command templates; referenced by tools and the CLI as `template`. */
    templates: [
      { name: 'npm test', command: 'npm test' },
      { name: 'pytest', command: 'pytest' },
    ],
  },
  diagnosis: {
    /** Optional OpenAI-compatible endpoint override ({ baseUrl, apiKey, model }). Uses ctx.llm otherwise. */
    llm: null,
    /** ctx.llm provider route; '' = auto (first registered provider). */
    provider: '',
    /** ctx.llm model; '' = auto (first listed model of the provider). */
    model: '',
    /** Characters of the log tail handed to the model. */
    maxTailChars: 12000,
    /** Hard budget for the analysis call itself, in milliseconds. */
    timeoutMs: 120000,
    /** Sampling temperature for the diagnosis call. */
    temperature: 0.2,
    /** Provider label used in reports when the endpoint is configured. */
    providerLabel: 'OpenAI-compatible',
  },
}

/**
 * Deep-merge `patch` over `base` for plain objects; arrays and scalars from
 * `patch` win. Never mutates either argument.
 */
export function mergeConfig(base, patch) {
  if (patch === undefined || patch === null) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return patch
  }
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return patch
  }
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = mergeConfig(base[key], value)
  }
  return out
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInt(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`config.${label} must be a positive integer`)
  }
  return value
}

/**
 * Fold any partial config over {@link DEFAULT_CONFIG} and validate every
 * field ci-runner reads. Heavy schema validation also happens on the dsh
 * side; this is the last line of defence for the CLI and embedding code.
 */
export function normalizeConfig(input = {}) {
  const cfg = mergeConfig(structuredClone(DEFAULT_CONFIG), input ?? {})

  if (typeof cfg.github.tokenEnv !== 'string' || cfg.github.tokenEnv.length === 0) {
    throw new TypeError('config.github.tokenEnv must be a non-empty string')
  }
  if (typeof cfg.github.defaultRepo !== 'string') {
    throw new TypeError('config.github.defaultRepo must be a string like "owner/repo"')
  }
  if (cfg.github.defaultRepo !== '' && !/^[^\s/]+\/[^/]+$/.test(cfg.github.defaultRepo)) {
    throw new TypeError('config.github.defaultRepo must be "owner/repo" (no scheme, no trailing slash)')
  }
  if (typeof cfg.github.defaultBranch !== 'string' || cfg.github.defaultBranch.length === 0) {
    throw new TypeError('config.github.defaultBranch must be a non-empty string')
  }
  if (typeof cfg.github.apiBase !== 'string' || !/^https?:\/\//.test(cfg.github.apiBase)) {
    throw new TypeError('config.github.apiBase must be an http(s) URL')
  }
  cfg.github.pollIntervalMs = isPositiveInt(cfg.github.pollIntervalMs, 'github.pollIntervalMs')
  cfg.github.pollTimeoutMs = isPositiveInt(cfg.github.pollTimeoutMs, 'github.pollTimeoutMs')
  cfg.github.dispatchWindowMs = isPositiveInt(cfg.github.dispatchWindowMs, 'github.dispatchWindowMs')
  cfg.github.requestTimeoutMs = isPositiveInt(cfg.github.requestTimeoutMs, 'github.requestTimeoutMs')
  if (!Number.isInteger(cfg.github.readLogChars) || cfg.github.readLogChars < 100) {
    throw new TypeError('config.github.readLogChars must be an integer >= 100')
  }

  if (typeof cfg.local.cwd !== 'string') {
    throw new TypeError('config.local.cwd must be a string')
  }
  cfg.local.timeoutMs = isPositiveInt(cfg.local.timeoutMs, 'local.timeoutMs')
  if (!Number.isInteger(cfg.local.maxOutputChars) || cfg.local.maxOutputChars < 100) {
    throw new TypeError('config.local.maxOutputChars must be an integer >= 100')
  }
  if (!Array.isArray(cfg.local.templates)) {
    throw new TypeError('config.local.templates must be an array of { name, command }')
  }
  const seen = new Set()
  cfg.local.templates = cfg.local.templates.map((entry, index) => {
    if (!entry || typeof entry.name !== 'string' || entry.name.length === 0
      || typeof entry.command !== 'string' || entry.command.length === 0) {
      throw new TypeError(`config.local.templates[${index}] needs non-empty "name" and "command"`
        + ' as an array of { name, command } entries')
    }
    if (seen.has(entry.name)) {
      throw new TypeError(`config.local.templates has a duplicate name "${entry.name}"`)
    }
    seen.add(entry.name)
    return { name: entry.name, command: entry.command }
  })

  if (cfg.diagnosis.llm !== null && cfg.diagnosis.llm !== undefined) {
    const llm = cfg.diagnosis.llm
    if (!isPlainObject(llm) || typeof llm.baseUrl !== 'string' || !/^https?:\/\//.test(llm.baseUrl)) {
      throw new TypeError('config.diagnosis.llm.baseUrl must be an http(s) URL')
    }
    if (llm.apiKey !== undefined && llm.apiKey !== null && typeof llm.apiKey !== 'string') {
      throw new TypeError('config.diagnosis.llm.apiKey must be a string')
    }
    if (llm.model !== undefined && llm.model !== null && typeof llm.model !== 'string') {
      throw new TypeError('config.diagnosis.llm.model must be a string')
    }
    cfg.diagnosis.llm = {
      baseUrl: llm.baseUrl,
      apiKey: typeof llm.apiKey === 'string' && llm.apiKey.length > 0 ? llm.apiKey : '',
      model: typeof llm.model === 'string' && llm.model.length > 0 ? llm.model : 'deepseek-chat',
    }
  } else {
    cfg.diagnosis.llm = null
  }
  if (typeof cfg.diagnosis.provider !== 'string') {
    throw new TypeError('config.diagnosis.provider must be a string ("" = auto)')
  }
  if (typeof cfg.diagnosis.model !== 'string') {
    throw new TypeError('config.diagnosis.model must be a string ("" = auto)')
  }
  if (!Number.isInteger(cfg.diagnosis.maxTailChars) || cfg.diagnosis.maxTailChars < 200) {
    throw new TypeError('config.diagnosis.maxTailChars must be an integer >= 200')
  }
  cfg.diagnosis.timeoutMs = isPositiveInt(cfg.diagnosis.timeoutMs, 'diagnosis.timeoutMs')
  if (typeof cfg.diagnosis.temperature !== 'number'
    || cfg.diagnosis.temperature < 0 || cfg.diagnosis.temperature > 1) {
    throw new TypeError('config.diagnosis.temperature must be a number in [0, 1]')
  }
  if (typeof cfg.diagnosis.providerLabel !== 'string') {
    cfg.diagnosis.providerLabel = DEFAULT_CONFIG.diagnosis.providerLabel
  }
  return cfg
}

/** Index local templates by name. */
export function templateMap(cfg) {
  return Object.fromEntries(cfg.local.templates.map((entry) => [entry.name, entry.command]))
}

/**
 * Resolve a local run command: if `nameOrCommand` names a configured
 * template, its command is used verbatim; otherwise the value is treated as a
 * raw shell command line. A missing name falls back to the configured
 * default template or the DEFAULT_CONFIG first template.
 */
export function resolveTemplate(cfg, nameOrCommand) {
  const map = templateMap(cfg)
  if (typeof nameOrCommand === 'string' && nameOrCommand.length > 0) {
    if (Object.hasOwn(map, nameOrCommand)) return map[nameOrCommand]
    return nameOrCommand
  }
  const first = cfg.local.templates[0] ?? DEFAULT_CONFIG.local.templates[0]
  return first?.command ?? 'npm test'
}

/** Normalize a user-supplied GitHub repo argument into `owner/repo`. */
export function parseRepoArg(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new TypeError('repo must be a string like "owner/repo"')
  }
  if (!/^[^\s/]+\/[^/]+$/.test(value)) {
    throw new TypeError(`invalid repository "${value}" — expected "owner/repo"`)
  }
  return value
}