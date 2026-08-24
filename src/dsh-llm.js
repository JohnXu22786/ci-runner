/**
 * Harness side of diagnosis — routes the analysis call through the host's
 * `ctx.llm` streaming service.
 *
 * This module imports from the harness packages, so it is NOT re-exported by
 * the package main (`src/index.js`); only the adapter entry mounts it. It
 * exposes the same `complete()` interface as {@link OpenAiCompatibleClient} so
 * the service layer treats both uniformly.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Accumulate a stream of chunks into plain text, surfacing terminal failures. */
export async function collectText(stream, context = {}) {
  let text = ''
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text
        break
      case 'reasoning-delta':
        // Reasoning deltas are not part of the visible answer.
        break
      case 'finish': {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          const detail = chunk.reason.failure?.message ?? 'unknown failure'
          throw new Error(`LLM analysis failed (${chunk.reason.kind}): ${detail}`)
        }
        break
      }
      default:
        break
    }
  }
  if (text.trim() === '' && context) {
    // No visible output at all is an anomaly worth surfacing loudly.
    throw new Error('LLM analysis returned an empty completion')
  }
  return text
}

/** Pick a live provider/model pair, honoring configured values. */
export async function resolveRoute(llm, route = {}) {
  const provider = route.provider ?? ''
  const model = route.model ?? ''

  let chosenProvider = provider
  if (chosenProvider === '') {
    const providers = llm.listProviders()
    const first = providers[0]
    if (first === undefined) {
      throw new Error('no LLM provider is registered in this instance — '
        + 'configure a diagnosis.llm endpoint or register a provider')
    }
    chosenProvider = (providers.find((entry) => /deepseek|official/i.test(entry.id)) ?? first).id
  }

  let chosenModel = model
  if (chosenModel === '') {
    const models = await llm.listModels(chosenProvider).catch(() => [])
    const first = models[0]
    if (first !== undefined) {
      chosenModel = (models.find((entry) => /chat|deepseek|v3|r1|reasoner|pro/i.test(entry.id)) ?? first).id
    }
  }
  if (chosenModel === '') {
    throw new Error(`provider ${chosenProvider} lists no model; set diagnosis.model`)
  }
  return { provider: chosenProvider, model: chosenModel }
}

/**
 * {@link complete}-compatible analysis client backed by `ctx.llm`.
 * Provider/model resolution is deferred to the first call so late adapter
 * registrations (e.g. DeepSeek activating after startup) are honored.
 */
export class DshLlmAnalyzer {
  constructor(llm, route = {}, logger = null) {
    this.llm = llm
    this.route = route
    this.logger = logger
    this.resolution = null
    this.source = 'harness'
  }

  async complete(req) {
    const route = (this.resolution ??= await resolveRoute(this.llm, this.route))
    this.logger?.info?.(`ci-runner: LLM diagnosis via provider=${route.provider} model=${route.model}`)

    const message = createUserMessage({
      content: [{ type: 'text', text: req.prompt }],
      source: {
        kind: 'plugin',
        plugin: 'ci-runner',
        form: 'notice',
        summary: 'CI failure diagnosis request',
      },
    })
    const stream = this.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [message],
      system: req.system,
      ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
      temperature: req.temperature,
      ...(req.signal ? { signal: req.signal } : {}),
    })
    return collectText(stream).catch((error) => {
      throw new Error(`LLM analysis failed: ${error.message}`)
    })
  }
}

/**
 * Factory used by the adapter. Returns null when the harness exposes no LLM
 * service, so diagnosis degrades gracefully to the deterministic report.
 * @param {object|null} llm the `ctx.llm` service (undefined when optional-inject misses)
 * @param {object} [route] { provider, model }
 * @param {object} [logger]
 */
export function createDshLlmAnalyzer(llm, route = {}, logger = null) {
  if (!llm || typeof llm.stream !== 'function') return null
  return new DshLlmAnalyzer(llm, route, logger)
}
