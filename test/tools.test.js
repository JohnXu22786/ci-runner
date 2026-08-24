import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineCiTools } from '../src/tools.js'
import { CiService } from '../src/service.js'
import { normalizeConfig } from '../src/config.js'

const NAMES = ['ci_trigger', 'ci_status', 'ci_logs', 'ci_watch', 'ci_diagnose']

/** Exec helper binding the signal like the harness would. */
function run(tool, args) {
  return tool.execute(args, { signal: new AbortController().signal })
}

test('defineCiTools returns all five tools with a sound contract', () => {
  const cfg = normalizeConfig({})
  const tools = defineCiTools(new CiService(cfg), cfg)
  assert.deepEqual(tools.map((t) => t.name), NAMES)
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 40)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.parameters.properties, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(tool.output.schema.type, 'object')
    assert.ok(Array.isArray(tool.output.schema.required), `${tool.name} output requires fields`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.timeoutMs, 'number')
    assert.ok(tool.timeoutMs > 0)
    const rendered = tool.output.render({}, { ok: true })
    assert.equal(rendered[0].type, 'text', `${tool.name} renders text`)
  }
})

test('ci_trigger runs a local command through the service', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-tools-'))
  fs.writeFileSync(path.join(dir, 'ok.js'), 'console.log("fine"); process.exit(0)', 'utf8')
  try {
    const cfg = normalizeConfig({ local: { cwd: dir } })
    const tools = defineCiTools(new CiService(cfg), cfg)
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

    const ok = await run(byName.ci_trigger, { source: 'local', command: 'node ok.js' })
    assert.equal(ok.ok, true)
    assert.equal(ok.status, 'completed')
    assert.equal(typeof ok.runId, 'string')
    assert.match(ok.runId, /^local-\d+$/)

    const bad = await run(byName.ci_trigger, { source: 'local', command: 'node -e "process.exit(2)"' })
    assert.equal(bad.ok, false)
    assert.equal(bad.exitCode, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ci_status and ci_logs operate on stored local runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-tools2-'))
  fs.writeFileSync(path.join(dir, 'noise.js'), 'console.log("hello from noise"); process.exit(1)', 'utf8')
  try {
    const cfg = normalizeConfig({ local: { cwd: dir } })
    const service = new CiService(cfg)
    const tools = defineCiTools(service, cfg)
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    const ref = await service.trigger({ source: 'local', command: 'node noise.js' })

    const status = await run(byName.ci_status, { source: 'local', runId: ref.runId })
    assert.equal(status.state, 'failure')
    assert.equal(String(status.runId), String(ref.runId))

    const logs = await run(byName.ci_logs, { source: 'local', runId: ref.runId })
    assert.match(logs.text, /hello from noise/)
    assert.equal(logs.truncated, false)
    assert.equal(typeof logs.chars, 'number')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ci_diagnose fails loudly for an unknown run and reports on failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-tools3-'))
  fs.writeFileSync(path.join(dir, 'fail.js'), 'console.error("boom"); process.exit(1)', 'utf8')
  try {
    const cfg = normalizeConfig({ local: { cwd: dir } })
    const service = new CiService(cfg)
    const tools = defineCiTools(service, cfg)
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

    await assert.rejects(
      () => run(byName.ci_diagnose, { source: 'local', runId: 'missing' }),
      /unknown local run/,
    )
    const report = await run(byName.ci_diagnose, { source: 'local', command: 'node fail.js' })
    assert.equal(report.ok, false)
    assert.match(report.report, /# CI Failure Report/)
    assert.match(report.report, /No model analysis is available/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})