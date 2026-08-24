/**
 * Log handling primitives — bounded capture, tailing, ANSI cleanup and secret
 * masking.
 *
 * CI output can be unbounded, so every place that touches logs routes them
 * through {@link BoundedBuffer} (while a process runs) or {@link tailChars}
 * (on GitHub log bodies) to keep the amount of text bounded and avoid
 * blowing up the agent context. Any configured credential is masked out of
 * log text before it is returned or sent to a model (see
 * {@link maskOccurrences}).
 */

/**
 * A string buffer that keeps only the most recent `cap` characters. Oldest
 * content is dropped once the cap is exceeded, so a runaway process cannot
 * grow memory without bound while trailing output is still captured.
 */
export class BoundedBuffer {
  constructor(cap) {
    if (!Number.isInteger(cap) || cap < 1) {
      throw new TypeError('BoundedBuffer cap must be a positive integer')
    }
    this.cap = cap
    this.buf = ''
    this.overrun = false
  }

  push(text) {
    if (text === undefined || text === null) return
    const piece = String(text)
    if (piece.length === 0) return
    const total = this.buf.length + piece.length
    if (total <= this.cap) {
      this.buf += piece
      return
    }
    this.overrun = true
    this.buf += piece
    this.buf = this.buf.slice(this.buf.length - this.cap)
  }

  get value() {
    return this.buf
  }

  get truncated() {
    return this.overrun
  }
}

/** Return the final `maxChars` characters of `text` and whether it was cut. */
export function tailChars(text, maxChars) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (value.length <= maxChars) return { text: value, truncated: false }
  return { text: value.slice(-maxChars), truncated: true }
}

/** Return the final `maxLines` lines of `text`, optionally capped by chars. */
export function tailLines(text, maxLines, maxChars = Number.POSITIVE_INFINITY) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const lines = value.split(/\r?\n/)
  let kept = lines.slice(-maxLines)
  let lineTruncated = lines.length > maxLines
  while (kept.join('\n').length > maxChars && kept.length > 1) {
    lineTruncated = true
    kept = kept.slice(1)
  }
  return {
    text: kept.join('\n'),
    truncated: lineTruncated || kept.join('\n').length < value.length,
  }
}

/** Replace ANSI escape sequences (including GitHub Actions timestamps). */
export function stripAnsi(text) {
  // Standard terminal escape matcher: CSI sequences (\x1b[...final) and OSC
  // sequences (\x1b]...ST) — covers colour codes, cursor moves, and the
  // "\u001b[2m2024-…Z\u001b[0m" prefixes GitHub Actions logs are decorated with.
  return String(text ?? '').replace(
    // eslint-disable-next-line no-control-regex -- the escapes are the point
    /[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g,
    '',
  )
}

/** Normalise CRLF and stray CR to LF so line-based tailing is predictable. */
export function normalizeLineEndings(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** Strip ANSI codes and normalise line endings in one pass. */
export function cleanLog(text) {
  return normalizeLineEndings(stripAnsi(text))
}

/**
 * Replace every occurrence of each secret with the mask string. Secrets that
 * are empty or shorter than `minLength` chars are ignored (a one-char token
 * would nuke half the log).
 */
export function maskOccurrences(text, secrets, mask = '***', minLength = 4) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < minLength) continue
    out = out.split(secret).join(mask)
  }
  return out
}
