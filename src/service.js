/**
 * Cross-source orchestration — the single high-level API that both the dsh
 * tools and the CLI drive. Harness-free: the `ctx.llm` service is injected as
 * an analyzer factory by the adapter, never imported here.
 */

import fs from 'node:fs'
import path from 'node:path'
import { GitHubApi } from './github.js'
import { LocalRunner } from './local.js'
import { cleanLog, maskOccurrences, tailChars } from './logs.js'
import { classifyFailure } from './classify.js'
import { OpenAiCompatibleClient, SYSTEM_PROMPT, buildDiagnosisPrompt } from './llm.js'
import { assembleReport, buildRunMeta } from './diagnose.js'
import {
  normalizeConfig, parseRepoArg, resolveTemplate,
} from './config.js'

/** Pick the first terminal conclusion that signals a problem. */
export function githubFailedStage(jobs) {
  if (!Array.isArray(jobs)) return ''
  const hardFail = jobs.find((job) =>
    job.conclusion === 'failure' || job.conclusion === 'timed_out'
    || job.conclusion === 'action_required')
  if (hardFail) {
    const step = (hardFail.steps ?? []).find((s) => s.conclusion === 'failure')
    return step ? `${hardFail.name} › ${step.name}` : hardFail.name
  }
  const tolerated = jobs.find((job) =>
    job.conclusion && !['success', 'skipped', 'neutral', 'cancelled', ''].includes(job.conclusion))
  return tolerated?.name ?? ''
}

/**
 * @typedef {object} CiServiceOptions
 * @property {Function} [llmAnalyzer] () => analyzer|null for the harness llm path
 * @property {object} [logger] minimal { info?, warn?, error? }
 * @property {Function} [githubFactory] (apiOptions) => GitHubApi-compatible client (tests)
 * @property {Function} [localFactory] () => { run(command, opts) } (tests)
 * @property {string[]} [secrets] extra values always masked out of logs
 */

export class CiService {
  /**
   * @param {object} [config] raw config; normalized internally
   * @param {CiServiceOptions} [options]
   */
  constructor(config = {}, options = {}) {
    this.cfg = normalizeConfig(config)
    this.logger = options.logger ?? null
    this.llmAnalyzerFactory = typeof options.llmAnalyzer === 'function'
      ? options.llmAnalyzer
      : () => null
    this.githubFactory = typeof options.githubFactory === 'function'
      ? options.githubFactory
      : (apiOptions) => new GitHubApi(apiOptions)
    this.localRunner = typeof options.localFactory === 'function'
      ? options.localFactory()
      : new LocalRunner({
        cwd: this.cfg.local.cwd,
        timeoutMs: this.cfg.local.timeoutMs,
        maxOutputChars: this.cfg.local.maxOutputChars,
      })
    this.extraSecrets = Array.isArray(options.secrets) ? [...options.secrets] : []
    this.localRuns = new Map() // runId -> LocalRecord
    this.localSeq = 0
  }

  /* ------------------------------------------------------------------ */
  /* Secrets                                                            */
  /* ------------------------------------------------------------------ */

  /** GitHub token, read fresh from the environment at call time. */
  githubToken() {
    return process.env[this.cfg.github.tokenEnv] ?? ''
  }

  /** Every secret value this instance knows about (for masking). */
  knownSecrets() {
    const secrets = new Set(this.extraSecrets)
    const token = process.env[this.cfg.github.tokenEnv]
    if (token) secrets.add(token)
    if (this.cfg.diagnosis.llm?.apiKey) secrets.add(this.cfg.diagnosis.llm.apiKey)
    for (const name of ['CI_RUNNER_LLM_API_KEY', 'OPENAI_API_KEY']) {
      const value = process.env[name]
      if (value) secrets.add(value)
    }
    return [...secrets]
  }

  /** Mask every known secret out of log text. */
  maskLog(text) {
    return maskOccurrences(String(text ?? ''), this.knownSecrets())
  }

  /** Build a fresh GitHub client bound to the current env token. */
  githubClient() {
    const cfg = this.cfg.github
    return this.githubFactory({
      token: this.githubToken(),
      defaultRepo: cfg.defaultRepo,
      apiBase: cfg.apiBase,
      pollIntervalMs: cfg.pollIntervalMs,
      pollTimeoutMs: cfg.pollTimeoutMs,
      dispatchWindowMs: cfg.dispatchWindowMs,
      requestTimeoutMs: cfg.requestTimeoutMs,
    })
  }

