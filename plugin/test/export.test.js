import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderMarkdown } from '../lib/export.js'

const state = {
  counts: { total: 2, global: 1, project: 1 },
  groups: [
    {
      title: '用户背景',
      items: [{ content: '用户是计算机专业本科生', kind: 'profile', importance: 5, pinned: 1, topic_key: null }],
    },
    {
      title: '项目：AgentMemory',
      items: [{ content: '存储选型为 SQLite + FTS5', kind: 'decision', importance: 5, pinned: 0, topic_key: 'storage' }],
    },
  ],
  superseded: [{ content: '旧职业方向：Java 后端', status: 'superseded' }],
}

test('renders a readable Markdown document with sections and metadata', () => {
  const md = renderMarkdown(state, new Date('2026-11-19T15:00:00Z'))
  assert.ok(md.startsWith('# AgentMemory 记忆导出'))
  assert.ok(md.includes('## 用户背景'))
  assert.ok(md.includes('- 用户是计算机专业本科生'))
  assert.ok(md.includes('已固定'))
  assert.ok(md.includes('槽位 storage'))
  assert.ok(md.includes('## 已失效 / 已删除'))
  assert.ok(md.includes('已被新值替换'))
  assert.ok(md.includes('2026-11-19T15:00:00'))
})

test('never emits JSON or tables', () => {
  const md = renderMarkdown(state)
  assert.ok(!md.trim().startsWith('{'))
  assert.ok(!md.includes('|'))
})

test('an empty store still produces a valid document', () => {
  const md = renderMarkdown({ counts: { total: 0, global: 0, project: 0 }, groups: [], superseded: [] })
  assert.ok(md.includes('# AgentMemory 记忆导出'))
  assert.ok(md.includes('生效记忆：0 条'))
})
