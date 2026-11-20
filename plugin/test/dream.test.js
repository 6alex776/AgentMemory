import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildMergeProposals, clusterIds, sameFact, shouldAutoDream } from '../lib/dream.js'

const byId = new Map([
  ['m_1', { id: 'm_1', content: '毕业设计是金融湖仓一体的分析看板', kind: 'fact', importance: 4 }],
  ['m_2', { id: 'm_2', content: '毕业设计做的是金融湖仓一体分析看板，含实时与离线', kind: 'fact', importance: 3 }],
  ['m_3', { id: 'm_3', content: '用户偏好简洁回答', kind: 'preference', importance: 4 }],
  ['m_4', { id: 'm_4', content: '职业方向转向大数据平台', kind: 'profile', importance: 5 }],
])

test('clusterIds groups near-duplicates and leaves distinct text alone', () => {
  const clusters = clusterIds(['m_1', 'm_2', 'm_3', 'm_4'], new Map(byId), 0.5)
  const sizes = clusters.map((cluster) => cluster.length).sort()
  assert.deepEqual(sizes, [1, 1, 2])
})

test('buildMergeProposals keeps the longest member as the merged text', () => {
  const proposals = buildMergeProposals(
    [{ topic: '毕设', ids: ['m_1', 'm_2'] }],
    new Map(byId),
    { threshold: 0.5 },
  )
  assert.equal(proposals.length, 1)
  assert.deepEqual(proposals[0].ids.sort(), ['m_1', 'm_2'])
  assert.ok(proposals[0].content.includes('实时与离线'))
  assert.equal(proposals[0].importance, 4)
})

test('sameFact accepts a longer restatement of the same fact', () => {
  const short = '毕业设计是金融湖仓一体分析看板'
  const long = '毕业设计是金融湖仓一体分析看板，含实时和离线两条链路，覆盖行情与报表'
  assert.equal(sameFact(short, long, 0.55), true)
})

test('sameFact still separates different facts', () => {
  assert.equal(sameFact('用户偏好简洁回答', '职业方向转向大数据平台', 0.55), false)
})

test('clusterIds groups a restatement with extra detail', () => {
  const rows = new Map([
    ['x1', { id: 'x1', content: '毕业设计是金融湖仓一体分析看板', kind: 'fact', importance: 3 }],
    ['x2', { id: 'x2', content: '毕业设计是金融湖仓一体分析看板，含实时和离线两条链路，覆盖行情与报表', kind: 'fact', importance: 3 }],
  ])
  const clusters = clusterIds(['x1', 'x2'], rows, 0.55)
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].length, 2)
})

test('a group of one produces nothing', () => {
  assert.deepEqual(buildMergeProposals([{ topic: 'x', ids: ['m_3'] }], new Map(byId), {}), [])
})

test('unrelated ids in one group are not merged', () => {
  const proposals = buildMergeProposals([{ topic: '混装', ids: ['m_3', 'm_4'] }], new Map(byId), { threshold: 0.6 })
  assert.deepEqual(proposals, [])
})

test('unknown ids are ignored and duplicate groups are collapsed', () => {
  const proposals = buildMergeProposals(
    [
      { topic: 'a', ids: ['m_1', 'm_2', 'm_missing'] },
      { topic: 'b', ids: ['m_2', 'm_1'] },
    ],
    new Map(byId),
    { threshold: 0.5 },
  )
  assert.equal(proposals.length, 1)
})

test('the proposal cap is respected', () => {
  const wide = new Map([
    ['a1', { id: 'a1', content: '同一句话重复一遍甲', kind: 'fact', importance: 3 }],
    ['a2', { id: 'a2', content: '同一句话重复一遍乙', kind: 'fact', importance: 3 }],
    ['b1', { id: 'b1', content: '完全不同主题的一句话丙', kind: 'fact', importance: 3 }],
    ['b2', { id: 'b2', content: '完全不同主题的一句话丁', kind: 'fact', importance: 3 }],
  ])
  const proposals = buildMergeProposals(
    [{ topic: 'x', ids: ['a1', 'a2'] }, { topic: 'y', ids: ['b1', 'b2'] }],
    wide,
    { threshold: 0.5, maxProposals: 1 },
  )
  assert.equal(proposals.length, 1)
})

const DAY = 86_400_000

test('shouldAutoDream stays shut while the library is small', () => {
  const decision = shouldAutoDream({ now: 10 * DAY, lastAt: 0, activeCount: 3, pending: 0 })
  assert.equal(decision.ok, false)
  assert.match(decision.reason, /3 条/)
})

test('shouldAutoDream waits out the interval and reports the remaining days', () => {
  const decision = shouldAutoDream({ now: 8 * DAY, lastAt: 4 * DAY, activeCount: 12, pending: 0 })
  assert.equal(decision.ok, false)
  assert.match(decision.reason, /还有 3 天/)
})

test('shouldAutoDream is blocked by an unreviewed suggestion', () => {
  const decision = shouldAutoDream({ now: 30 * DAY, lastAt: 0, activeCount: 12, pending: 2 })
  assert.equal(decision.ok, false)
  assert.match(decision.reason, /2 条/)
})

test('shouldAutoDream runs once the volume, the clock and the queue all allow it', () => {
  assert.equal(shouldAutoDream({ now: 7 * DAY, lastAt: 0, activeCount: 8, pending: 0 }).ok, true)
  assert.equal(shouldAutoDream({ now: 40 * DAY, lastAt: 10 * DAY, activeCount: 30, pending: 0 }).ok, true)
  // Custom thresholds are honoured.
  assert.equal(shouldAutoDream({
    now: 2 * DAY, lastAt: 0, activeCount: 4, pending: 0, minMemories: 3, intervalDays: 2,
  }).ok, true)
})
