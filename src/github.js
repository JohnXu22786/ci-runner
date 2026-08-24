/**
 * GitHub REST client for Actions — the smallest useful surface for triggering
 * workflow runs, reading their status and jobs, streaming job logs, and
 * consulting check runs (including annotations that point at failing files).
 *
 * Builds on the global `fetch` (Node >= 18) — no HTTP dependency. The token
 * is supplied per construction from the environment by the caller and is
 * never written to logs or disk. `fetchImpl` is injectable for tests.
 */
import { tailChars } from './logs.js'

/** Error carrying the HTTP status and a stable machine-readable code. */
export class GithubError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'GithubError'
    this.status = options.status ?? 0
    this.code = options.code ?? 'GITHUB_ERROR'
  }
}

const API_VERSION = '2022-11-28'
const USER_AGENT = 'dsh-ci-runner/0.1'

/** Abortable delay helper. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new GithubError('request aborted', { code: 'ABORTED' }))
    }, { once: true })
  })
}

export class GitHubApi {
  /**
   * @param {object} [options]
   * @param {string} [options.token] GitHub token (bearer). Empty means
   *   unauthenticated requests (only useful for public metadata).
   * @param {string} [options.defaultRepo] default `owner/repo`
   * @param {string} [options.apiBase] REST base (GHES override)
   * @param {number} [options.pollIntervalMs]
   * @param {number} [options.pollTimeoutMs]
   * @param {number} [options.dispatchWindowMs]
   * @param {number} [options.requestTimeoutMs]
   * @param {function} [options.fetchImpl] injectable fetch (tests)
   */
  constructor(options = {}) {
    this.token = options.token ?? ''
    this.defaultRepo = options.defaultRepo ?? ''
    this.apiBase = String(options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
    this.pollIntervalMs = options.pollIntervalMs ?? 5000
    this.pollTimeoutMs = options.pollTimeoutMs ?? 600000
    this.dispatchWindowMs = options.dispatchWindowMs ?? 20000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('GitHubApi requires a fetch implementation (Node >= 18)')
    }
  }

  /** Resolve a `owner/repo` value, falling back to the client default. */
  resolveRepo(value) {
    if (typeof value === 'string' && value.includes('/')) {
      const [owner, ...rest] = value.split('/')
      const repo = rest.join('/')
      if (owner && repo) return { owner, repo }
    }
    if (typeof this.defaultRepo === 'string' && this.defaultRepo.includes('/')) {
      const [owner, ...rest] = this.defaultRepo.split('/')
      const repo = rest.join('/')
      if (owner && repo) return { owner, repo }
    }
    throw new GithubError('no repository configured — pass repo as "owner/repo" or set github.defaultRepo', {
      code: 'NO_REPO',
    })
  }

  /** Assert that a token is available for an authenticated call. */
  requireToken() {
    if (!this.token || this.token.length === 0) {
      throw new GithubError('no GitHub token — set the configured environment variable '
        + '(default GITHUB_TOKEN) before calling this operation', { code: 'NO_TOKEN' })
    }
    return this.token
  }

  /**
   * Low-level request. Returns parsed JSON, a raw string for text bodies, or
   * undefined for 204/empty bodies. Rejects with {@link GithubError} on
   * non-2xx responses (with GitHub's `message` when present) and on timeout
   * or abort.
   */
  async request(method, path, options = {}) {
    this.requireToken()
    const { query, body, signal, raw } = options
    const qs = query !== undefined && query !== null ? `?${new URLSearchParams(query)}` : ''
    const url = `${this.apiBase}/${path}${qs}`

    const headers = {
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': API_VERSION,
      Accept: raw ? 'text/plain; charset=utf-8' : 'application/vnd.github+json',
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)

    let response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'follow',
      })
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal?.aborted) {
          throw new GithubError('request aborted', { code: 'ABORTED' })
        }
        throw new GithubError('GitHub request timed out', { code: 'TIMEOUT' })
      }
      throw new GithubError(`GitHub request failed: ${error.message}`, { code: 'NETWORK' })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }

    if (!response.ok) {
      throw await this.toError(response)
    }
    if (response.status === 204) return undefined
    const text = await response.text()
    if (!text) return undefined
    if (raw) return text
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /** Build a {@link GithubError} from a non-2xx response. */
  async toError(response) {
    let message = `GitHub API responded ${response.status}`
    let code = 'HTTP_ERROR'
    try {
      const payload = await response.json()
      if (typeof payload.message === 'string') message = payload.message
      if (typeof payload.documentation_url === 'string') {
        message += ` (${payload.documentation_url})`
      }
    } catch {
      // non-JSON error body; keep the status text
    }
    if (response.status === 403) {
      const remaining = Number(response.headers.get('x-ratelimit-remaining'))
      if (remaining === 0) code = 'RATE_LIMITED'
    } else if (response.status === 404) {
      code = 'NOT_FOUND'
    } else if (response.status === 401) {
      code = 'UNAUTHORIZED'
    } else if (response.status === 422) {
      code = 'REQUEST_REJECTED'
    }
    return new GithubError(message, { status: response.status, code })
  }

  /**
   * Trigger a workflow_dispatch and resolve the created run id.
   * @param {object} params
   * @param {string} params.workflow workflow id or filename (`build.yml`)
   * @param {string} params.ref branch/tag/sha the dispatch runs on
   * @param {object} [params.inputs] workflow_dispatch inputs
   * @param {string} [params.repo] `owner/repo`
   * @param {number} [params.dispatchWindowMs]
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<{runId: number}>}
   */
  async triggerWorkflow(params = {}) {
    const { owner, repo } = this.resolveRepo(params.repo)
    if (!params.workflow || typeof params.workflow !== 'string') {
      throw new GithubError('workflow is required (id or filename like "build.yml")', { code: 'BAD_ARGS' })
    }
    const ref = params.ref || 'main'
    const payload = { ref }
    if (params.inputs && typeof params.inputs === 'object'
      && Object.keys(params.inputs).length > 0) {
      payload.inputs = params.inputs
    }
    const dispatchedAt = Date.now()
    await this.request('POST', `repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(params.workflow)}/dispatches`, {
      body: payload,
      signal: params.signal,
    })
    const runId = await this.findRecentDispatchRun({
      owner, repo, workflow: params.workflow, ref, dispatchedAt,
      windowMs: params.dispatchWindowMs ?? this.dispatchWindowMs,
      signal: params.signal,
    })
    return { runId }
  }

  /**
   * Poll the runs list for the workflow run a dispatch just created. The
   * dispatch endpoint returns 204 with no id, so we list recent
   * workflow_dispatch runs and pick the newest run for `ref` and `workflow`
   * that was created around the dispatch moment — an older run for the same
   * workflow+ref (e.g. from a previous dispatch in a dev loop) must never
   * win. Matching is client-side on the run payload (`head_branch` for
   * branches and tags, `head_sha` for SHA refs).
   */
  async findRecentDispatchRun({ owner, repo, workflow, ref, dispatchedAt, windowMs, signal }) {
    const deadline = Date.now() + windowMs
    const skewMs = 3000 // tolerate GitHub's list propagation delay
    let best = null
    while (Date.now() < deadline) {
      // No `branch` query filter: it does not cover tags/SHAs and the
      // client-side match below is authoritative for every ref kind.
      const data = await this.request('GET', `repos/${owner}/${repo}/actions/runs`, {
        query: { event: 'workflow_dispatch', per_page: '20' },
        signal,
      })
      const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : []
      for (const run of runs) {
        if (!matchesDispatchRun(run, workflow, ref)) continue
        const createdAt = Date.parse(run.created_at ?? '')
        if (!Number.isNaN(createdAt) && createdAt < dispatchedAt - skewMs) continue
        if (best === null || run.id > best.id) best = { id: run.id, createdAt }
      }
      // The list is newest-first, so the first fresh candidate is the newest
      // run for this workflow+ref; no point waiting longer.
      if (best !== null) return best.id
      await delay(Math.min(1500, Math.max(200, windowMs / 4)), signal)
    }
    throw new GithubError(
      `no run appeared for workflow "${workflow}" on ${ref} within ${windowMs}ms — `
      + 'confirm the workflow has a workflow_dispatch trigger and the token can list runs',
      { code: 'RUN_NOT_FOUND' },
    )
  }

  /** Current status of a workflow run. */
  async getRun(runId, params = {}) {
    const { owner, repo } = this.resolveRepo(params.repo)
    return this.request('GET', `repos/${owner}/${repo}/actions/runs/${runId}`, {
      signal: params.signal,
    })
  }

  /** Jobs (and steps) of a workflow run. */
  async listJobs(runId, params = {}) {
    const { owner, repo } = this.resolveRepo(params.repo)
    const data = await this.request('GET', `repos/${owner}/${repo}/actions/runs/${runId}/jobs`, {
      query: { per_page: '100' },
      signal: params.signal,
    })
    return Array.isArray(data?.jobs) ? data.jobs : []
  }

  /** Raw log text of a single job (follows the signed redirect). */
  async getJobLogsText(jobId, params = {}) {
    const { owner, repo } = this.resolveRepo(params.repo)
    return this.request('GET', `repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
      signal: params.signal,
      raw: true,
    })
  }

  /**
   * Fetch logs for a run, concatenating the matching jobs and truncating to
   * `maxChars`. When `job` is given (id or name) only that job's logs are
   * fetched; otherwise every job is fetched in order.
   * @returns {Promise<{jobs: Array<object>, text: string, truncated: boolean, chars: number}>}
   */
  async readRunLogs(runId, params = {}) {
    const { owner, repo } = this.resolveRepo(params.repo)
    const jobs = await this.listJobs(runId, { repo: `${owner}/${repo}`, signal: params.signal })
    if (jobs.length === 0) {
      return { jobs: [], text: '', truncated: false, chars: 0 }
    }
    const maxChars = params.maxChars ?? 40_000
    let targets = jobs
    if (params.job !== undefined && params.job !== null && params.job !== '') {
      const needle = String(params.job)
      targets = jobs.filter((job) => String(job.id) === needle || job.name === needle)
      if (targets.length === 0) {
        throw new GithubError(`no job matches "${params.job}" in run ${runId}`, {
          code: 'JOB_NOT_FOUND',
          status: 404,
        })
      }
    }

    const sections = []
    let chars = 0
    let truncated = false
    for (const job of targets) {
      let text = ''
      try {
        text = await this.getJobLogsText(job.id, { repo: `${owner}/${repo}`, signal: params.signal })
      } catch (error) {
        if (error instanceof GithubError && (error.status === 404 || error.status === 410)) {
          text = `[logs not available for job ${job.id} (${job.name ?? ''})]: ${error.message}`
        } else {
          throw error
        }
      }
      const header = `## job ${job.id} — ${job.name ?? '(unnamed)'} [${job.status}]`
      const section = `${header}\n${text}\n`
      if (chars + section.length > maxChars) {
        // The failure tail is where the errors are: keep the END of the
        // overflowing section and stop pulling more jobs.
        truncated = true
        const remaining = maxChars - chars
        if (remaining > 0) {
          const piece = section.length > remaining ? section.slice(-remaining) : section
          sections.push(piece)
          chars += piece.length
        }
        break
      }
      sections.push(section)
      chars += section.length
    }
    let joined = sections.join('')
    if (joined.length > maxChars) {
      const cut = tailChars(joined, maxChars)
      joined = cut.text
      truncated = cut.truncated || truncated
    }
    return {
      jobs: jobs.map((job) => ({
        id: job.id, name: job.name, status: job.status, conclusion: job.conclusion ?? null,
        url: job.html_url ?? null,
      })),
      text: joined,
      truncated,
      chars: joined.length,
    }
  }

  /** Details of a check run, including its output summary. */
  async getCheckRun(checkRunId, params = {}) {
    const { owner, repo } = this.resolveRepo(params.repo)
    return this.request('GET', `repos/${owner}/${repo}/check-runs/${checkRunId}`, {
      signal: params.signal,
    })
  }

  /** File-level annotations of a check run (path, line, message). */
  async getCheckRunAnnotations(checkRunId, params = {}) {
    const { owner, repo } = this.resolveRepo(params.repo)
    const data = await this.request('GET', `repos/${owner}/${repo}/check-runs/${checkRunId}/annotations`, {
      query: { per_page: '50' },
      signal: params.signal,
    })
    return Array.isArray(data) ? data : []
  }

  /** Check runs for a commit SHA. */
  async listCheckRunsForSha(sha, params = {}) {
    const { owner, repo } = this.resolveRepo(params.repo)
    const data = await this.request('GET', `repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/check-runs`, {
      signal: params.signal,
    })
    return Array.isArray(data?.check_runs) ? data.check_runs : []
  }

  /** Check suites for a commit SHA. */
  async listCheckSuitesForSha(sha, params = {}) {
    const { owner, repo } = this.resolveRepo(params.repo)
    const data = await this.request('GET', `repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/check-suites`, {
      signal: params.signal,
    })
    return Array.isArray(data?.check_suites) ? data.check_suites : []
  }

  /**
   * Poll a run until it reaches a terminal status.
   * @returns {Promise<{run: object, polls: number}>} the final run and poll count
   */
  async waitForRun(runId, params = {}) {
    const { owner, repo } = this.resolveRepo(params.repo)
    const interval = params.pollIntervalMs ?? this.pollIntervalMs
    const budget = params.pollTimeoutMs ?? this.pollTimeoutMs
    const started = Date.now()
    let polls = 0
    for (;;) {
      if (params.signal?.aborted) {
        throw new GithubError('aborted while waiting for run to complete', { code: 'ABORTED' })
      }
      const run = await this.getRun(runId, { repo: `${owner}/${repo}`, signal: params.signal })
      polls += 1
      const status = run.status ?? 'unknown'
      if (status === 'completed' || status === 'error') {
        return { run, polls }
      }
      if (Date.now() - started >= budget) {
        throw new GithubError(
          `run ${runId} did not finish within ${budget}ms (last status "${status}")`,
          { code: 'POLL_TIMEOUT' },
        )
      }
      await delay(interval, params.signal)
    }
  }
}

/** The runs-list entry for the dispatch we just created? */
function matchesDispatchRun(run, workflow, ref) {
  const matchesWorkflow = typeof workflow === 'string'
    && (/^\d+$/.test(workflow)
      ? String(run.workflow_id) === workflow
      : String(run.path ?? '').endsWith(workflow))
  if (!matchesWorkflow) return false
  if (/^[0-9a-f]{7,40}$/.test(ref)) {
    return String(run.head_sha ?? '').toLowerCase().startsWith(ref.toLowerCase())
  }
  // Branch or tag: the run may not expose head_branch yet while the list is
  // propagating; a null head_branch is tolerated, the created_at window is
  // the discriminator in that case.
  return run.head_branch == null || String(run.head_branch ?? '') === ref
}

