import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONFIG, normalizeConfig, mergeConfig, templateMap, resolveTemplate, parseRepoArg,
} from '../src/config.js'

test('normalizeConfig({}) returns the canonical defaults', () => {
  const cfg = normalizeConfig({})
  assert.deepEqual(cfg, DEFAULT_CONFIG)
  assert.equal(cfg.github.tokenEnv, 'GITHUB_TOKEN')
  assert.equal(cfg.local.templates[0].name, 'npm test')
  assert.equal(cfg.diagnosis.llm, null)
})

test('normalizeConfig deep-merges partial user config over defaults', () => {
  const cfg = normalizeConfig({
    github: { defaultRepo: 'acme/app', pollIntervalMs: 1000 },
    local: { templates: [{ name: 'unit', command: 'npm run unit' }] },
    diagnosis: { llm: { baseUrl: 'https://x/v1', apiKey: 'secret', model: 'm1' } },
  })
  assert.equal(cfg.github.defaultRepo, 'acme/app')
  assert.equal(cfg.github.pollIntervalMs, 1000)
  assert.equal(cfg.github.defaultBranch, 'main') // untouched by the patch
  assert.deepEqual(cfg.local.templates, [{ name: 'unit', command: 'npm run unit' }]) // array replaced
  assert.equal(cfg.diagnosis.llm.model, 'm1')
  assert.equal(cfg.diagnosis.llm.apiKey, 'secret')
})

test('normalizeConfig rejects invalid values', () => {
  const cases = [
    [{ github: { tokenEnv: '' } }, /tokenEnv/],
    [{ github: { defaultRepo: 'justowner' } }, /owner\/repo/],
    [{ github: { defaultRepo: 'https://github.com/o/r' } }, /owner\/repo/],
    [{ github: { apiBase: 'ftp://x' } }, /http/],
    [{ github: { pollIntervalMs: 0 } }, /pollIntervalMs/],
    [{ github: { readLogChars: 5 } }, /readLogChars/],
    [{ local: { templates: [{ name: 'a', command: '' }] } }, /templates\[0\]/],
    [{ local: { templates: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }] } }, /duplicate/],
    [{ diagnosis: { llm: { baseUrl: 'nope' } } }, /baseUrl/],
    [{ diagnosis: { maxTailChars: 10 } }, /maxTailChars/],
    [{ diagnosis: { temperature: 1.5 } }, /temperature/],
    [{ diagnosis: { timeoutMs: -1 } }, /timeoutMs/],
  ]
  for (const [patch, re] of cases) {
    assert.throws(() => normalizeConfig(patch), re, `expected ${JSON.stringify(patch)} to fail`)
  }
})

test('mergeConfig folds scalars/arrays and never mutates the base', () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2] }
  const out = mergeConfig(base, { a: { c: 9 }, list: [3] })
  assert.deepEqual(out, { a: { b: 1, c: 9 }, list: [3] })
  assert.deepEqual(base, { a: { b: 1, c: 2 }, list: [1, 2] })
  assert.equal(mergeConfig(base, null), base)
  assert.equal(mergeConfig({ x: 1 }, 'nope'), 'nope')
})

test('templateMap and resolveTemplate pick named, raw or fallback commands', () => {
  const cfg = normalizeConfig({ local: { templates: [{ name: 'npm test', command: 'npm test' }] } })
  assert.deepEqual(templateMap(cfg), { 'npm test': 'npm test' })
  assert.equal(resolveTemplate(cfg, 'npm test'), 'npm test')       // named template
  assert.equal(resolveTemplate(cfg, 'node --test x.js'), 'node --test x.js') // raw command
  assert.equal(resolveTemplate(cfg, undefined), 'npm test')        // fallback to first template
  assert.equal(resolveTemplate(cfg, ''), 'npm test')
})

test('parseRepoArg accepts owner/repo and rejects malformed values', () => {
  assert.equal(parseRepoArg('acme/app'), 'acme/app')
  assert.equal(parseRepoArg(undefined), null)
  assert.equal(parseRepoArg(''), null)
  assert.throws(() => parseRepoArg('acme'), /owner\/repo/)
  assert.throws(() => parseRepoArg('acme/app/extra'), /owner\/repo/)
  assert.throws(() => parseRepoArg(42), TypeError)
})