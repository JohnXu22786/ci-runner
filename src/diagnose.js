/**
 * Diagnosis report assembly — harness-free.
 *
 * Turns the pieces of a failed run (metadata, heuristic classification, log
 * tail, and optionally a model's analysis) into one structured report object
 * and its Markdown rendering. The report always carries the canonical
 * sections — Failure Stage, Error Classification, Most Likely Root Cause,
 * Suggested Fix Steps, Related Files — so it is useful even when no model
 * endpoint is configured.
 */

import { categoryLabel } from './classify.js'
import { extractSections } from './llm.js'

/** Build a compact, serializable run-metadata object. */
export function buildRunMeta(input = {}) {
  const now = new Date().toISOString()
  return {
    source: input.source ?? 'unknown',
    runId: input.runId ?? null,
    repo: input.repo ?? '',
    workflow: input.workflow ?? '',
    job: input.job ?? '',
    ref: input.ref ?? '',
    status: input.status ?? '',
    conclusion: input.conclusion ?? '',
    failedStage: input.failedStage ?? '',
    startedAt: input.startedAt ?? '',
    completedAt: input.completedAt ?? now,
    durationMs: Number.isFinite(input.durationMs) ? input.durationMs : null,
    exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null,
    url: input.url ?? '',
  }
}

/**
 * Assemble the report object.
 * @param {object} input
 * @param {object} input.meta buildRunMeta() output
 * @param {{text: string, truncated: boolean}} input.logTail cleaned, masked tail
 * @param {object} input.classification classifyFailure() output
 * @param {string} [input.analysis] raw model markdown ('' when unavailable)
 * @param {string} [input.analysisSource] label of the analysis provider
 * @param {string} [input.analysisError] message when the analysis call failed
 * @param {boolean} [input.success] true when the run passed (no diagnosis needed)
 * @returns {object} report
 */
export function assembleReport(input = {}) {
  const meta = input.meta
  const success = Boolean(input.success)

  const sections = extractSections(input.analysis ?? '')

  const report = {
    ok: success,
    success,
    meta,
    logTail: {
      text: input.logTail?.text ?? '',
      truncated: Boolean(input.logTail?.truncated),
      chars: (input.logTail?.text ?? '').length,
    },
    classification: {
      category: input.classification?.category ?? 'unknown',
      label: categoryLabel(input.classification?.category ?? 'unknown'),
      hints: input.classification?.hints ?? [],
      exitCode: input.classification?.exitCode ?? null,
      killed: Boolean(input.classification?.killed),
    },
    analysis: {
      source: input.analysisSource ?? 'none',
      error: input.analysisError ?? '',
      sections,
    },
  }

  report.report = success ? renderSuccess(meta) : renderFailure(report, meta)
  return report
}

/** First ~2 KB of a provider-label note for the "no model" fallback. */
const NO_ANALYSIS_NOTE
  = 'No model analysis is available. Configure `diagnosis.llm` (OpenAI-compatible endpoint) '
  + 'or enable the harness `ctx.llm` service to get a generated root-cause analysis.'

/** Deterministic two-liner for a run that passed. */
function renderSuccess(meta) {
  const head = `# CI Report — ${meta.repo || meta.source} run ${meta.runId}`
  return [
    head,
    '',
    `**Status:** passed${meta.conclusion ? ` (${meta.conclusion})` : ''} · `
      + `source ${meta.source}${meta.workflow ? ` · workflow ${meta.workflow}` : ''}`
      + `${meta.durationMs !== null ? ` · ${Math.round(meta.durationMs)} ms` : ''}`,
    '',
    'No failure to diagnose.',
  ].join('\n')
}

