import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRunMeta, assembleReport } from '../src/diagnose.js'
import { classifyFailure } from '../src/classify.js'

const FAILURE_META = buildRunMeta({
  source: 'github',
  runId: 12,
  repo: 'acme/app',
  workflow: 'ci.yml',
  job: 'test',
  ref: 'main',
  status: 'completed',
  conclusion: 'failure',
  failedStage: 'test',
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:01:00Z',
})

test('buildRunMeta normalizes compact input', () => {
  const meta = buildRunMeta({ source: 'local', runId: 'local-1' })
  assert.equal(meta.source, 'local')
  assert.equal(meta.runId, 'local-1')
  assert.equal(meta.conclusion, '')
  assert.ok(meta.completedAt)
  assert.equal(meta.durationMs, null)
})

test('a passing run short-circuits into a success report', () => {
  const report = assembleReport({ meta: FAILURE_META, success: true, logTail: { text: '', truncated: false } })
  assert.equal(report.ok, true)
  assert.match(report.report, /passed/)
  assert.doesNotMatch(report.report, /No model analysis is available/)
})

test('failure report carries all five canonical sections with model analysis', () => {
  const classification = classifyFailure({ log: 'AssertionError: expected 1 to equal 2', exitCode: 1 })
  const analysis = '# CI Failure Report\n\n## Failure Stage\n`npm test` job\n\n## Error Classification\n'
    + 'Test failure\n\n## Most Likely Root Cause\nThe mock server returned a stale fixture.\n\n'
    + '## Suggested Fix Steps\n- Refresh the fixture\n- Re-run\n\n## Related Files\ntest/fixtures/a.json\n'
  const report = assembleReport({
    meta: FAILURE_META,
    logTail: { text: 'assert log tail', truncated: true },
    classification,
    analysis,
    analysisSource: 'probe',
    analysisError: '',
  })
  assert.equal(report.ok, false)
  assert.match(report.report, /# CI Failure Report/)
  for (const heading of ['## Failure Stage', '## Error Classification', '## Most Likely Root Cause',
    '## Suggested Fix Steps', '## Related Files', '## Failure Log Tail']) {
    assert.match(report.report, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), heading)
  }
  assert.match(report.report, /stale fixture/)
  assert.match(report.report, /Refresh the fixture/)
  assert.match(report.report, /test\/fixtures\/a\.json/)
  assert.match(report.report, /assert log tail/)
  assert.match(report.report, /truncated to its final/)
  assert.equal(report.analysis.source, 'probe')
  assert.equal(report.classification.category, 'test')
})

test('failure report stays deterministic without a model', () => {
  const classification = classifyFailure({ log: 'boom', exitCode: 2 })
  const report = assembleReport({
    meta: FAILURE_META,
    logTail: { text: 'boom', truncated: false },
    classification,
  })
  assert.match(report.report, /## Most Likely Root Cause/)
  assert.match(report.report, /No model analysis is available/)
  assert.match(report.report, /## Error Classification/)
  assert.match(report.report, /Unclassified|Test failure|unknown/)
})

test('a failed analysis surfaces its error in the report', () => {
  const report = assembleReport({
    meta: FAILURE_META,
    logTail: { text: 'boom', truncated: false },
    classification: classifyFailure({ log: 'boom', exitCode: 1 }),
    analysisSource: 'endpoint:https://x',
    analysisError: 'timeout after 5000ms',
  })
  assert.match(report.report, /Analysis provider failed: timeout after 5000ms/)
  assert.equal(report.analysis.error, 'timeout after 5000ms')
})

test('a log line of bare backticks cannot break the report fence', () => {
  const evil = 'first line\n```\n[x](javascript:alert(1)) trailing markdown\n'
  const report = assembleReport({
    meta: FAILURE_META,
    logTail: { text: evil, truncated: false },
    classification: classifyFailure({ log: evil, exitCode: 1 }),
  })
  const tailSection = report.report.split('## Failure Log Tail')[1]
  assert.match(tailSection, /\n```text/, 'fence must open')
  // The bare ``` line must be indented so it stays literal inside the fence.
  assert.match(tailSection, /\n    ```\n/)
  const fenceEnd = tailSection.lastIndexOf('\n```')
  const afterFence = tailSection.slice(fenceEnd + 4)
  assert.doesNotMatch(afterFence, /javascript:alert/, 'nothing may render outside the fence')
})