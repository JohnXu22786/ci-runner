/**
 * The model-facing tool set this bundle registers on `ctx.tools`:
 *
 *   ci_trigger  — start CI: GitHub workflow_dispatch or a local command run.
 *   ci_status   — current status of a run (single poll).
 *   ci_logs     — read a run's logs, masked and tail-truncated.
 *   ci_watch    — wait for a run to finish (optionally starting it first).
 *   ci_diagnose — end-to-end: run/wait, then hand the failure tail to the
 *                 analysis provider for a Markdown root-cause report.
 *
 * Every tool is a thin adapter over {@link CiService}; all state (local run
 * results, config, secrets) lives in the service instance. Tool bodies return
 * canonical lossless-JSON values (`undefined` fields are dropped by the JSON
 * round-trip) and a text renderer for the harness.
 */

const jsonify = (value) => JSON.parse(JSON.stringify(value))

/** Shared parameter fragments. */
const sourceParam = {
  type: 'string',
  enum: ['github', 'local'],
  description: 'Source of the run: "github" (workflow_dispatch / check runs) or "local" (a shell command pipeline).',
}
const repoParam = {
  type: 'string',
  description: 'Repository as "owner/repo". Defaults to the configured github.defaultRepo.',
}
const runIdParam = {
  description: 'The run id to operate on. For GitHub this is the Actions run id.',
}

/** Build one tool definition in the shape `ctx.tools.register` accepts. */
function defineCiTool({ name, description, output, timeoutMs, execute, parameters }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: parameters,
      additionalProperties: false,
    },
    output: {
      schema: output,
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    },
    timeoutMs,
    execute,
  }
}

/** Render a tool result object to a concise text form. */
function renderText(value) {
  if (!value || typeof value !== 'object') return String(value)
  if (typeof value.report === 'string' && value.ok === false) return value.report
  if (typeof value.report === 'string') return value.report
  if (typeof value.text === 'string') return value.text
  return jsonBody(value)
}

