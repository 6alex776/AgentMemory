import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  IDENTITY_HEADER,
  PROJECT_HEADER,
  renderIdentityBlock,
  renderLines,
  renderProjectBlock,
  selectIdentityRows,
  selectProjectRows,
} from '../lib/block.js'

const row = (patch) => ({
  id: 'm_000000000000',
  scope: 'global',
  kind: 'profile',
  project_id: null,
  importance: 3,
  content: '内容',
  abstract: '摘要',
  ...patch,
})

test('the identity block only carries global profile and preference', () => {
  const rows = [
    row({ id: 'm_profile', kind: 'profile' }),
    row({ id: 'm_pref', kind: 'preference' }),
    row({ id: 'm_fact', kind: 'fact' }),
    row({ id: 'm_lesson', kind: 'lesson' }),
    row({ id: 'm_project_profile', kind: 'profile', scope: 'project', project_id: 'p1' }),
  ]
  assert.deepEqual(selectIdentityRows(rows).map((item) => item.id), ['m_profile', 'm_pref'])
})

test('the project block takes this project fact/decision/lesson above the threshold', () => {
  const rows = [
    row({ id: 'm_decision', kind: 'decision', scope: 'project', project_id: 'p1', importance: 3 }),
    row({ id: 'm_fact', kind: 'fact', scope: 'project', project_id: 'p1', importance: 4 }),
    row({ id: 'm_lesson', kind: 'lesson', scope: 'project', project_id: 'p1', importance: 5 }),
    row({ id: 'm_low', kind: 'decision', scope: 'project', project_id: 'p1', importance: 2 }),
    row({ id: 'm_preference', kind: 'preference', scope: 'project', project_id: 'p1', importance: 5 }),
    row({ id: 'm_other', kind: 'decision', scope: 'project', project_id: 'p2', importance: 5 }),
    row({ id: 'm_global', kind: 'decision', scope: 'global', importance: 5 }),
  ]
  assert.deepEqual(
    selectProjectRows(rows, 'p1').map((item) => item.id),
    ['m_decision', 'm_fact', 'm_lesson'],
  )
  assert.deepEqual(selectProjectRows(rows, 'p1', 5).map((item) => item.id), ['m_lesson'])
  assert.deepEqual(selectProjectRows(rows, undefined), [])
})

test('lines are ordered by kind then id and carry id plus abstract', () => {
  const block = renderLines([
    row({ id: 'm_b', kind: 'preference', abstract: '偏好直接' }),
    row({ id: 'm_a', kind: 'profile', abstract: '计算机专业' }),
  ], { header: 'H' })
  const lines = block.text.split('\n')
  assert.equal(lines[0], 'H')
  assert.deepEqual(lines.slice(1), [
    '- [m_a][用户背景] 计算机专业',
    '- [m_b][偏好] 偏好直接',
  ])
  assert.deepEqual(block.ids, ['m_a', 'm_b'])
  assert.equal(block.stats.entries, 2)
  assert.equal(block.stats.omitted, 0)
  assert.ok(block.stats.chars > block.stats.entries)
})

test('a tight budget drops the tail and says how many rows were left out', () => {
  const rows = [
    row({ id: 'm_a', abstract: '第一'.repeat(20) }),
    row({ id: 'm_b', abstract: '第二'.repeat(20) }),
  ]
  const block = renderLines(rows, { header: 'H', maxChars: 90 })
  assert.deepEqual(block.ids, ['m_a'])
  assert.equal(block.stats.omitted, 1)
  assert.match(block.text, /（还有 1 条未展开；需要时用 memory_search 检索）$/)
})

test('the id prefix can be turned off without touching the rest', () => {
  const block = renderLines([row({ id: 'm_a', abstract: '只看摘要' })], {
    header: 'H',
    includeIds: false,
  })
  assert.equal(block.text.split('\n')[1], '- [用户背景] 只看摘要')
})

test('an empty selection renders nothing at all', () => {
  const block = renderIdentityBlock([])
  assert.equal(block.text, '')
  assert.deepEqual(block.ids, [])
  assert.equal(block.stats.entries, 0)
})

test('the two blocks use different headers', () => {
  assert.equal(renderIdentityBlock([row({})]).text.split('\n')[0], IDENTITY_HEADER)
  assert.equal(renderProjectBlock([row({ kind: 'decision' })]).text.split('\n')[0], PROJECT_HEADER)
})
