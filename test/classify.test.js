import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, categoryLabel, CATEGORY_ORDER } from '../src/classify.js'

const SAMPLES = [
  { category: 'config', log: 'Error: The workflow is not valid. .github/workflows/ci.yml (Line: 12, Col: 5)' },
  { category: 'auth', log: 'fatal: remote: Permission to acme/app denied to deploy-bot' },
  { category: 'dependency', log: 'Cannot find module \'undici\' from /repo/src/index.js' },
  { category: 'dependency', log: 'npm ERR! 404 Not Found - GET https://registry.npmjs.org/some-pkg' },
  { category: 'build', log: 'src/a.ts:12:5 - error TS2322: Type \'string\' is not assignable to \'number\'' },
  { category: 'build', log: 'gcc: fatal error: no input files compilation terminated.' },
  { category: 'syntax', log: 'SyntaxError: Unexpected token \'<\'. Downloading fails.' },
  { category: 'lint', log: 'ERROR: [eslint] /repo/src/a.js: 3 errors (no-undef)' },
  { category: 'test', log: 'AssertionError [ERR_ASSERTION]: expected 1 to equal 2' },
  { category: 'test', log: 'FAILED tests/test_api.py::test_login - assert 200 == 401' },
  { category: 'timeout', log: 'Run exceeded the maximum execution time of 360 minutes' },
  { category: 'infra', log: 'Error: connect ECONNREFUSED 127.0.0.1:5432' },
]

test('classifies representative failure logs into the right category', () => {
  for (const sample of SAMPLES) {
    const result = classifyFailure({ log: sample.log, exitCode: 1 })
    assert.equal(result.category, sample.category, `log: ${sample.log}`)
  }
})

test('killed runs classify as timeout regardless of the log', () => {
  const result = classifyFailure({ log: 'random noise', exitCode: -1, killed: true })
  assert.equal(result.category, 'timeout')
})

test('a non-zero exit with test-runner words points at tests', () => {
  const result = classifyFailure({ log: 'running 3 spec files\nsome failure output', exitCode: 1 })
  assert.equal(result.category, 'test')
})

test('unmatched logs fall back to unknown but keep hints', () => {
  const result = classifyFailure({ log: 'something unusual happened', exitCode: 1 })
  assert.equal(result.category, 'unknown')
  assert.deepEqual(result.hints, [])
})

test('hints list every matched category in priority order', () => {
  const result = classifyFailure({
    log: 'npm ERR! 404 Not Found — Cannot find module \'x\' in src/a.ts:1 - error TS1000',
    exitCode: 1,
  })
  assert.equal(result.category, 'dependency')
  assert.ok(result.hints.includes('build'), 'build hint expected')
})

test('categoryLabel maps ids and passes through unknown ids', () => {
  assert.equal(categoryLabel('build'), 'Build / compile error')
  assert.equal(categoryLabel('nope'), 'nope')
  assert.ok(CATEGORY_ORDER.includes('unknown') === false)
})