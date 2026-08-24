/**
 * Local command execution — runs templated test/CI pipelines through the
 * platform shell and captures the outcome.
 *
 * Runs via the shell so behaviour matches a developer terminal (PATH, aliases,
 * `.bat`/`.cmd` shims on Windows). Output is captured per stream into bounded
 * trailing buffers so runaway processes cannot blow up memory or the agent
 * context. Timeouts and cancellation kill the whole process TREE — with
 * `shell: true` the real command is a grandchild of the spawn, and killing
 * only the wrapper would leak an orphan that still holds the stdio pipes.
 */

import { spawn, spawnSync } from 'node:child_process'
import { BoundedBuffer } from './logs.js'

/** Outcome of one local command run. @typedef {object} LocalOutcome */
/**
 * @typedef {object} LocalOutcome
 * @property {boolean} ok true only for a clean exit code 0
 * @property {number} exitCode -1 when the process was killed before exiting
 * @property {boolean} killed true when a timeout or abort terminated the tree
 * @property {number} durationMs wall-clock run time
 * @property {string} stdout captured stdout (trailing, capped)
 * @property {string} stderr captured stderr (trailing, capped)
 * @property {boolean} stdoutTruncated true when stdout hit the cap
 * @property {boolean} stderrTruncated true when stderr hit the cap
 * @property {string} command the command line that was run
 * @property {string} cwd the working directory
 */

/** Create a Promise `run(command)` bound to fixed defaults. */
export class LocalRunner {
  /**
   * @param {object} [options]
   * @param {string} [options.cwd] working directory (defaults to process cwd)
   * @param {number} [options.timeoutMs] hard tree-kill budget
   * @param {number} [options.maxOutputChars] per-stream capture cap
   * @param {Record<string,string>} [options.env] extra environment for the child
   */
  constructor(options = {}) {
    this.options = options
  }

  /** Run `command` merging per-call options over the constructor defaults. */
  run(command, options = {}) {
    return runLocalCommand(command, { ...this.options, ...options })
  }
}

/**
 * Run one command line and capture its outcome.
 * @param {string} command full command line, run via the shell
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxOutputChars]
 * @param {Record<string,string>} [options.env]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<LocalOutcome>}
 */
export function runLocalCommand(command, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const timeoutMs = options.timeoutMs
    const cap = options.maxOutputChars ?? 40_000
    let settled = false
    let killed = false
    let timer = null
    let child = null

    const out = new BoundedBuffer(cap)
    const err = new BoundedBuffer(cap)

    // A blank command line would silently "pass" as an empty shell script on
    // POSIX (and fail differently on Windows) — reject it up front.
    if (typeof command !== 'string' || command.trim().length === 0) {
      resolve(toOutcome({
        exitCode: -1, stdout: '', stderr: 'empty command', killed: false,
        durationMs: 0, out, err, command, cwd: options.cwd,
      }))
      return
    }

    const killTree = () => {
      if (child === null) return
      if (process.platform === 'win32') {
        // /T terminates the whole tree (the shell and every grandchild).
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          })
        } catch {
          // taskkill missing; the direct kill below still fires
        }
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          // no process group or already gone
        }
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // already dead — fine
        }
      }
      try {
        child.kill('SIGKILL')
      } catch {
        // already dead — fine
      }
    }

    const onAbort = () => {
      killed = true
      killTree()
    }

    const settle = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }

    const capture = (stream, buffer) => {
      stream.on('data', (chunk) => buffer.push(chunk.toString()))
    }

    try {
      child = spawn(command, {
        cwd: options.cwd,
        shell: true,
        windowsHide: true,
        // On POSIX, detached gives the shell its own process group so the
        // whole tree can be signalled. On Windows it must stay off: detached
        // children receive no stdio there, and tree-killing already works via
        // taskkill /T instead.
        detached: process.platform !== 'win32',
        env: { ...process.env, ...(options.env ?? {}) },
      })
    } catch (error) {
      // Synchronous spawn failure (invalid options).
      settle(toOutcome({
        exitCode: -1, stdout: '', stderr: error.message, killed: false,
        durationMs: Date.now() - started, out, err, command, cwd: options.cwd,
      }))
      return
    }

    if (child.stdout) capture(child.stdout, out)
    if (child.stderr) capture(child.stderr, err)

    if (options.signal?.aborted) {
      onAbort()
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true })
    }
    // A timeout of undefined must not arm the timer: setTimeout(fn, undefined)
    // would fire after ~0ms and kill healthy commands instantly.
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        killed = true
        killTree()
      }, timeoutMs)
    }

    child.on('exit', (code, signal) => {
      // A tree-kill is a deliberate terminal outcome: settle immediately
      // instead of waiting for the stdio pipes (grandchildren may hold them).
      if (killed) {
        settle(toOutcome({
          exitCode: -1, stdout: out.value, stderr: err.value, killed: true,
          durationMs: Date.now() - started, stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated, command, cwd: options.cwd,
        }))
      }
    })
    child.on('close', (code) => {
      // Normal path: exit plus closed stdio means output capture is complete.
      if (killed) return // already settled on 'exit'
      settle(toOutcome({
        exitCode: code === null ? -1 : code, stdout: out.value, stderr: err.value,
        killed: false, durationMs: Date.now() - started, stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated, command, cwd: options.cwd,
      }))
    })
    child.on('error', (error) => {
      // Asynchronous spawn failure (missing shell, invalid cwd on exec).
      settle(toOutcome({
        exitCode: -1, stdout: out.value, stderr: error.message, killed: false,
        durationMs: Date.now() - started, stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated, command, cwd: options.cwd,
      }))
    })
  })
}

/** Wrap raw run data into a {@link LocalOutcome}. */
function toOutcome(data) {
  return {
    ok: data.exitCode === 0,
    exitCode: data.exitCode,
    killed: data.killed,
    durationMs: data.durationMs,
    stdout: data.stdout,
    stderr: data.stderr,
    stdoutTruncated: Boolean(data.stdoutTruncated),
    stderrTruncated: Boolean(data.stderrTruncated),
    command: data.command,
    cwd: data.cwd ?? process.cwd(),
  }
}