function jsonBody(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * @param {import('./service.js').CiService} service
 * @param {object} cfg normalized config
 * @returns {Array<object>} tool definitions in registration order
 */
export function defineCiTools(service, cfg) {
  const githubParams = {
    source: sourceParam,
    runId: runIdParam,
    repo: repoParam,
    job: {
      type: 'string',
      description: 'GitHub only: fetch logs of a single job (by id or name) instead of all jobs.',
    },
    tailChars: {
      type: 'integer',
      description: 'Cap on how many trailing characters to return (default from config).',
    },
    maxChars: {
      type: 'integer',
      description: 'Deprecated alias for tailChars.',
    },
  }

  const triggerExtra = {
    workflow: {
      type: 'string',
      description: 'GitHub workflow id or filename (e.g. "build.yml"). Required for github source.',
    },
    ref: {
      type: 'string',
      description: 'Branch/tag/sha to dispatch on (defaults to the configured defaultBranch).',
    },
    inputs: {
      type: 'object',
      description: 'workflow_dispatch inputs passed through verbatim.',
      additionalProperties: true,
    },
    command: {
      type: 'string',
      description: 'Local pipeline: a configured template name (e.g. "npm test") or a raw shell command.',
    },
    template: {
      type: 'string',
      description: 'Alias for command when selecting a configured template.',
    },
    cwd: {
      type: 'string',
      description: 'Working directory for a local run (defaults to config.local.cwd).',
    },
    timeoutMs: {
      type: 'integer',
      description: 'Hard timeout (ms) for a local run.',
    },
    intervalMs: {
      type: 'integer',
      description: 'Poll interval (ms) while waiting for a GitHub run.',
    },
  }

  return [
    defineCiTool({
      name: 'ci_trigger',
      description: 'Trigger CI and return a run reference. With source=github it dispatches a GitHub Actions '
        + 'workflow_dispatch and returns the created run id (queued); with source=local it runs a command '
        + 'pipeline to completion and returns its outcome. For local pipelines supply "command" (a configured '
        + 'template name such as "npm test"/"pytest" or a raw shell command line). Use ci_watch to block until '
        + 'completion, ci_status for a single poll, ci_logs to read output, and ci_diagnose for failure analysis.',
      parameters: {
        source: sourceParam,
        workflow: triggerExtra.workflow,
        ref: triggerExtra.ref,
        inputs: triggerExtra.inputs,
        repo: repoParam,
        command: triggerExtra.command,
        template: triggerExtra.template,
        cwd: triggerExtra.cwd,
        timeoutMs: triggerExtra.timeoutMs,
      },
      output: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          runId: { type: 'string' },
          status: { type: 'string' },
          conclusion: { type: 'string' },
          ok: { type: 'boolean' },
          exitCode: { type: 'integer' },
          killed: { type: 'boolean' },
          durationMs: { type: 'integer' },
          command: { type: 'string' },
          workflow: { type: 'string' },
          ref: { type: 'string' },
          repo: { type: 'string' },
          inputs: { type: 'object' },
          cwd: { type: 'string' },
        },
        required: ['source', 'runId', 'status'],
        additionalProperties: false,
      },
      timeoutMs: Math.max(cfg.github.dispatchWindowMs + 10_000, cfg.local.timeoutMs + 5_000),
      execute: async (raw, exec) => {
        const args = readArgs(raw)
        const result = await service.trigger({ ...args, signal: exec.signal })
        return jsonify({ ...result, runId: String(result.runId) })
      },
    }),

    defineCiTool({
      name: 'ci_status',
      description: 'Current status of a CI run: status (queued/in_progress/completed), conclusion, jobs and their '
        + 'steps, plus the failed stage when known. Use for a single poll; prefer ci_watch to block until the '
        + 'run finishes.',
      parameters: {
        source: sourceParam,
        runId: runIdParam,
        repo: repoParam,
      },
      output: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          runId: { type: 'string' },
          status: { type: 'string' },
          conclusion: { type: 'string' },
          state: { type: 'string' },
          failedStage: { type: 'string' },
          repo: { type: 'string' },
          startedAt: { type: 'string' },
          completedAt: { type: 'string' },
          durationMs: { type: 'integer' },
          url: { type: 'string' },
          headSha: { type: 'string' },
          ok: { type: 'boolean' },
          exitCode: { type: 'integer' },
          killed: { type: 'boolean' },
          command: { type: 'string' },
          cwd: { type: 'string' },
          jobs: { type: 'array' },
        },
        required: ['source', 'runId', 'status'],
        additionalProperties: false,
      },
      timeoutMs: cfg.github.requestTimeoutMs * 4,
      execute: async (raw, exec) => {
        const args = readArgs(raw)
        const result = await service.status({ ...args, runId: normalizeRunId(args.runId), signal: exec.signal })
        return jsonify({ ...result, runId: String(result.runId) })
      },
    }),

    defineCiTool({
      name: 'ci_logs',
      description: 'Read a run\'s logs, masked and tail-truncated to keep output bounded. For GitHub, "job" '
        + 'selects a single job (id or name); otherwise all jobs are concatenated. Credentials (the GitHub '
        + 'token and any configured analysis API key) are redacted from the returned text.',
      parameters: githubParams,
      output: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          runId: { type: 'string' },
          repo: { type: 'string' },
          command: { type: 'string' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          chars: { type: 'integer' },
          jobs: { type: 'array' },
        },
        required: ['source', 'runId', 'text', 'truncated'],
        additionalProperties: false,
      },
      timeoutMs: Math.max(cfg.github.pollTimeoutMs, 120_000),
      execute: async (raw, exec) => {
        const args = readArgs(raw)
        const result = await service.logs({
          source: args.source,
          runId: normalizeRunId(args.runId),
          repo: args.repo,
          job: args.job,
          tailChars: args.tailChars ?? args.maxChars,
          signal: exec.signal,
        })
        return jsonify({ ...result, runId: String(result.runId) })
      },
    }),

    defineCiTool({
      name: 'ci_watch',
      description: 'Wait for a CI run to finish and return its final status. With source=github you may pass an '
        + 'existing runId or workflow/ref/inputs to trigger-and-watch; with source=local pass "command" (or a '
        + 'stored runId). On failure the tail of the log is included (set includeLogsOnFailure=false to skip). '
        + 'Respects timeoutMs/intervalMs. For a full analysis on failure use ci_diagnose.',
      parameters: {
        source: sourceParam,
        runId: runIdParam,
        repo: repoParam,
        workflow: triggerExtra.workflow,
        ref: triggerExtra.ref,
        inputs: triggerExtra.inputs,
        command: triggerExtra.command,
        template: triggerExtra.template,
        cwd: triggerExtra.cwd,
        timeoutMs: {
          type: 'integer',
          description: 'Max time (ms) to wait for the GitHub run (default from config).',
        },
        intervalMs: triggerExtra.intervalMs,
        includeLogsOnFailure: {
          type: 'boolean',
          description: 'Include the tail log when the run failed (default true).',
        },
      },
      output: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          runId: { type: 'string' },
          status: { type: 'string' },
          conclusion: { type: 'string' },
          state: { type: 'string' },
          repo: { type: 'string' },
          startedAt: { type: 'string' },
          completedAt: { type: 'string' },
          durationMs: { type: 'integer' },
          url: { type: 'string' },
          failedStage: { type: 'string' },
          workflow: { type: 'string' },
          ref: { type: 'string' },
          ok: { type: 'boolean' },
          exitCode: { type: 'integer' },
          killed: { type: 'boolean' },
          command: { type: 'string' },
          cwd: { type: 'string' },
          tailLog: { type: 'object' },
        },
        required: ['source', 'runId', 'state'],
        additionalProperties: false,
      },
      timeoutMs: cfg.github.pollTimeoutMs + cfg.local.timeoutMs + 15_000,
      execute: async (raw, exec) => {
        const args = readArgs(raw)
        const result = await service.watch({
          ...args,
          runId: normalizeRunId(args.runId),
          signal: exec.signal,
        })
        return jsonify({ ...result, runId: String(result.runId) })
      },
    }),

    defineCiTool({
      name: 'ci_diagnose',
      description: 'Full failure diagnosis: trigger (when no runId is given) or reuse a run, wait for completion, '
        + 'and on failure hand the masked tail of the log plus a heuristic error classification to the analysis '
        + 'provider (harness ctx.llm or the configured OpenAI-compatible endpoint) to produce a Markdown report '
        + 'covering failure stage, error classification, most likely root cause, suggested fix steps and related '
        + 'files. Set savePath to persist the report. Passing runs short-circuit without calling the model.',
      parameters: {
        source: sourceParam,
        runId: runIdParam,
        repo: repoParam,
        workflow: triggerExtra.workflow,
        ref: triggerExtra.ref,
        inputs: triggerExtra.inputs,
        command: triggerExtra.command,
        template: triggerExtra.template,
        cwd: triggerExtra.cwd,
        timeoutMs: {
          type: 'integer',
          description: 'Max time (ms) to wait for the GitHub run (default from config).',
        },
        intervalMs: triggerExtra.intervalMs,
        savePath: {
          type: 'string',
          description: 'Absolute path to write the Markdown report to (optional).',
        },
      },
      output: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          report: { type: 'string' },
          meta: { type: 'object' },
          classification: { type: 'object' },
          analysis: { type: 'object' },
          savedPath: { type: 'string' },
        },
        required: ['ok', 'report'],
        additionalProperties: false,
      },
      timeoutMs: cfg.github.pollTimeoutMs + cfg.diagnosis.timeoutMs + 15_000,
      execute: async (raw, exec) => {
        const args = readArgs(raw)
        const result = await service.diagnose({
          ...args,
          runId: normalizeRunId(args.runId),
          signal: exec.signal,
        })
        return jsonify({
          ok: result.ok,
          report: result.report,
          meta: result.meta,
          classification: result.classification,
          analysis: result.analysis,
          ...(result.savedPath ? { savedPath: result.savedPath } : {}),
        })
      },
    }),
  ]
}

/** Coerce integer-ish runId values to a string; keeps args objects honest. */
function normalizeRunId(value) {
  if (value === undefined || value === null) return undefined
  return String(value)
}

/** Validate the raw tool argument object (a flat object of primitive values). */
function readArgs(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('tool arguments must be an object')
  }
  return raw
}
