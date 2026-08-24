import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CiService } from '../src/service.js'
import { normalizeConfig } from '../src/config.js'
import { classifyFailure } from '../src/classify.js'

/** A stub analyzer recording prompts, returning canned Markdown. */
function stubAnalyzer(markdown, log = []) {
  return {
    source: 'stub',
    async complete(req) {
      log.push(req.prompt)
      return markdown
    },
    log,
  }
}

/** Local config pointing at a temp dir with a failing/succeeding script. */
function localConfig(dir, extra = {}) {
  return normalizeConfig({
    local: {
      cwd: dir,
      templates: [
        { name: 'failing', command: 'node fail.js' },
        { name: 'passing', command: 'node pass.js' },
      ],
    },
    diagnosis: { maxTailChars: 2000 },
    ...extra,
  })
}

function writeScripts(dir) {
  fs.writeFileSync(path.join(dir, 'fail.js'),
    'console.log("starting"); console.error("AssertionError: expected 1 to equal 2"); process.exit(1)',
    'utf8')
  fs.writeFileSync(path.join(dir, 'pass.js'), 'console.log("all green"); process.exit(0)', 'utf8')
}

test('local trigger/status/logs round-trip through the service', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-svc-'))
  writeScripts(dir)
  try {
    const service = new CiService(localConfig(dir))
    const ref = await service.trigger({ source: 'local', command: 'failing' })
    assert.equal(ref.source, 'local')
    assert.equal(ref.status, 'completed')
    assert.equal(ref.conclusion, 'failure')
    assert.equal(ref.exitCode, 1)
    assert.match(ref.runId, /^local-\d+$/)

    const status = await service.status({ source: 'local', runId: ref.runId })
    assert.equal(status.conclusion, 'failure')
    assert.equal(status.state, 'failure')

    const logs = await service.logs({ source: 'local', runId: ref.runId, tailChars: 500 })
    assert.match(logs.text, /AssertionError/)
    assert.equal(logs.truncated, false)

    const ok = await service.trigger({ source: 'local', command: 'passing' })
    assert.equal(ok.conclusion, 'success')
    assert.equal(ok.ok, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown local run ids fail loudly', async () => {
  const service = new CiService(normalizeConfig({}))
  await assert.rejects(() => service.status({ source: 'local', runId: 'nope' }), /unknown local run/)
  await assert.rejects(() => service.logs({ source: 'local', runId: 'nope' }), /unknown local run/)
})

test('diagnose on a failed local run produces a full report through the analyzer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-diag-'))
  writeScripts(dir)
  const analyzer = stubAnalyzer(
    '# CI Failure Report\n\n## Most Likely Root Cause\nTest expectation is wrong.\n\n'
    + '## Suggested Fix Steps\n- fix the assertion\n\n## Related Files\nfail.js\n',
  )
  try {
    const service = new CiService(localConfig(dir), { llmAnalyzer: () => analyzer })
    const report = await service.diagnose({ source: 'local', command: 'failing' })
    assert.equal(report.ok, false)
    assert.match(report.report, /# CI Failure Report/)
    assert.match(report.report, /Test expectation is wrong\./)
    assert.match(report.report, /AssertionError/)
    assert.equal(report.analysis.source, 'stub')
    assert.equal(analyzer.log.length, 1)
    assert.match(analyzer.log[0], /AssertionError: expected 1 to equal 2/)
    assert.equal(report.classification.category, 'test')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('diagnose on a passing run skips the analyzer entirely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-pass-'))
  writeScripts(dir)
  const analyzer = stubAnalyzer('should never be called')
  try {
    const service = new CiService(localConfig(dir), { llmAnalyzer: () => analyzer })
    const report = await service.diagnose({ source: 'local', command: 'passing' })
    assert.equal(report.ok, true)
    assert.match(report.report, /passed/)
    assert.equal(analyzer.log.length, 0, 'analyzer must not run for a passing run')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('diagnose without any analyzer falls back to the deterministic report', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-nollm-'))
  writeScripts(dir)
  try {
    const service = new CiService(localConfig(dir))
    const report = await service.diagnose({ source: 'local', command: 'failing' })
    assert.match(report.report, /No model analysis is available/)
    assert.match(report.report, /Failure Stage/)
    assert.match(report.report, /Error Classification/)
    assert.equal(report.analysis.source, 'none')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('diagnose writes the report to savePath when asked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-save-'))
  writeScripts(dir)
  const target = path.join(dir, 'report.md')
  try {
    const service = new CiService(localConfig(dir))
    const report = await service.diagnose({ source: 'local', command: 'failing', savePath: target })
    assert.equal(report.savedPath, target)
    assert.ok(fs.existsSync(target))
    assert.equal(fs.readFileSync(target, 'utf8'), report.report)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('watch runs a local command and includes the failure tail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-watch-'))
  writeScripts(dir)
  try {
    const service = new CiService(localConfig(dir))
    const result = await service.watch({ source: 'local', command: 'failing' })
    assert.equal(result.state, 'failure')
    assert.match(result.tailLog.text, /AssertionError/)
    const quiet = await service.watch({ source: 'local', command: 'failing', includeLogsOnFailure: false })
    assert.equal(quiet.tailLog, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('watch and diagnose honour the template alias for local runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-tpl-'))
  writeScripts(dir)
  try {
    const service = new CiService(localConfig(dir))
    const watched = await service.watch({ source: 'local', template: 'failing' })
    assert.equal(watched.state, 'failure')
    assert.match(watched.command, /fail\.js/)

    const report = await service.diagnose({ source: 'local', template: 'passing' })
    assert.equal(report.ok, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a throwing analyzer factory degrades to the deterministic report', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-throw-'))
  writeScripts(dir)
  try {
    const service = new CiService(localConfig(dir), {
      llmAnalyzer: () => { throw new Error('provider exploded') },
    })
    const report = await service.diagnose({ source: 'local', command: 'failing' })
    assert.equal(report.ok, false)
    assert.match(report.report, /provider exploded/)
    assert.match(report.report, /No model analysis is available|Analysis provider failed/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('credentials are masked out of log output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-mask-'))
  const token = 'ghp_super-secret-value-123456'
  process.env.TEST_CI_TOKEN = token
  fs.writeFileSync(path.join(dir, 'echo.js'),
    `console.log("token is ${token} in output"); process.exit(2)`, 'utf8')
  try {
    const service = new CiService(normalizeConfig({
      github: { tokenEnv: 'TEST_CI_TOKEN' },
      local: { cwd: dir, templates: [{ name: 'echo', command: 'node echo.js' }] },
    }))
    const logs = await service.logs({
      source: 'local',
      runId: (await service.trigger({ source: 'local', command: 'echo' })).runId,
    })
    assert.ok(!logs.text.includes(token), 'token must not appear in log output')
    assert.match(logs.text, /\*\*\*/)
    const report = await service.diagnose({ source: 'local', command: 'echo' })
    assert.ok(!report.report.includes(token), 'token must not appear in the report')
  } finally {
    delete process.env.TEST_CI_TOKEN
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** Minimal fake GitHub client implementing the surface service/watch/diagnose use. */
function fakeGithubClient({ runs, runLogs, jobs }) {
  return {
    async triggerWorkflow({ workflow, ref }) {
      const run = runs.pop() ?? { id: 1, conclusion: 'failure', status: 'completed' }
      return { runId: run.id }
    },
    async getRun(runId) {
      const found = runs.find((r) => r.id === runId) ??
        { id: runId, status: 'completed', conclusion: 'failure' }
      return {
        id: found.id,
        status: found.status ?? 'completed',
        conclusion: found.conclusion ?? 'failure',
        run_started_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:01:00Z',
        html_url: `https://github.com/acme/app/actions/runs/${runId}`,
        repository: { full_name: 'acme/app' },
      }
    },
    async listJobs() {
      return jobs ?? [{
        id: 1,
        name: 'job-a',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/acme/app/actions/runs/1',
        steps: [
          { name: 'install', status: 'completed', conclusion: 'success' },
          { name: 'test', status: 'completed', conclusion: 'failure' },
        ],
      }]
    },
    async waitForRun(runId) {
      return { run: await this.getRun(runId), polls: 1 }
    },
    async readRunLogs(runId, { maxChars }) {
      const text = (runLogs ?? {}).text ?? 'AssertionError: boom\nmore detail here\n'
      return { jobs: [], text: text.slice(-(maxChars ?? 10000)), truncated: false, chars: text.length }
    },
  }
}

test('github status surfaces jobs and the failed stage', async () => {
  const service = new CiService(normalizeConfig({
    github: { defaultRepo: 'acme/app', tokenEnv: 'GITHUB_TOKEN' },
  }), {
    githubFactory: () => fakeGithubClient({ runs: [] }),
  })
  process.env.GITHUB_TOKEN = 'ghp_fake-token-for-tests'
  try {
    const status = await service.status({ source: 'github', runId: 4321 })
    assert.equal(status.state, 'failure')
    assert.equal(status.failedStage, 'job-a › test')
    assert.equal(status.jobs[0].name, 'job-a')
    assert.equal(status.jobs[0].steps[1].name, 'test')
    assert.match(status.url, /\/runs\/4321$/)
  } finally {
    delete process.env.GITHUB_TOKEN
  }
})

test('github watch/diagnose orchestrate trigger -> wait -> failed report', async () => {
  const token = 'ghp_super-secret-token-xyz'
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runner-gh-save-'))
  const savePath = path.join(targetDir, 'diagnosis.md')
  const service = new CiService(normalizeConfig({
    github: { defaultRepo: 'acme/app', tokenEnv: 'GITHUB_TOKEN' },
    diagnosis: { maxTailChars: 500 },
  }), {
    githubFactory: () => fakeGithubClient({
      runs: [{ id: 4321, conclusion: 'failure' }],
      runLogs: { text: `Error: connect ECONNREFUSED at src/worker.js:12 token=${token}` },
    }),
    llmAnalyzer: () => stubAnalyzer('# CI Failure Report\n\n## Most Likely Root Cause\nPort is closed.'),
  })
  process.env.GITHUB_TOKEN = token
  try {
    const watched = await service.watch({ source: 'github', workflow: 'ci.yml', ref: 'main' })
    assert.equal(watched.runId, 4321)
    assert.equal(watched.state, 'failure')
    assert.equal(watched.failedStage, 'job-a › test')
    assert.match(watched.tailLog.text, /ECONNREFUSED/)
    assert.ok(!watched.tailLog.text.includes(token), 'token must be masked from github log tails')

    const report = await service.diagnose({ source: 'github', runId: 4321, savePath })
    assert.equal(report.ok, false)
    assert.match(report.report, /Port is closed\./)
    assert.ok(!report.report.includes(token), 'token must not reach the report')
    assert.equal(report.classification.category, 'infra')
    assert.equal(report.savedPath, savePath)
    assert.ok(fs.existsSync(savePath), 'github diagnose must honor savePath too')
  } finally {
    delete process.env.GITHUB_TOKEN
    fs.rmSync(targetDir, { recursive: true, force: true })
  }
})

test('classifyFailure is exposed for embedding use', () => {
  assert.equal(classifyFailure({ log: 'SyntaxError: Unexpected token' }).category, 'syntax')
})