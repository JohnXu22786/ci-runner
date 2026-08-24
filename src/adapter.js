/**
 * dsh adapter — the pluggable surface the harness mounts.
 *
 * Loading this module through Cordis (via the bundle patch row in
 * cordis.patch.yml) mounts the plugin: on activation it builds a CiService,
 * registers the five ci_* tools, and returns a disposer that unregisters them
 * all on unload or config hot-reload.
 *
 * Exports expected by Cordis: `name`, `Config` (Schemastery schema), `inject`
 * (services it needs) and `apply(ctx, config)`. The `llm` service is injected
 * OPTIONALLY (`-llm`): when absent, diagnosis falls back to a configured
 * OpenAI-compatible endpoint, and otherwise to the deterministic report.
 */

import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_CONFIG, normalizeConfig } from './config.js'
import { CiService } from './service.js'
import { defineCiTools } from './tools.js'
import { createDshLlmAnalyzer } from './dsh-llm.js'

export const name = 'ci-runner'

/** Services this plugin needs before it activates; `llm` is optional. */
export const inject = ['tools', '-llm']

const TemplateSchema = Schema.object({
  name: Schema.string().required(),
  command: Schema.string().required(),
})

const EndpointSchema = Schema.object({
  baseUrl: Schema.string().default('https://api.deepseek.com/v1'),
  apiKey: Schema.string().default(''),
  model: Schema.string().default('deepseek-chat'),
})

/** Validated configuration, defaulted by the harness loader. */
export const Config = Schema.object({
  github: Schema.object({
    tokenEnv: Schema.string().default(DEFAULT_CONFIG.github.tokenEnv),
    defaultRepo: Schema.string().default(DEFAULT_CONFIG.github.defaultRepo),
    defaultBranch: Schema.string().default(DEFAULT_CONFIG.github.defaultBranch),
    apiBase: Schema.string().default(DEFAULT_CONFIG.github.apiBase),
    pollIntervalMs: Schema.natural().min(100).default(DEFAULT_CONFIG.github.pollIntervalMs),
    pollTimeoutMs: Schema.natural().min(1000).default(DEFAULT_CONFIG.github.pollTimeoutMs),
    dispatchWindowMs: Schema.natural().min(1000).default(DEFAULT_CONFIG.github.dispatchWindowMs),
    requestTimeoutMs: Schema.natural().min(1000).default(DEFAULT_CONFIG.github.requestTimeoutMs),
    readLogChars: Schema.natural().min(100).default(DEFAULT_CONFIG.github.readLogChars),
  }).default({}),
  local: Schema.object({
    cwd: Schema.string().default(DEFAULT_CONFIG.local.cwd),
    timeoutMs: Schema.natural().min(1).default(DEFAULT_CONFIG.local.timeoutMs),
    maxOutputChars: Schema.natural().min(100).default(DEFAULT_CONFIG.local.maxOutputChars),
    templates: Schema.array(TemplateSchema).default(DEFAULT_CONFIG.local.templates),
  }).default({}),
  diagnosis: Schema.object({
    llm: Schema.union([EndpointSchema, Schema.const(null)]).default(null),
    provider: Schema.string().default(DEFAULT_CONFIG.diagnosis.provider),
    model: Schema.string().default(DEFAULT_CONFIG.diagnosis.model),
    maxTailChars: Schema.natural().min(200).default(DEFAULT_CONFIG.diagnosis.maxTailChars),
    timeoutMs: Schema.natural().min(1000).default(DEFAULT_CONFIG.diagnosis.timeoutMs),
    temperature: Schema.number().min(0).max(1).default(DEFAULT_CONFIG.diagnosis.temperature),
    providerLabel: Schema.string().default(DEFAULT_CONFIG.diagnosis.providerLabel),
  }).default({}),
}).default({})

/**
 * Cordis activation entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] validated by {@link Config}
 * @returns {(() => void) | undefined} disposer unregistering every tool
 */
export function apply(ctx, config = {}) {
  let cfg
  try {
    cfg = normalizeConfig(config ?? {})
  } catch (error) {
    ctx.logger?.warn?.(`ci-runner: invalid config: ${error.message}`)
    return undefined
  }

  const service = new CiService(cfg, {
    logger: ctx.logger,
    // Route analysis through the host LLM when present (resolved lazily so
    // late adapter registrations are honored).
    llmAnalyzer: () => createDshLlmAnalyzer(ctx.llm, {
      provider: cfg.diagnosis.provider,
      model: cfg.diagnosis.model,
    }, ctx.logger),
  })

  const disposers = []
  for (const tool of defineCiTools(service, cfg)) {
    try {
      disposers.push(ctx.tools.register(tool))
    } catch (error) {
      ctx.logger?.warn?.(`ci-runner: could not register tool "${tool.name}": ${error.message}`)
    }
  }

  ctx.logger?.info?.(`ci-runner: registered ${disposers.length} tool(s)`)
  if (disposers.length === 0) return undefined

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // ignore disposal failures
      }
    }
  }
}
