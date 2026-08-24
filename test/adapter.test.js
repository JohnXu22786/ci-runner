import test from 'node:test'
import assert from 'node:assert/strict'
import { name, inject, Config, apply } from '../src/adapter.js'

const TOOL_NAMES = ['ci_trigger', 'ci_status', 'ci_logs', 'ci_watch', 'ci_diagnose']

/** Minimal Cordis-like context for apply(). */
function makeCtx(overrides = {}) {
  const warnings = []
  const infos = []
  const registered = []
  const disposers = []
  const ctx = {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: (message) => infos.push(String(message)),
      error: (message) => warnings.push(`ERR:${message}`),
    },
    tools: {
      register(def) {
        registered.push(def)
        const disposer = () => disposers.push(def.name)
        return disposer
      },
    },
    ...overrides,
  }
  return { ctx, registered, disposers, warnings, infos }
}

test('module contract matches the dsh bundle expectations', () => {
  assert.equal(name, 'ci-runner')
  assert.deepEqual(inject, ['tools', '-llm'])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function')
})

test('Config schema defaults an empty config', () => {
  const value = Config({})
  assert.equal(value.github.tokenEnv, 'GITHUB_TOKEN')
  assert.equal(value.github.pollIntervalMs, 5000)
  assert.equal(value.local.timeoutMs, 120000)
  // Schemastery drops `null` defaults from union fields; absence is treated
  // as "no endpoint" by normalizeConfig (see adapter apply).
  assert.equal(value.diagnosis.llm ?? null, null)
  assert.equal(value.diagnosis.temperature, 0.2)
})

test('Config schema accepts and defaults a partial config', () => {
  const value = Config({ github: { defaultRepo: 'acme/app' }, diagnosis: { llm: { apiKey: 'k' } } })
  assert.equal(value.github.defaultRepo, 'acme/app')
  assert.equal(value.github.defaultBranch, 'main')
  assert.equal(value.diagnosis.llm.model, 'deepseek-chat')
  const explicitNull = Config({ diagnosis: { llm: null } })
  assert.equal(explicitNull.diagnosis.llm ?? null, null)
})

test('apply registers the five tools and returns a disposer that unregisters them', () => {
  const { ctx, registered, disposers } = makeCtx()
  const dispose = apply(ctx, {})
  assert.equal(typeof dispose, 'function')
  assert.deepEqual(registered.map((t) => t.name), TOOL_NAMES)
  dispose()
  assert.deepEqual(disposers.sort(), [...TOOL_NAMES].sort())
})

test('apply warns and skips on invalid config', () => {
  const { ctx, registered, warnings } = makeCtx()
  const dispose = apply(ctx, { github: { defaultRepo: 'not-a-repo' } })
  assert.equal(dispose, undefined)
  assert.equal(registered.length, 0)
  assert.ok(warnings.some((w) => w.includes('invalid config')))
})

test('apply survives a throwing tools.register and wires the rest', () => {
  const registered = []
  const warnings = []
  let calls = 0
  const ctx = {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: () => {},
      error: (message) => warnings.push(`ERR:${message}`),
    },
    tools: {
      register(def) {
        calls += 1
        if (calls === 3) throw new Error('registry down')
        registered.push(def)
        return () => {}
      },
    },
  }
  const dispose = apply(ctx, {})
  assert.equal(typeof dispose, 'function', 'remaining tools still mount')
  assert.equal(registered.length, 4)
  assert.ok(warnings.some((w) => w.includes('ci_') && w.includes('registry down')))
  dispose()
})

test('apply works without the optional llm service', () => {
  const { ctx, registered } = makeCtx({ llm: undefined })
  const dispose = apply(ctx, {})
  assert.equal(registered.length, 5)
  dispose()
})

test('apply works when the llm service is present', () => {
  const { ctx, registered } = makeCtx({
    llm: { stream: () => { throw new Error('not used in this test') } },
  })
  const dispose = apply(ctx, {})
  assert.equal(registered.length, 5)
  dispose()
})

test('tools registered through apply can execute end-to-end', async () => {
  const { ctx, registered } = makeCtx()
  const dispose = apply(ctx, {})
  try {
    const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
    const signal = new AbortController().signal
    const result = await byName.ci_trigger.execute(
      { source: 'local', command: 'node -e "console.log(\'via adapter\')"' },
      { signal },
    )
    assert.equal(result.ok, true)
    assert.equal(result.status, 'completed')
    const logs = await byName.ci_logs.execute(
      { source: 'local', runId: result.runId },
      { signal },
    )
    assert.match(logs.text, /via adapter/)
  } finally {
    dispose()
  }
})