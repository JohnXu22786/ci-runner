/**
 * Command-line interface — lets developers trigger CI, read logs, watch runs
 * and run failure diagnosis without an agent harness.
 *
 *   ci-runner trigger  [--source github|local] [--repo owner/repo] [--workflow F]
 *                      [--ref R] [--inputs k=v ...] [--command CMD] [--template T]
 *                      [--cwd DIR]
 *   ci-runner status   [--source s] --run ID [--repo r]
 *   ci-runner logs     [--source s] --run ID [--job J] [--tail N] [--repo r]
 *   ci-runner watch    [--source s] [--run ID | trigger flags] [--timeout-ms N]
 *                      [--interval-ms N] [--no-logs] [--json]
 *   ci-runner diagnose [--source s] [--run ID | trigger flags] [--save PATH]
 *                      [--llm-base-url URL] [--llm-model M] [--llm-api-key K]
 *   ci-runner --help | --version
 *
 * Global option: --config PATH (JSON config file).
 */

import fs from 'node:fs'
import { normalizeConfig } from './config.js'
import { CiService } from './service.js'

const USAGE = `ci-runner — trigger CI and diagnose failures

Usage:
  ci-runner trigger  [--source github|local] [--repo owner/repo] [--workflow F]
                     [--ref R] [--inputs k=v ...] [--command CMD] [--template T]
                     [--cwd DIR]
  ci-runner status   [--source s] --run ID [--repo r]
  ci-runner logs     [--source s] --run ID [--job J] [--tail N] [--repo r]
  ci-runner watch    [--source s] [--run ID | trigger flags] [--timeout-ms N]
                     [--interval-ms N] [--no-logs] [--json]
  ci-runner diagnose [--source s] [--run ID | trigger flags] [--save PATH]
                     [--llm-base-url URL] [--llm-model M] [--llm-api-key K]
  ci-runner --help | --version

Global:
  --config PATH      JSON config file merged over the defaults.
  --json             Machine-readable output for status/watch/logs.
  --help, -h         Show this help.
  --version, -v      Show the version.

Examples:
  ci-runner trigger --workflow ci.yml --repo owner/repo --ref main
  ci-runner trigger --source local --template "npm test" --cwd .
  ci-runner watch --run 123456789 --repo owner/repo --timeout-ms 300000
  ci-runner diagnose --source local --command "pytest"
  ci-runner diagnose --run 123456789 --llm-base-url https://api.deepseek.com/v1`

/** Known flags and whether they take a value. Inputs is repeatable. */
const FLAG_DEFS = new Map([
  ['source', { value: true }],
  ['repo', { value: true }],
  ['workflow', { value: true }],
  ['ref', { value: true }],
  ['command', { value: true }],
  ['template', { value: true }],
  ['cwd', { value: true }],
  ['run', { value: true }],
  ['job', { value: true }],
  ['tail', { value: true }],
  ['timeout-ms', { value: true }],
  ['interval-ms', { value: true }],
  ['save', { value: true }],
  ['llm-base-url', { value: true }],
  ['llm-model', { value: true }],
  ['llm-api-key', { value: true }],
  ['config', { value: true }],
  ['inputs', { value: true, repeatable: true }],
  ['no-logs', { value: false }],
  ['json', { value: false }],
])

/** Parse argv (already past the command word) into a flat flag record. */
export function parseFlags(argv) {
  const flags = {}
  const list = [...argv]
  while (list.length > 0) {
    const token = list.shift()
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument "${token}" (flags only)`)
    }
    const eq = token.indexOf('=')
    const key = eq === -1 ? token.slice(2) : token.slice(2, eq)
    const inline = eq === -1 ? undefined : token.slice(eq + 1)
    const def = FLAG_DEFS.get(key)
    if (!def) throw new Error(`unknown flag --${key}`)
    if (!def.value) {
      if (inline !== undefined) throw new Error(`flag --${key} takes no value`)
      flags[key] = true
      continue
    }
    const value = inline ?? list.shift()
    if (value === undefined) throw new Error(`flag --${key} needs a value`)
    if (def.repeatable) {
      flags[key] ??= []
      flags[key].push(value)
    } else {
      flags[key] = value
    }
  }
  return flags
}

/** Convert `k=v` pairs from --inputs into an object. */
function parseInputs(pairs) {
  const inputs = {}
  for (const pair of pairs ?? []) {
    const idx = pair.indexOf('=')
    if (idx <= 0) throw new Error(`invalid --inputs "${pair}" — expected key=value`)
    inputs[pair.slice(0, idx)] = pair.slice(idx + 1)
  }
  return inputs
}

/** Load and validate the config file when --config is present. */
function resolveConfig(flags) {
  if (!flags.config) return normalizeConfig({})
  if (!fs.existsSync(flags.config)) {
    throw new Error(`config file not found: ${flags.config}`)
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(flags.config, 'utf8'))
  } catch (error) {
    throw new Error(`invalid config file ${flags.config}: ${error.message}`)
  }
  return normalizeConfig(raw)
}

/** Apply CLI diagnosis flags on top of the file/default config. */
function foldDiagFlags(cfg, flags) {
  if (!flags['llm-base-url']) return cfg
  const model = flags['llm-model']?.trim() || 'deepseek-chat'
  const apiKey = flags['llm-api-key'] ?? ''
  cfg.diagnosis.llm = { baseUrl: flags['llm-base-url'], apiKey, model }
  return cfg
}

function toInt(value, label) {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`)
  return n
}

