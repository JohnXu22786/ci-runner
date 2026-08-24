import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runLocalCommand, LocalRunner } from '../src/local.js'

test('captures stdout and reports a clean exit', async () => {
  const result = await runLocalCommand('node -e "console.log(\'hello ci\')"')
  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), 'hello ci')
  assert.equal(result.stderr, '')
  assert.ok(result.durationMs >= 0)
})

test('non-zero exit is reported as failure with stderr', async () => {
  const result = await runLocalCommand('node -e "console.error(\'boom\'); process.exit(3)"')
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 3)
  assert.equal(result.stderr.trim(), 'boom')
})

test('timeout kills the process tree and returns promptly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-timeout-'))
  const marker = path.join(dir, 'marker.txt')
  const markerLiteral = marker.replace(/\\/g, '\\\\')
  const command = `node -e "setTimeout(()=>{require('fs').writeFileSync('${markerLiteral}','done')},3000)"`
  try {
    const result = await runLocalCommand(command, { timeoutMs: 400, cwd: dir })
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, -1)
    assert.equal(result.killed, true)
    assert.ok(result.durationMs < 2500, `expected prompt return, took ${result.durationMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 2700))
    assert.equal(fs.existsSync(marker), false, 'grandchild survived the tree-kill')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('output is truncated at the per-stream cap', async () => {
  const result = await runLocalCommand(
    'node -e "process.stdout.write(\'x\'.repeat(5000)); process.stderr.write(\'y\'.repeat(5000))"',
    { maxOutputChars: 2000 },
  )
  assert.equal(result.stdout.length, 2000)
  assert.equal(result.stderr.length, 2000)
  assert.equal(result.stdoutTruncated, true)
  assert.equal(result.stderrTruncated, true)
})

test('an aborted signal kills a running command', async () => {
  const controller = new AbortController()
  const pending = runLocalCommand('node -e "setTimeout(() => {}, 10000)"', {
    signal: controller.signal,
  })
  controller.abort()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, -1)
  assert.equal(result.killed, true)
})

test('spawn failures become structured failed results', async () => {
  const result = await runLocalCommand('node -e "process.exit(0)"', { cwd: 'Z:\\no-such-dir-xyz' })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, -1)
  assert.ok(result.stderr.length > 0 || result.stdout.length > 0)
})

test('LocalRunner binds default options', async () => {
  const runner = new LocalRunner({ timeoutMs: 2000, maxOutputChars: 500 })
  const result = await runner.run('node -e "console.log(\'bound\')"')
  assert.equal(result.ok, true)
  assert.equal(result.stdout.trim(), 'bound')
})

test('blank commands are rejected instead of silently passing', async () => {
  for (const command of ['', '   ', '\t\n']) {
    const result = await runLocalCommand(command)
    assert.equal(result.ok, false, `command ${JSON.stringify(command)} must fail`)
    assert.equal(result.exitCode, -1)
    assert.match(result.stderr, /empty command|spawn/i)
  }
})