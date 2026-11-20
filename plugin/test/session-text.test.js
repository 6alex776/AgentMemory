import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findAssistantMessage, textOfMessage } from '../lib/session-text.js'

const assistant = (id, content) => ({
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { role: 'assistant', id, content } },
})

test('reads text out of the block array a real session stores', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'let me think about this' },
      { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{}' },
      { type: 'text', text: '第一段结论。' },
      { type: 'text', text: '第二段细节。' },
    ],
  }
  assert.equal(textOfMessage(message), '第一段结论。\n\n第二段细节。')
})

test('never leaks reasoning or tool calls into a saved memory', () => {
  const message = { content: [{ type: 'reasoning', text: 'internal' }, { type: 'tool-call', name: 'x' }] }
  assert.equal(textOfMessage(message), '')
})

test('accepts a plain string body and a blocks snapshot', () => {
  assert.equal(textOfMessage({ content: '  直接给正文。  ' }), '直接给正文。')
  assert.equal(textOfMessage({ blocks: [{ type: 'text', text: '来自 blocks。' }] }), '来自 blocks。')
})

test('tolerates junk instead of throwing', () => {
  assert.equal(textOfMessage(null), '')
  assert.equal(textOfMessage({}), '')
  assert.equal(textOfMessage({ content: [{ type: 'text', text: 42 }, null, 'x'] }), '')
})

test('finds an assistant message by id and lets the later one win', () => {
  const events = [
    assistant('a', [{ type: 'text', text: '旧' }]),
    { type: 'user/message', data: { message: { id: 'u' } } },
    assistant('b', [{ type: 'text', text: '新' }]),
    assistant('a', [{ type: 'text', text: '新' }]),
  ]
  assert.equal(textOfMessage(findAssistantMessage(events, 'b')), '新')
  assert.equal(textOfMessage(findAssistantMessage(events, 'a')), '新')
  assert.equal(findAssistantMessage(events, 'missing'), undefined)
  assert.equal(findAssistantMessage(events, ''), undefined)
  assert.equal(findAssistantMessage(undefined, 'a'), undefined)
})