/** Common flags shared by watch/diagnose (trigger-or-existing runs). */
function sharedRunArgs(flags) {
  const inputs = parseInputs(flags.inputs)
  const args = { source: flags.source }
  if (flags.run) args.runId = flags.run
  if (flags.repo) args.repo = flags.repo
  if (flags.workflow) args.workflow = flags.workflow
  if (flags.ref) args.ref = flags.ref
  if (Object.keys(inputs).length > 0) args.inputs = inputs
  if (flags.command || flags.template) args.command = flags.template ?? flags.command
  if (flags.cwd) args.cwd = flags.cwd
  const timeout = toInt(flags['timeout-ms'], '--timeout-ms')
  if (timeout) args.timeoutMs = timeout
  const interval = toInt(flags['interval-ms'], '--interval-ms')
  if (interval) args.intervalMs = interval
  return args
}

/** CLI entry point. @param {string[]} argv @param {object} [io] @returns {Promise<number>} */
export async function main(argv, io = console) {
  try {
    if (argv.length === 0) {
      io.log(USAGE)
      return 0
    }
    const [command, ...rest] = argv
    if (command === '--help' || command === '-h') {
      io.log(USAGE)
      return 0
    }
    if (command === '--version' || command === '-v') {
      io.log(readVersion())
      return 0
    }
    const flags = parseFlags(rest)
    const cfg = foldDiagFlags(resolveConfig(flags), flags)
    const service = new CiService(cfg)

    switch (command) {
      case 'trigger': return await runTrigger(service, flags, io)
      case 'status': return await runStatus(service, flags, io)
      case 'logs': return await runLogs(service, flags, io)
      case 'watch': return await runWatch(service, flags, io)
      case 'diagnose': return await runDiagnose(service, flags, io)
      default: throw new Error(`unknown command "${command}"`)
    }
  } catch (error) {
    io.error(`error: ${error.message}`)
    io.error('')
    io.error(USAGE)
    return 1
  }
}

async function runTrigger(service, flags, io) {
  const args = {
    source: flags.source,
    repo: flags.repo,
    workflow: flags.workflow,
    ref: flags.ref,
    inputs: parseInputs(flags.inputs),
    command: flags.template ?? flags.command,
    cwd: flags.cwd,
  }
  const timeout = toInt(flags['timeout-ms'], '--timeout-ms')
  if (timeout) args.timeoutMs = timeout
  const result = await service.trigger(args)
  if (flags.json) {
    io.log(JSON.stringify(result, null, 2))
  } else {
    io.log(`triggered ${result.source} run ${result.runId} (${result.status})`
      + (result.command ? ` — ${result.command}` : '')
      + (result.workflow ? ` — workflow ${result.workflow}` : ''))
    if (result.ok === false) io.log(`=> failed (exit ${result.exitCode}${result.killed ? ', killed' : ''})`)
    else if (result.ok === true) io.log('=> passed')
  }
  return 0
}

async function runStatus(service, flags, io) {
  if (!flags.run) throw new Error('--run is required for status')
  const result = await service.status({
    source: flags.source,
    runId: flags.run,
    repo: flags.repo,
  })
  if (flags.json) {
    io.log(JSON.stringify(result, null, 2))
    return 0
  }
  io.log(`run ${result.runId} [${result.source}] — status ${result.status}`
    + (result.conclusion ? ` / ${result.conclusion}` : ''))
  if (result.failedStage) io.log(`failed stage: ${result.failedStage}`)
  if (result.url) io.log(`url: ${result.url}`)
  for (const job of result.jobs ?? []) {
    io.log(`  job ${job.id} ${job.name} — ${job.status}${job.conclusion ? ` / ${job.conclusion}` : ''}`)
  }
  return 0
}

async function runLogs(service, flags, io) {
  if (!flags.run) throw new Error('--run is required for logs')
  const tail = toInt(flags.tail, '--tail')
  const result = await service.logs({
    source: flags.source,
    runId: flags.run,
    repo: flags.repo,
    job: flags.job,
    tailChars: tail,
  })
  if (flags.json) {
    io.log(JSON.stringify(result, null, 2))
    return 0
  }
  io.log(`logs for run ${result.runId} [${result.source}]${result.truncated ? ' (truncated)' : ''}:`)
  io.log('')
  io.log(result.text || '(no output)')
  return 0
}

async function runWatch(service, flags, io) {
  const result = await service.watch({
    ...sharedRunArgs(flags),
    includeLogsOnFailure: flags['no-logs'] ? false : true,
  })
  if (flags.json) {
    io.log(JSON.stringify(result, null, 2))
    return 0
  }
  io.log(`run ${result.runId} [${result.source}] finished — ${result.state}`
    + (result.conclusion ? ` / ${result.conclusion}` : ''))
  if (result.failedStage) io.log(`failed stage: ${result.failedStage}`)
  if (result.durationMs) io.log(`duration: ${Math.round(result.durationMs)} ms`)
  if (result.url) io.log(`url: ${result.url}`)
  if (result.tailLog) {
    io.log('')
    io.log('--- tail log ---')
    io.log(result.tailLog.text)
  }
  return 0
}

async function runDiagnose(service, flags, io) {
  const result = await service.diagnose({
    ...sharedRunArgs(flags),
    savePath: flags.save,
  })
  if (flags.json) {
    io.log(JSON.stringify(result, null, 2))
    return 0
  }
  io.log(result.report)
  if (result.analysis?.error) {
    io.log('')
    io.log(`note: analysis provider reported: ${result.analysis.error}`)
  }
  return 0
}

/** Read the package version for --version output. */
function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return `ci-runner ${pkg.version}`
}

