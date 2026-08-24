import test from 'node:test'
import assert from 'node:assert/strict'
import { GitHubApi, GithubError } from '../src/github.js'
import { makeResponse, createFakeFetch } from './helpers/fakeFetch.js'

const REPO = 'acme/app'

function makeClient(fetchImpl, options = {}) {
  return new GitHubApi({
    token: 'ghp_testtoken123',
    defaultRepo: REPO,
    fetchImpl,
    ...options,
  })
}

/** Canned workflow run objects. */
function run(overrides = {}) {
  return {
    id: 99,
    name: 'build',
    path: '.github/workflows/build.yml',
    workflow_id: 123,
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
    head_sha: 'abc123',
    head_branch: 'main',
    html_url: `https://github.com/${REPO}/actions/runs/99`,
    ...overrides,
  }
}

test('triggerWorkflow dispatches and resolves the run id from the runs list', async () => {
  const calls = []
  const fetchImpl = createFakeFetch([
    {
      label: 'dispatch 204',
      method: 'POST',
      pattern: /\/dispatches$/,
      respond(_url, init) {
        calls.push({ kind: 'dispatch', body: JSON.parse(init.body) })
        return makeResponse({ status: 204 })
      },
    },
    {
      label: 'list runs',
      pattern: /\/actions\/runs\?/,
      respond(url) {
        calls.push({ kind: 'list', url })
        return makeResponse({ json: { workflow_runs: [run({ id: 77 })] } })
      },
    },
  ])
  const client = makeClient(fetchImpl)

  const { runId } = await client.triggerWorkflow({ workflow: 'build.yml', ref: 'main', inputs: { env: 'prod' } })
  assert.equal(runId, 77)
  assert.deepEqual(calls[0], {
    kind: 'dispatch',
    body: { ref: 'main', inputs: { env: 'prod' } },
  })
  assert.match(calls[1].url, /event=workflow_dispatch/)
  fetchImpl.expectAllHandled()
})

test('triggerWorkflow rejects dispatch validation failures (422)', async () => {
  const fetchImpl = createFakeFetch([
    {
      method: 'POST',
      pattern: /\/dispatches$/,
      respond() {
        return makeResponse({ status: 422, json: { message: 'Workflow does not have dispatch trigger' } })
      },
    },
  ])
  const client = makeClient(fetchImpl)
  await assert.rejects(
    () => client.triggerWorkflow({ workflow: 'ci.yml', ref: 'main' }),
    (error) => error instanceof GithubError && error.code === 'REQUEST_REJECTED' && error.status === 422,
  )
})

test('triggerWorkflow retries the runs list until a run appears', async () => {
  let listed = 0
  const fetchImpl = createFakeFetch([
    {
      method: 'POST',
      pattern: /\/dispatches$/,
      respond: () => makeResponse({ status: 204 }),
    },
    {
      pattern: /\/actions\/runs\?/,
      respond: () => makeResponse({ json: { workflow_runs: listed++ === 0 ? [] : [run({ id: 5 })] } }),
    },
  ])
  const client = makeClient(fetchImpl, { dispatchWindowMs: 3000 })
  const { runId } = await client.triggerWorkflow({ workflow: 'build.yml', ref: 'main' })
  assert.equal(runId, 5)
})

test('triggerWorkflow ignores stale runs from earlier dispatches', async () => {
  // A previous dispatch for the same workflow+branch created 10 minutes ago
  // must not be mistaken for the fresh dispatch (regression: stale run id).
  let listed = 0
  const fetchImpl = createFakeFetch([
    {
      method: 'POST',
      pattern: /\/dispatches$/,
      respond: () => makeResponse({ status: 204 }),
    },
    {
      pattern: /\/actions\/runs\?/,
      respond: () => makeResponse({
        json: {
          workflow_runs: listed++ === 0
            ? [run({ id: 100, created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() })]
            : [run({ id: 101, created_at: new Date().toISOString() })],
        },
      }),
    },
  ])
  const client = makeClient(fetchImpl, { dispatchWindowMs: 3000 })
  const { runId } = await client.triggerWorkflow({ workflow: 'build.yml', ref: 'main' })
  assert.equal(runId, 101)
})

test('triggerWorkflow resolves tag refs client-side without a branch filter', async () => {
  const urls = []
  const fetchImpl = createFakeFetch([
    {
      method: 'POST',
      pattern: /\/dispatches$/,
      respond: () => makeResponse({ status: 204 }),
    },
    {
      pattern: /\/actions\/runs\?/,
      respond(url) {
        urls.push(url)
        return makeResponse({
          json: { workflow_runs: [run({ id: 7, head_branch: 'v1.0.0' })] },
        })
      },
    },
  ])
  const client = makeClient(fetchImpl, { dispatchWindowMs: 3000 })
  const { runId } = await client.triggerWorkflow({ workflow: 'build.yml', ref: 'v1.0.0' })
  assert.equal(runId, 7)
  assert.ok(!urls[0].includes('branch='), 'branch filter must be omitted for tag refs')
})