  /** Resolve the repository string for a call, or ''. */
  repoArg(args) {
    return parseRepoArg(args?.repo) ?? this.cfg.github.defaultRepo
  }

  /** Find a stored local record or throw. */
  getLocalRecord(runId) {
    const record = this.localRuns.get(String(runId))
    if (!record) {
      throw new Error(`unknown local run "${runId}" — pass "command" to run one, or "runId" of a stored run`)
    }
    return record
  }

  /* ------------------------------------------------------------------ */
  /* Run an analysis request against the best available provider         */
  /* ------------------------------------------------------------------ */

  /** Choose the analysis client: config endpoint first, then the injected harness analyzer. */
  pickAnalyzer() {
    const over = this.cfg.diagnosis.llm
    if (over && over.baseUrl) {
      const apiKey = over.apiKey
        || process.env.CI_RUNNER_LLM_API_KEY
        || process.env.OPENAI_API_KEY
        || ''
      return {
        source: this.cfg.diagnosis.providerLabel,
        complete: (req) => new OpenAiCompatibleClient({
          baseUrl: over.baseUrl,
          apiKey,
          model: over.model || 'deepseek-chat',
          timeoutMs: this.cfg.diagnosis.timeoutMs,
          temperature: this.cfg.diagnosis.temperature,
        }).complete(req),
      }
    }
    return this.llmAnalyzerFactory()
  }