/** Full failure report with the five canonical sections. */
function renderFailure(report, meta) {
  const lines = []
  lines.push('# CI Failure Report')
  lines.push('')
  const bits = [
    `source: ${meta.source}`,
    `run: ${meta.runId}`,
  ]
  if (meta.repo) bits.push(`repo: ${meta.repo}`)
  if (meta.workflow) bits.push(`workflow: ${meta.workflow}`)
  if (meta.job) bits.push(`job: ${meta.job}`)
  if (meta.ref) bits.push(`ref: ${meta.ref}`)
  lines.push(`**Run:** ${bits.join(' · ')}`)
  lines.push(`**Status:** ${meta.status}${meta.conclusion ? ` / ${meta.conclusion}` : ''}`
    + (meta.exitCode !== null ? ` · exit ${meta.exitCode}` : ''))
  lines.push('')

  lines.push('## Failure Stage')
  lines.push('')
  lines.push(mdOrFallback(
    report.analysis.sections.stage,
    meta.failedStage || 'Unknown — no stage metadata was captured.',
  ))
  lines.push('')

  lines.push('## Error Classification')
  lines.push('')
  lines.push(mdOrFallback(
    report.analysis.sections.errorType,
    `**${report.classification.label}**`
      + (report.classification.hints.length > 0
        ? ` (matched: ${report.classification.hints.join(', ')})`
        : ''),
  ))
  lines.push('')

  lines.push('## Most Likely Root Cause')
  lines.push('')
  if (report.analysis.error) {
    lines.push(`> Analysis provider failed: ${report.analysis.error}`)
  } else if (report.analysis.sections.rootCause) {
    lines.push(report.analysis.sections.rootCause)
  } else {
    lines.push(`_${NO_ANALYSIS_NOTE}_`)
  }
  lines.push('')

  lines.push('## Suggested Fix Steps')
  lines.push('')
  if (report.analysis.sections.fixSteps) {
    lines.push(report.analysis.sections.fixSteps)
  } else if (report.analysis.error) {
    lines.push('_No fix steps (analysis failed)._')
  } else {
    lines.push(`_${NO_ANALYSIS_NOTE}_`)
  }
  lines.push('')

  lines.push('## Related Files')
  lines.push('')
  if (report.analysis.sections.relatedFiles) {
    lines.push(report.analysis.sections.relatedFiles)
  } else if (report.analysis.error) {
    lines.push('_None identifiable (analysis failed)._')
  } else {
    lines.push(`_${NO_ANALYSIS_NOTE}_`)
  }
  lines.push('')

  if (meta.completedAt || meta.startedAt) {
    lines.push('## Timeline')
    lines.push('')
    if (meta.startedAt) lines.push(`- started: ${meta.startedAt}`)
    if (meta.completedAt) lines.push(`- completed: ${meta.completedAt}`)
    if (meta.durationMs !== null) lines.push(`- duration: ${Math.round(meta.durationMs)} ms`)
    lines.push('')
  }

  lines.push('## Failure Log Tail')
  lines.push('')
  const tail = report.logTail.text
  if (tail) {
    lines.push('```text')
    lines.push(abbreviate(fenceSafe(tail), 6000))
    lines.push('```')
  } else {
    lines.push('_(no log captured)_')
  }
  if (report.logTail.truncated) {
    lines.push('')
    lines.push(`> Log was truncated to its final ${report.logTail.chars} characters.`)
  }

  return lines.join('\n')
}

/** Use `text` if non-empty, else `fallback`; used for model or deterministic content. */
function mdOrFallback(text, fallback) {
  return text && text.length > 0 ? text : fallback
}

/** Hard cap for the inline log tail so the report stays lean. */
function abbreviate(text, maxChars) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

/**
 * Keep an untrusted log from closing the ```text fence of the report: a log
 * line consisting of three or more backticks (optionally indented up to three
 * spaces) would terminate the fence and let the rest of the log render as
 * Markdown. Indenting such lines with four spaces keeps them literal inside
 * the fence (a closing fence cannot be indented four spaces).
 */
function fenceSafe(text) {
  return String(text ?? '').split('\n')
    .map((line) => (/^[ ]{0,3}`{3,}\s*$/.test(line) ? `    ${line}` : line))
    .join('\n')
}

