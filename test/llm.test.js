import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  DEFAULT_LLM_BASE_URL, AnalysisError, OpenAiCompatibleClient,
  buildDiagnosisPrompt, extractCompletionText, extractSections, SYSTEM_PROMPT,
} from '../src/llm.js'

test('extractCompletionText handles string, block-array and legacy text shapes', () => {
  assert.equal(extractCompletionText({ choices: [{ message: { content: 'hi' } }] }), 'hi')
  assert.equal(
    extractCompletionText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }),
    'ab',
  )
  assert.equal(extractCompletionText({ choices: [{ text: 'legacy' }] }), 'legacy')
  assert.throws(() => extractCompletionText({}), AnalysisError)
  assert.throws(() => extractCompletionText({ choices: [{ message: { content: '' } }] }), AnalysisError)
})

test('extractSections parses canonical headings and falls back gracefully', () => {
  const md = '# CI Failure Report\n\n## Failure Stage\nbuild job\n\n## Error Classification\nTest failure\n\n'
    + '## Most Likely Root Cause\nflaky\n\n## Suggested Fix Steps\n- rerun\n\n## Related Files\nsrc/a.js\n'
  const s = extractSections(md)
  assert.equal(s.stage, 'build job')
  assert.equal(s.errorType, 'Test failure')
  assert.equal(s.rootCause, 'flaky')
  assert.equal(s.fixSteps, '- rerun')
  assert.equal(s.relatedFiles, 'src/a.js')

  const partial = extractSections('## Most Likely Root Cause\nnetwork issue')
  assert.equal(partial.rootCause, 'network issue')
  assert.equal(partial.fixSteps, null)

  const raw = extractSections('no headings at all, just a sentence')
  assert.equal(raw.rootCause, 'no headings at all, just a sentence')
})

test('extractSections ignores headings inside fenced code blocks', () => {
  const md = '# CI Failure Report\n\n## Most Likely Root Cause\nnetwork issue\n\n'
    + '## Failure Log Tail\n```text\n## Most Likely Root Cause\n(spoofed heading inside fence)\n```\n'
  const s = extractSections(md)
  assert.equal(s.rootCause, 'network issue', 'fenced heading must not override the real one')
})

test('extractSections tolerates heading depth and imperfect spacing', () => {
  const md = '###  Most Likely Root Cause   \nport is closed\n'
  const s = extractSections(md)
  assert.equal(s.rootCause, 'port is closed')
})

test('buildDiagnosisPrompt carries metadata, classification and the log tail', () => {
  const meta = {
    source: 'github', runId: 42, repo: 'acme/app', workflow: 'ci.yml', job: 'test',
    ref: 'main', failedStage: 'test', status: 'completed', conclusion: 'failure', exitCode: 1, url: 'https://x',
  }
  const prompt = buildDiagnosisPrompt(meta, { category: 'test', hints: ['test'] }, 'assertion failed here')
  assert.match(prompt, /# CI Failure Report/)
  assert.match(prompt, /## Failure Stage/)
  assert.match(prompt, /## Error Classification/)
  assert.match(prompt, /## Most Likely Root Cause/)
  assert.match(prompt, /## Suggested Fix Steps/)
  assert.match(prompt, /## Related Files/)
  assert.match(prompt, /run id: 42/)
  assert.match(prompt, /repository: acme\/app/)
  assert.match(prompt, /failed stage: test/)
  assert.match(prompt, /assertion failed here/)
  assert.match(prompt, /category: test/)
})

test('OpenAiCompatibleClient posts to /chat/completions and reads the answer', async () => {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'the diagnosis' } }],
      }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    const client = new OpenAiCompatibleClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' })
    const text = await client.complete({ prompt: 'analyze', system: SYSTEM_PROMPT, maxTokens: 100, temperature: 0.1 })
    assert.equal(text, 'the diagnosis')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/v1/chat/completions')
    assert.equal(requests[0].headers.authorization, 'Bearer sk-test')
    assert.equal(requests[0].body.model, 'deepseek-chat')
    assert.equal(requests[0].body.messages[0].role, 'system')
    assert.equal(requests[0].body.messages[1].content, 'analyze')
    assert.equal(requests[0].body.temperature, 0.1)
    assert.equal(requests[0].body.max_tokens, 100)
  } finally {
    server.close()
  }
})

test('OpenAiCompatibleClient maps HTTP errors to AnalysisError', async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 401
    res.end('{"error":{"message":"bad key"}}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: 'k',
    })
    await assert.rejects(() => client.complete({ prompt: 'x' }),
      (error) => error instanceof AnalysisError && error.code === 'HTTP_ERROR' && /401/.test(error.message))
  } finally {
    server.close()
  }
})

test('OpenAiCompatibleClient rejects a 200 response with an invalid JSON body', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end('this is not json')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new OpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: 'k',
    })
    await assert.rejects(() => client.complete({ prompt: 'x' }),
      (error) => error instanceof AnalysisError && error.code === 'BAD_RESPONSE')
  } finally {
    server.close()
  }
})

test('OpenAiCompatibleClient times out and honors abort', async () => {
  const server = http.createServer((_req, res) => {
    setTimeout(() => res.end('{}'), 5000) // never answers in time
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const slow = new OpenAiCompatibleClient({ baseUrl, apiKey: 'k', timeoutMs: 150 })
    await assert.rejects(() => slow.complete({ prompt: 'x' }),
      (error) => error instanceof AnalysisError && error.code === 'TIMEOUT')

    const abort = new AbortController()
    const pending = new OpenAiCompatibleClient({ baseUrl, apiKey: 'k', timeoutMs: 5000 })
      .complete({ prompt: 'x', signal: abort.signal })
    abort.abort()
    await assert.rejects(pending, (error) => error instanceof AnalysisError && error.code === 'ABORTED')
  } finally {
    server.close()
  }
})

test('default base URL targets DeepSeek', () => {
  assert.equal(DEFAULT_LLM_BASE_URL, 'https://api.deepseek.com/v1')
})