  /** Run the model call and normalize success/failure into a stable shape. */
  async runAnalysis(meta, logTail, classification, signal) {
    let analyzer
    try {
      analyzer = this.pickAnalyzer()
    } catch (error) {
      // An analyzer factory that throws must degrade to the deterministic
      // report rather than kill the whole diagnosis.
      this.logger?.warn?.(`ci-runner: analysis provider unavailable: ${error.message}`)
      return { text: '', source: 'none', error: error.message }
    }
    if (!analyzer) {
      return { text: '', source: 'none', error: '' }
    }
    const prompt = buildDiagnosisPrompt(meta, classification, logTail)
    try {
      const text = await analyzer.complete({
        prompt,
        system: SYSTEM_PROMPT,
        maxTokens: 900,
        temperature: this.cfg.diagnosis.temperature,
        signal,
      })
      return { text, source: analyzer.source ?? 'model', error: '' }
    } catch (error) {
      this.logger?.warn?.(`ci-runner: analysis failed: ${error.message}`)
      return { text: '', source: analyzer.source ?? 'model', error: error.message }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Trigger                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Start a run in source-driven fashion and return a run reference.
   * GitHub returns immediately (queued); local runs execute synchronously to
   * completion (their outcome is stored for status/logs/diagnose).
   */
  async trigger(args = {}) {
    const source = args.source ?? 'github'
    if (source === 'github') {
      const repo = this.repoArg(args)
      const client = this.githubClient()
      const ref = args.ref || this.cfg.github.defaultBranch
      const info = await client.triggerWorkflow({
        workflow: args.workflow,
        ref,
        ...(args.inputs && typeof args.inputs === 'object' ? { inputs: args.inputs } : {}),
        ...(repo ? { repo } : {}),
        signal: args.signal,
      })
      return {
        source: 'github',
        runId: info.runId,
        status: 'queued',
        repo: repo || null,
        workflow: args.workflow,
        ref,
        inputs: args.inputs || null,
      }
    }
    if (source === 'local') {
      const command = resolveTemplate(this.cfg, args.command ?? args.template)
      const cwd = path.resolve(args.cwd ?? this.cfg.local.cwd)
      const outcome = await this.localRunner.run(command, {
        cwd,
        timeoutMs: args.timeoutMs ?? this.cfg.local.timeoutMs,
        maxOutputChars: args.maxOutputChars ?? this.cfg.local.maxOutputChars,
        signal: args.signal,
      })
      return this.storeLocal(command, cwd, outcome)
    }
    throw new Error(`unknown source "${source}" (expected "github" or "local")`)
  }

  /** Store a local outcome and return its run reference. */
  storeLocal(command, cwd, outcome) {
    const runId = `local-${++this.localSeq}`
    const record = {
      id: runId,
      source: 'local',
      command,
      cwd,
      status: 'completed',
      conclusion: outcome.ok ? 'success' : (outcome.killed ? 'timed_out' : 'failure'),
      ok: outcome.ok,
      exitCode: outcome.exitCode,
      killed: outcome.killed,
      durationMs: outcome.durationMs,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      stdoutTruncated: outcome.stdoutTruncated,
      stderrTruncated: outcome.stderrTruncated,
      startedAt: new Date(Date.now() - outcome.durationMs).toISOString(),
      completedAt: new Date().toISOString(),
    }
    this.localRuns.set(runId, record)
    return {
      source: 'local',
      runId,
      command,
      cwd,
      status: record.status,
      conclusion: record.conclusion,
      ok: record.ok,
      exitCode: record.exitCode,
      killed: record.killed,
      durationMs: record.durationMs,
    }
  }

  /** Launch a command and store a local record, returning its id. (helper for watch/diagnose) */
  async runLocalAndStore(command, opts = {}) {
    const cwd = path.resolve(opts.cwd ?? this.cfg.local.cwd)
    const outcome = await this.localRunner.run(resolveTemplate(this.cfg, command), {
      cwd,
      timeoutMs: opts.timeoutMs ?? this.cfg.local.timeoutMs,
      maxOutputChars: opts.maxOutputChars ?? this.cfg.local.maxOutputChars,
      signal: opts.signal,
    })
    return this.storeLocal(resolveTemplate(this.cfg, command), cwd, outcome)
  }

  /* ------------------------------------------------------------------ */
  /* Status                                                              */
  /* ------------------------------------------------------------------ */

  /** Current status of a run (single poll, no waiting). */
  async status(args = {}) {
    const source = args.source ?? 'github'
    if (source === 'local') {
      const record = this.getLocalRecord(args.runId)
      return {
        source: 'local',
        runId: record.id,
        status: record.status,
        conclusion: record.conclusion,
        state: record.conclusion,
        ok: record.ok,
        exitCode: record.exitCode,
        killed: record.killed,
        command: record.command,
        cwd: record.cwd,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
      }
    }
    const repo = this.repoArg(args)
    const client = this.githubClient()
    const run = await client.getRun(args.runId, { repo: repo || undefined, signal: args.signal })
    const jobs = await client.listJobs(args.runId, { repo: repo || undefined, signal: args.signal })
    return {
      source: 'github',
      runId: run.id,
      repo: repo || run.repository?.full_name || null,
      status: run.status ?? 'unknown',
      conclusion: run.conclusion ?? null,
      state: run.status === 'completed' ? (run.conclusion ?? 'completed') : run.status,
      startedAt: run.run_started_at ?? null,
      completedAt: run.updated_at ?? null,
      durationMs: run.run_started_at && run.updated_at
        ? Date.parse(run.updated_at) - Date.parse(run.run_started_at)
        : null,
      url: run.html_url ?? null,
      headSha: run.head_sha ?? null,
      failedStage: githubFailedStage(jobs),
      jobs: jobs.map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion ?? null,
        url: job.html_url ?? null,
        steps: (job.steps ?? []).map((step) => ({
          name: step.name,
          status: step.status,
          conclusion: step.conclusion ?? null,
        })),
      })),
    }
  }

  /* ------------------------------------------------------------------ */
  /* Logs                                                                */
  /* ------------------------------------------------------------------ */

  /** Read logs back, masked and tail-truncated. */
  async logs(args = {}) {
    const source = args.source ?? 'github'
    const maxChars = args.tailChars ?? args.maxChars ?? this.cfg.github.readLogChars
    if (source === 'local') {
      const record = this.getLocalRecord(args.runId)
      const combined = `${record.stdout}\n${record.stderr}`
      const tail = tailChars(cleanLog(combined), maxChars)
      return {
        source: 'local',
        runId: record.id,
        command: record.command,
        jobs: [],
        text: this.maskLog(tail.text),
        truncated: tail.truncated || record.stdoutTruncated || record.stderrTruncated,
        chars: tail.text.length,
      }
    }
    const repo = this.repoArg(args)
    const client = this.githubClient()
    const output = await client.readRunLogs(args.runId, {
      repo: repo || undefined,
      job: args.job,
      maxChars,
      signal: args.signal,
    })
    const tail = tailChars(cleanLog(output.text), maxChars)
    return {
      source: 'github',
      runId: args.runId,
      repo: repo || null,
      jobs: output.jobs,
      text: this.maskLog(tail.text),
      truncated: tail.truncated || output.truncated,
      chars: tail.text.length,
    }
  }

  /* ------------------------------------------------------------------ */
  /* Watch                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Wait for a run to finish. Accepts an existing runId or trigger arguments
   * (resolving it via {@link trigger} first). Returns the final status and,
   * when the run failed and `includeLogsOnFailure` is set, the log tail.
   */
  async watch(args = {}) {
    const includeLogs = args.includeLogsOnFailure !== false
    const source = args.source ?? 'github'

    if (source === 'local') {
      let record
      const command = args.command ?? args.template
      if (command) {
        record = this.localRuns.get((await this.runLocalAndStore(command, args)).runId)
      } else {
        record = this.getLocalRecord(args.runId)
      }
      const result = {
        source: 'local',
        runId: record.id,
        status: record.status,
        conclusion: record.conclusion,
        state: record.conclusion,
        ok: record.ok,
        exitCode: record.exitCode,
        killed: record.killed,
        command: record.command,
        cwd: record.cwd,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
      }
      if (includeLogs && !record.ok) {
        const tail = tailChars(cleanLog(`${record.stdout}\n${record.stderr}`), this.cfg.github.readLogChars)
        result.tailLog = { text: this.maskLog(tail.text), truncated: tail.truncated, chars: tail.text.length }
      }
      return result
    }

    const repo = this.repoArg(args)
    const client = this.githubClient()
    let runId = args.runId
    let triggerInfo = null
    if (!runId) {
      const ref = args.ref || this.cfg.github.defaultBranch
      const info = await client.triggerWorkflow({
        workflow: args.workflow,
        ref,
        ...(args.inputs && typeof args.inputs === 'object' ? { inputs: args.inputs } : {}),
        ...(repo ? { repo } : {}),
        signal: args.signal,
      })
      runId = info.runId
      triggerInfo = { workflow: args.workflow, ref, inputs: args.inputs || null }
    }
    const { run, jobs } = await this.waitGithubRun(client, runId, {
      repo: repo || undefined,
      timeoutMs: args.timeoutMs ?? this.cfg.github.pollTimeoutMs,
      intervalMs: args.intervalMs ?? this.cfg.github.pollIntervalMs,
      signal: args.signal,
    })
    const result = {
      source: 'github',
      runId,
      repo: repo || run.repository?.full_name || null,
      status: run.status ?? 'unknown',
      conclusion: run.conclusion ?? null,
      state: run.status === 'completed' ? (run.conclusion ?? 'completed') : run.status,
      startedAt: run.run_started_at ?? null,
      completedAt: run.updated_at ?? null,
      url: run.html_url ?? null,
      failedStage: githubFailedStage(jobs),
      ...(triggerInfo ? { workflow: triggerInfo.workflow, ref: triggerInfo.ref } : {}),
    }
    const failed = result.state !== 'success' && result.state !== 'skipped' && result.state !== 'neutral'
    if (includeLogs && failed) {
      const tail = await this.logs({ source: 'github', runId, repo: repo || undefined, tailChars: this.cfg.github.readLogChars, signal: args.signal })
      result.tailLog = { text: tail.text, truncated: tail.truncated, chars: tail.chars }
    }
    return result
  }

  /** GitHub wait helper: poll to completion and fetch jobs. */
  async waitGithubRun(client, runId, opts) {
    const { run, polls } = await client.waitForRun(runId, {
      repo: opts.repo,
      pollIntervalMs: opts.intervalMs,
      pollTimeoutMs: opts.timeoutMs,
      signal: opts.signal,
    })
    const jobs = await client.listJobs(runId, { repo: opts.repo, signal: opts.signal })
    return { run, jobs, polls }
  }

  /* ------------------------------------------------------------------ */
  /* Diagnose                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * End-to-end diagnosis: resolve a run (existing or freshly triggered), wait
   * for it to finish, and on failure hand the masked log tail to the analysis
   * provider for a Markdown root-cause report.
   */
  async diagnose(args = {}) {
    const source = args.source ?? 'github'

    // Resolve + wait for the run to reach a terminal state.
    let state
    if (source === 'local') {
      let record
      const command = args.command ?? args.template
      if (command) {
        record = this.localRuns.get((await this.runLocalAndStore(command, args)).runId)
      } else {
        record = this.getLocalRecord(args.runId)
      }
      state = {
        source: 'local',
        runId: record.id,
        meta: {
          source: 'local',
          runId: record.id,
          command: record.command,
          status: record.status,
          conclusion: record.conclusion,
          startedAt: record.startedAt,
          completedAt: record.completedAt,
          durationMs: record.durationMs,
          exitCode: record.exitCode,
        },
        ok: record.ok,
        record,
      }
    } else {
      const repo = this.repoArg(args)
      const client = this.githubClient()
      let runId = args.runId
      let triggerInfo = null
      if (!runId) {
        const ref = args.ref || this.cfg.github.defaultBranch
        const info = await client.triggerWorkflow({
          workflow: args.workflow,
          ref,
          ...(args.inputs && typeof args.inputs === 'object' ? { inputs: args.inputs } : {}),
          ...(repo ? { repo } : {}),
          signal: args.signal,
        })
        runId = info.runId
        triggerInfo = { workflow: args.workflow, ref, inputs: args.inputs || null }
      }
      const { run, jobs } = await this.waitGithubRun(client, runId, {
        repo: repo || undefined,
        timeoutMs: args.timeoutMs ?? this.cfg.github.pollTimeoutMs,
        intervalMs: args.intervalMs ?? this.cfg.github.pollIntervalMs,
        signal: args.signal,
      })
      const failedStage = githubFailedStage(jobs)
      state = {
        source: 'github',
        runId,
        repo: repo || run.repository?.full_name || null,
        ok: run.conclusion === 'success',
        meta: {
          source: 'github',
          runId: run.id,
          repo: repo || run.repository?.full_name || null,
          workflow: triggerInfo?.workflow ?? run.name ?? run.path ?? '',
          job: failedStage || '',
          ref: triggerInfo?.ref ?? run.display_title ?? '',
          status: run.status ?? 'unknown',
          conclusion: run.conclusion ?? null,
          failedStage,
          startedAt: run.run_started_at ?? '',
          completedAt: run.updated_at ?? '',
          durationMs: run.run_started_at && run.updated_at
            ? Date.parse(run.updated_at) - Date.parse(run.run_started_at)
            : null,
          exitCode: null,
          url: run.html_url ?? '',
        },
        tail: { jobs, client, repo },
      }
    }

    // A passing run needs no diagnosis.
    if (state.ok) {
      const meta = buildRunMeta(state.meta)
      return assembleReport({ meta, success: true, logTail: { text: '', truncated: false } })
    }

    // Failure: assemble the log tail.
    const maxTail = this.cfg.diagnosis.maxTailChars
    let rawTail = ''
    if (source === 'local') {
      rawTail = cleanLog(`${state.record.stdout}\n${state.record.stderr}`)
    } else {
      const output = await state.tail.client.readRunLogs(state.runId, {
        repo: state.tail.repo || undefined,
        maxChars: maxTail,
        signal: args.signal,
      })
      rawTail = cleanLog(output.text)
    }
    const logTail = tailChars(this.maskLog(rawTail), maxTail)

    const classification = classifyFailure({
      log: logTail.text,
      exitCode: state.meta.exitCode ?? undefined,
      killed: state.record?.killed ?? false,
    })

    const meta = buildRunMeta(state.meta)
    const analysis = await this.runAnalysis(meta, logTail.text, classification, args.signal)

    const report = assembleReport({
      meta,
      logTail,
      classification,
      analysis: analysis.text,
      analysisSource: analysis.source,
      analysisError: analysis.error,
    })

    if (args.savePath) {
      const target = path.resolve(args.savePath)
      fs.writeFileSync(target, report.report, 'utf8')
      report.savedPath = target
    }
    return report
  }
}
