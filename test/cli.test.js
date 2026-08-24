import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { main, parseFlags } from '../src/cli.js'

/** In-memory io harness. */
function makeIo() {
  const lines = []
  const io = {
    log: (line = '') => lines.push(String(line)),
    error: (line = '') => lines.push(`ERR:${line}`),
    lines,
  }
  return io
}

test('parseFlags handles values, = syntax, booleans and repeatables', () => {
  assert.deepEqual(parseFlags(['--source', 'local', '--repo=acme/app', '--no-logs', '--json']), {
    source: 'local',
    repo: 'acme/app',
    'no-logs': true,
    json: true,
  })
  assert.deepEqual(parseFlags(['--inputs', 'a=1', '--inputs', 'b=2']), { inputs: ['a=1', 'b=2'] })
  assert.throws(() => parseFlags(['--unknown']), /unknown flag/)
  assert.throws(() => parseFlags(['--repo']), /needs a value/)
  assert.throws(() => parseFlags(['--no-logs=x']), /takes no value/)
  assert.throws(() => parseFlags(['stray']), /unexpected argument/)
})

test('--help and --version exit cleanly', async () => {
  const io = makeIo()
  assert.equal(await main(['--help'], io), 0)
  assert.match(io.lines[0], /ci-runner/)
  const io2 = makeIo()
  assert.equal(await main(['--version'], io2), 0)
  assert.match(io2.lines[0], /^ci-runner \d+\.\d+\.\d+/)
})

test('no arguments prints usage; unknown command errors', async () => {
  const io = makeIo()
  assert.equal(await main([], io), 0)
  assert.match(io.lines[0], /Usage/)
  const io2 = makeIo()
  assert.equal(await main(['frobnicate'], io2), 1)
  assert.match(io2.lines[0], /unknown command/)
})

test('trigger a passing local pipeline via the CLI', async () => {
  const io = makeIo()
  const code = await main(['trigger', '--source', 'local', '--command', 'node -e "console.log(1)"'], io)
  assert.equal(code, 0)
  assert.match(io.lines.join('\n'), /triggered local run local-\d+ \(completed\)/)
  assert.match(io.lines.join('\n'), /=> passed/)
})

test('trigger local failure reports the exit code', async () => {
  const io = makeIo()
  const code = await main(['trigger', '--source', 'local', '--command', 'node -e "process.exit(4)"'], io)
  assert.equal(code, 0)
  assert.match(io.lines.join('\n'), /=> failed \(exit 4\)/)
})

test('github trigger without a token errors with a helpful message', async () => {
  const io = makeIo()
  const code = await main(['trigger', '--workspace', 'x'], io)
  assert.equal(code, 1)
  assert.match(io.lines[0], /error: unknown flag --workspace/)

  // The machine may have a real GITHUB_TOKEN in its environment; hide it so
  // the NO_TOKEN path is exercised instead of a live API call.
  const saved = process.env.GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  try {
    const io2 = makeIo()
    const code2 = await main(['trigger', '--workflow', 'ci.yml', '--repo', 'acme/app'], io2)
    assert.equal(code2, 1)
    assert.match(io2.lines[0], /GITHUB_TOKEN/)
  } finally {
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved
  }
})

test('diagnose local without an endpoint produces the deterministic report', async () => {
  const io = makeIo()
  const code = await main(
    ['diagnose', '--source', 'local', '--command', 'node -e "console.error(\'boom\'); process.exit(1)"'],
    io,
  )
  assert.equal(code, 0)
  const out = io.lines.join('\n')
  assert.match(out, /# CI Failure Report/)
  assert.match(out, /## Most Likely Root Cause/)
  assert.match(out, /No model analysis is available/)
})

test('diagnose with --llm-base-url uses the endpoint and merges its analysis', async () => {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: {
        content: '# CI Failure Report\n\n## Most Likely Root Cause\nMock diagnosis root cause.\n\n'
          + '## Suggested Fix Steps\n- step one\n\n## Related Files\nsrc/a.js\n',
      } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const io = makeIo()
    const code = await main([
      'diagnose', '--source', 'local',
      '--command', 'node -e "console.error(\'boom\'); process.exit(1)"',
      '--llm-base-url', `http://127.0.0.1:${server.address().port}/v1`,
      '--llm-model', 'deepseek-chat',
    ], io)
    assert.equal(code, 0)
    const out = io.lines.join('\n')
    assert.match(out, /Mock diagnosis root cause\./)
    assert.match(out, /step one/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].model, 'deepseek-chat')
  } finally {
    server.close()
  }
})

test('trigger rejects malformed --inputs and forwards valid ones', async () => {
  const io = makeIo()
  const bad = await main(['trigger', '--source', 'github', '--inputs', 'nokey'], io)
  assert.equal(bad, 1)
  assert.match(io.lines[0], /invalid --inputs/)

  const saved = process.env.GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  try {
    const io2 = makeIo()
    // Inputs parse fine; the run fails later at the token check, proving the
    // parser did not reject the pair form.
    const code = await main(['trigger', '--source', 'github', '--workflow', 'w',
      '--repo', 'acme/app', '--inputs', 'env=prod'], io2)
    assert.equal(code, 1)
    assert.match(io2.lines[0], /GITHUB_TOKEN/)
  } finally {
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved
  }
})

test('status/logs for unknown local runs fail with exit 1', async () => {
  for (const cmd of ['status', 'logs']) {
    const io = makeIo()
    const code = await main([cmd, '--source', 'local', '--run', 'nope'], io)
    assert.equal(code, 1, cmd)
    assert.match(io.lines[0], /unknown local run/)

    const io2 = makeIo()
    const missing = await main([cmd, '--source', 'local'], io2)
    assert.equal(missing, 1, `${cmd} without --run`)
    assert.match(io2.lines[0], /--run is required/)
  }
})

test('--config file is loaded and validated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-cli-cfg-'))
  const configPath = path.join(dir, 'ci.json')
  fs.writeFileSync(configPath, JSON.stringify({ local: { templates: [{ name: 'greet', command: 'node -e "console.log(42)"' }] } }), 'utf8')
  try {
    const io = makeIo()
    const code = await main(['trigger', '--config', configPath, '--source', 'local', '--command', 'greet'], io)
    assert.equal(code, 0)
    assert.match(io.lines.join('\n'), /=> passed/)

    fs.writeFileSync(configPath, JSON.stringify({ local: { templates: [{ name: '', command: '' }] } }), 'utf8')
    const io2 = makeIo()
    const code2 = await main(['trigger', '--config', configPath, '--source', 'local'], io2)
    assert.equal(code2, 1)
    assert.match(io2.lines[0], /error:/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})