import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BoundedBuffer, tailChars, tailLines, stripAnsi, cleanLog, maskOccurrences,
} from '../src/logs.js'

test('BoundedBuffer keeps everything under the cap', () => {
  const buf = new BoundedBuffer(10)
  buf.push('abc')
  buf.push('def')
  assert.equal(buf.value, 'abcdef')
  assert.equal(buf.truncated, false)
})

test('BoundedBuffer keeps the trailing cap once exceeded', () => {
  const buf = new BoundedBuffer(8)
  buf.push('12345')
  buf.push('6789')
  assert.equal(buf.value, '23456789') // '123456789' capped to its last 8
  assert.equal(buf.truncated, true)
})

test('BoundedBuffer handles chunked pushes and tiny caps', () => {
  const buf = new BoundedBuffer(1)
  buf.push('xy')
  buf.push('z')
  assert.equal(buf.value, 'z')
  assert.equal(buf.truncated, true)
  buf.push('')
  assert.equal(buf.value, 'z')
})

test('BoundedBuffer rejects a bad cap', () => {
  assert.throws(() => new BoundedBuffer(0), TypeError)
})

test('tailChars passes short text through and keeps the tail of long text', () => {
  assert.deepEqual(tailChars('hello', 100), { text: 'hello', truncated: false })
  const out = tailChars('abcdef', 3)
  assert.deepEqual(out, { text: 'def', truncated: true })
})

test('tailLines respects maxLines and the character budget', () => {
  const text = ['a', 'b', 'c', 'd', 'e'].join('\n')
  assert.deepEqual(tailLines(text, 2), { text: 'd\ne', truncated: true })
  assert.deepEqual(tailLines(text, 10), { text, truncated: false })
  const capped = tailLines(text, 10, 2)
  assert.equal(capped.text, 'e')
  assert.equal(capped.truncated, true)
})

test('stripAnsi removes colour codes and GitHub log decorations', () => {
  // GitHub dims each log prefix; the timestamp itself is content and stays.
  assert.equal(stripAnsi('\u001b[2m2024-01-01T00:00:00.000Z\u001b[0m hello'), '2024-01-01T00:00:00.000Z hello')
  assert.equal(stripAnsi('\u001b[31mred\u001b[39m'), 'red')
})

test('cleanLog normalises CRLF and stray CR to LF', () => {
  assert.equal(cleanLog('a\r\nb\rc'), 'a\nb\nc')
})

test('BoundedBuffer handles multibyte characters by code units', () => {
  const buf = new BoundedBuffer(4)
  buf.push('你好世界你好世界') // 12 code units
  assert.equal(buf.value, '你好世界')
  assert.equal(buf.truncated, true)
})

test('maskOccurrences redacts secrets and ignores too-short ones', () => {
  assert.equal(maskOccurrences('token=abc123456 end', ['abc123456']), 'token=*** end')
  assert.equal(maskOccurrences('ab cd', ['ab']), 'ab cd') // shorter than minLength
  assert.equal(maskOccurrences('keep', ['nope']), 'keep')
  assert.equal(maskOccurrences(42, ['x']), '42')
})