test('triggerWorkflow surfaces RUN_NOT_FOUND when no run appears in time', async () => {
  const fetchImpl = createFakeFetch([
    {
      method: 'POST',
      pattern: /\/dispatches$/,
      respond: () => makeResponse({ status: 204 }),
    },
    {
      pattern: /\/actions\/runs\?/,
      respond: () => makeResponse({ json: { workflow_runs: [] } }),
    },
  ])
  const client = makeClient(fetchImpl, { dispatchWindowMs: 300 })
  await assert.rejects(
    () => client.triggerWorkflow({ workflow: 'build.yml', ref: 'main' }),
    (error) => error instanceof GithubError && error.code === 'RUN_NOT_FOUND',
  )
})

test('NO_REPO and NO_TOKEN surface cleanly', async () => {
  const noRepo = new GitHubApi({ token: 'x', fetchImpl: createFakeFetch([]) })
  await assert.rejects(() => noRepo.triggerWorkflow({ workflow: 'w', ref: 'main' }),
    (error) => error instanceof GithubError && error.code === 'NO_REPO')

  const noToken = new GitHubApi({ defaultRepo: REPO, fetchImpl: createFakeFetch([]) })
  await assert.rejects(() => noToken.getRun(1), (error) => error.code === 'NO_TOKEN')
})

test('getRun and listJobs surface normalized fields', async () => {
  const fetchImpl = createFakeFetch([
    {
      pattern: /\/actions\/runs\/9$/,
      respond: () => makeResponse({ json: run({ status: 'in_progress', conclusion: null }) }),
    },
    {
      pattern: /\/actions\/runs\/9\/jobs/,
      respond: () => makeResponse({ json: { jobs: [{ id: 1, name: 'test' }] } }),
    },
  ])
  const client = makeClient(fetchImpl)
  const data = await client.getRun(9)
  assert.equal(data.status, 'in_progress')
  assert.equal(data.conclusion, null)
  const jobs = await client.listJobs(9)
  assert.equal(jobs[0].name, 'test')
})

test('readRunLogs concatenates job logs with headers and truncates', async () => {
  const fetchImpl = createFakeFetch([
    {
      pattern: /\/actions\/runs\/42\/jobs/,
      respond: () => makeResponse({
        json: { jobs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'failure' }] },
      }),
    },
    {
      pattern: /\/actions\/jobs\/1\/logs/,
      respond: () => makeResponse({ text: 'line one\nline two\n' }),
    },
  ])
  const client = makeClient(fetchImpl)
  const out = await client.readRunLogs(42, { maxChars: 1000 })
  assert.match(out.text, /## job 1 — build \[completed\]/)
  assert.match(out.text, /line two/)
  assert.equal(out.truncated, false)
  assert.equal(out.jobs.length, 1)
  fetchImpl.expectAllHandled()
})

test('readRunLogs truncates to maxChars and reports it', async () => {
  const fetchImpl = createFakeFetch([
    {
      pattern: /\/actions\/runs\/1\/jobs/,
      respond: () => makeResponse({ json: { jobs: [{ id: 1, name: 'j' }] } }),
    },
    {
      pattern: /\/actions\/jobs\/1\/logs/,
      respond: () => makeResponse({ text: 'x'.repeat(500) }),
    },
  ])
  const client = makeClient(fetchImpl)
  const out = await client.readRunLogs(1, { maxChars: 200 })
  assert.equal(out.chars, 200)
  assert.equal(out.truncated, true)
})

test('readRunLogs keeps the FAILURE TAIL, not the head, when truncating', async () => {
  // Regression: an overflowing job log must keep its end (where the error
  // lines live), never its beginning.
  let jobText = 'HEAD-ONLY-START\n' + 'midline\n'.repeat(60) + 'FATAL-ERROR-AT-THE-VERY-END\n'
  const fetchImpl = createFakeFetch([
    {
      pattern: /\/actions\/runs\/3\/jobs/,
      respond: () => makeResponse({ json: { jobs: [{ id: 1, name: 'build' }] } }),
    },
    {
      pattern: /\/actions\/jobs\/1\/logs/,
      respond: () => makeResponse({ text: jobText }),
    },
  ])
  const client = makeClient(fetchImpl)
  const out = await client.readRunLogs(3, { maxChars: 100 })
  assert.equal(out.truncated, true)
  assert.match(out.text, /FATAL-ERROR-AT-THE-VERY-END/)
  assert.doesNotMatch(out.text, /HEAD-ONLY-START/)
})

