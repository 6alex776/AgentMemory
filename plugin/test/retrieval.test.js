import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderRetrievalBlock } from '../lib/retrieval.js'

const rows = [
  { id: 'm_1', kind: 'decision', content: '存储选型为 SQLite + FTS5', abstract: '存储选型为 SQLite + FTS5' },
  { id: 'm_2', kind: 'fact', content: '实时链路用 Kafka 和 Flink' },
  { id: 'm_3', kind: 'preference', content: '偏好简洁回答' },
]

test('renders matching rows under a fixed header', () => {
  const block = renderRetrievalBlock(rows, {})
  assert.ok(block.text.startsWith('【相关记忆】'))
  assert.equal(block.ids.length, 3)
  assert.ok(block.text.includes('SQLite'))
})

test('never repeats a memory already in the core block', () => {
  const block = renderRetrievalBlock(rows, { coreIds: ['m_1'] })
  assert.deepEqual(block.ids, ['m_2', 'm_3'])
})

test('drops rows that are near-verbatim to the core text', () => {
  const block = renderRetrievalBlock(rows, {
    coreText: '存储选型为 SQLite + FTS5',
  })
  assert.ok(!block.ids.includes('m_1'))
})

test('respects the character budget instead of overflowing', () => {
  const block = renderRetrievalBlock(rows, { maxChars: 60 })
  assert.ok(block.text.length <= 240)
  assert.ok(block.chars <= 60)
  assert.ok(block.ids.length < 3)
})

test('returns an empty block when nothing survives', () => {
  assert.deepEqual(renderRetrievalBlock([], {}), { text: '', ids: [], chars: 0 })
  assert.equal(renderRetrievalBlock(rows, { coreIds: ['m_1', 'm_2', 'm_3'] }).text, '')
})

test('prefers the stored abstract over the full text', () => {
  const block = renderRetrievalBlock([
    { id: 'm_9', kind: 'fact', content: '这是一条非常长的完整记忆正文', abstract: '短摘要' },
  ], {})
  assert.ok(block.text.includes('短摘要'))
  assert.ok(!block.text.includes('非常长的完整记忆正文'))
})