test('readRunLogs concatenates multiple jobs in list order with headers', async () => {
  const fetchImpl = createFakeFetch([
    {
      pattern: /\/actions\/runs\/4\/jobs/,
      respond: () => makeResponse({
        json: {
          jobs: [
            { id: 1, name: 'build', status: 'completed' },
            { id: 2, name: 'test', status: 'completed' },
          ],
        },
      }),
    },
    {
      pattern: /\/actions\/jobs\/1\/logs/,
      respond: () => makeResponse({ text: 'BUILD-OUTPUT\n' }),
    },
    {
      pattern: /\/actions\/jobs\/2\/logs/,
      respond: () => makeResponse({ text: 'TEST-OUTPUT\n' }),
    },
  ])
  const client = makeClient(fetchImpl)
  const out = await client.readRunLogs(4, { maxChars: 4000 })
  assert.match(out.text, /## job 1 — build \[completed\]/)
  assert.match(out.text, /## job 2 — test \[completed\]/)
  assert.ok(out.text.indexOf('BUILD-OUTPUT') < out.text.indexOf('TEST-OUTPUT'),
    'jobs must concatenate in list order')
  assert.equal(out.jobs.length, 2)
  fetchImpl.expectAllHandled()
})

test('readRunLogs falls back to a note when a job log is gone (404)', async () => {
  const fetchImpl = createFakeFetch([
    {
      pattern: /\/actions\/runs\/7\/jobs/,
      respond: () => makeResponse({ json: { jobs: [{ id: 1, name: 'j' }] } }),
    },
    {
      pattern: /\/actions\/jobs\/1\/logs/,
      respond: () => makeResponse({
        status: 404,
        json: { message: 'Job log expired' },
      }),
    },
  ])
  const client = makeClient(fetchImpl)
  const out = await client.readRunLogs(7, { maxChars: 500 })
  assert.match(out.text, /logs not available for job 1/)
})

test('readRunLogs rejects an unknown job selector', async () => {
  const fetchImpl = createFakeFetch([
    {
      pattern: /\/actions\/runs\/7\/jobs/,
      respond: () => makeResponse({ json: { jobs: [{ id: 1, name: 'j' }] } }),
    },
  ])
  const client = makeClient(fetchImpl)
  await assert.rejects(
    () => client.readRunLogs(7, { job: 'nope' }),
    (error) => error instanceof GithubError && error.code === 'JOB_NOT_FOUND',
  )
})

test('rate limiting maps 403 with exhausted quota to RATE_LIMITED', async () => {
  const fetchImpl = createFakeFetch([
    {
      respond: () => makeResponse({
        status: 403,
        json: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0' },
      }),
    },
  ])
  const client = makeClient(fetchImpl)
  await assert.rejects(
    () => client.getRun(1),
    (error) => error instanceof GithubError && error.code === 'RATE_LIMITED' && error.status === 403,
  )
})

test('check runs, annotations and per-SHA listing', async () => {
  const fetchImpl = createFakeFetch([
    {
      pattern: /\/check-runs\/55$/,
      respond: () => makeResponse({
        json: { id: 55, name: 'unit', status: 'completed', conclusion: 'failure', output: { summary: 'boom' } },
      }),
    },
    {
      pattern: /\/check-runs\/55\/annotations/,
      respond: () => makeResponse({ json: [{ path: 'src/a.js', start_line: 3, message: 'boom' }] }),
    },
    {
      pattern: /\/commits\/sha1\/check-runs/,
      respond: () => makeResponse({ json: { check_runs: [{ id: 55 }] } }),
    },
  ])
  const client = makeClient(fetchImpl)
  const check = await client.getCheckRun(55)
  assert.equal(check.conclusion, 'failure')
  const annotations = await client.getCheckRunAnnotations(55)
  assert.equal(annotations[0].path, 'src/a.js')
  const runs = await client.listCheckRunsForSha('sha1')
  assert.equal(runs[0].id, 55)
})

test('waitForRun polls until completed and returns the final run', async () => {
  const states = [
    run({ status: 'queued', conclusion: null }),
    run({ status: 'in_progress', conclusion: null }),
    run({ id: 55, status: 'completed', conclusion: 'failure' }),
  ]
  const fetchImpl = createFakeFetch([
    {
      pattern: /\/actions\/runs\/55$/,
      respond: () => makeResponse({ json: states.shift() }),
    },
  ])
  const client = makeClient(fetchImpl, { pollIntervalMs: 10, pollTimeoutMs: 5000 })
  const { run: finalRun, polls } = await client.waitForRun(55)
  assert.equal(finalRun.conclusion, 'failure')
  assert.equal(polls, 3)
})

test('waitForRun times out when a run never completes', async () => {
  const fetchImpl = createFakeFetch([
    {
      pattern: /\/actions\/runs\/55$/,
      respond: () => makeResponse({ json: run({ status: 'in_progress', conclusion: null }) }),
    },
  ])
  const client = makeClient(fetchImpl, { pollIntervalMs: 5, pollTimeoutMs: 120 })
  await assert.rejects(
    () => client.waitForRun(55),
    (error) => error instanceof GithubError && error.code === 'POLL_TIMEOUT',
  )
})

test('waitForRun aborts on signal', async () => {
  const controller = new AbortController()
  const fetchImpl = createFakeFetch([
    {
      pattern: /\/actions\/runs\/55$/,
      respond: () => makeResponse({ json: run({ status: 'in_progress', conclusion: null }) }),
    },
  ])
  const client = makeClient(fetchImpl, { pollIntervalMs: 5, pollTimeoutMs: 5000 })
  const pending = client.waitForRun(55, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, (error) => error instanceof GithubError && error.code === 'ABORTED')
})