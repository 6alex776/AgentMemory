import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractSignals, looksSecret, parseItems, roughlyKnown, shouldFlush, similarity, containment } from '../lib/capture.js'

test('extractSignals keeps stated preferences and facts', () => {
  const text = '我是计算机专业本科生。我比较喜欢直接的回答。以后都用 TypeScript 写示例。'
  const signals = extractSignals(text)
  assert.ok(signals.includes('我是计算机专业本科生'))
  assert.ok(signals.includes('以后都用 TypeScript 写示例'))
})

test('extractSignals drops questions, even when they contain signal words', () => {
  const text = '我喜欢什么？我在做什么？'
  assert.equal(extractSignals(text), '')
})

test('extractSignals drops ordinary chatter', () => {
  const text = '帮我把这个文件打开。然后再跑一下测试。'
  assert.equal(extractSignals(text), '')
})

test('extractSignals keeps only the matching sentences', () => {
  const text = '先跑测试。我喜欢简洁的回答。顺便看下日志。'
  assert.equal(extractSignals(text), '我喜欢简洁的回答')
})

test('extractSignals ignores very short fragments', () => {
  assert.equal(extractSignals('我是'), '')
})

test('parseItems reads a clean JSON reply', () => {
  const items = parseItems('{"items":[{"content":"用户是学生","kind":"profile"}]}')
  assert.equal(items.length, 1)
  assert.equal(items[0].content, '用户是学生')
})

test('parseItems survives fences and surrounding prose', () => {
  const reply = '好的，结果如下：\n```json\n{"items":[{"content":"用户喜欢 Flink"}]}\n```\n完毕。'
  const items = parseItems(reply)
  assert.equal(items.length, 1)
  assert.equal(items[0].content, '用户喜欢 Flink')
})

test('parseItems returns empty for malformed or missing JSON', () => {
  assert.deepEqual(parseItems('no json here'), [])
  assert.deepEqual(parseItems('{"ops":[]}'), [])
})

test('similarity is high for near-verbatim text and low for unrelated text', () => {
  const a = '毕业设计是金融湖仓一体的分析看板'
  const b = '毕业设计做的是金融湖仓一体分析看板'
  const c = '用户偏好简洁的回答'
  assert.ok(similarity(a, b) > 0.5)
  assert.ok(similarity(a, c) < 0.2)
})

test('containment catches a restatement that adds detail', () => {
  const short = '毕业设计是金融湖仓一体分析看板'
  const long = '毕业设计是金融湖仓一体分析看板，含实时和离线两条链路，覆盖行情与报表'
  assert.ok(containment(short, long) > 0.85)
  assert.ok(similarity(short, long) < 0.85)
})

test('containment ignores texts too short to be meaningful', () => {
  assert.equal(containment('短句', '短句加上很多很多别的内容以及细节'), 0)
  assert.equal(containment('完全无关的一句话', '另一件毫不相干的事情'), 0)
})

test('roughlyKnown blocks a repeat and allows something new', () => {
  const rows = [{ content: '毕业设计是金融湖仓一体的分析看板' }]
  assert.equal(roughlyKnown(rows, '毕业设计是金融湖仓一体的分析看板'), true)
  assert.equal(roughlyKnown(rows, '用户偏好用 Flink 处理实时行情'), false)
})

test('the turn-boundary trigger waits for a full buffer', () => {
  assert.equal(shouldFlush('我是计算机专业本科生', 300), false)
  assert.equal(shouldFlush('我'.repeat(299), 300), false)
  assert.equal(shouldFlush('我'.repeat(300), 300), true)
})

test('the turn-boundary trigger ignores blank text and has a default floor', () => {
  assert.equal(shouldFlush('   ', 300), false)
  assert.equal(shouldFlush(undefined, 300), false)
  assert.equal(shouldFlush('x'.repeat(299)), false)
  assert.equal(shouldFlush('x'.repeat(300)), true)
})

test('credentials are rejected instead of redacted', () => {
  assert.equal(looksSecret('我的 key 是 sk-abcdefghijklmnop'), true)
  assert.equal(looksSecret('AWS 用 AKIAIOSFODNN7EXAMPLE 这个'), true)
  assert.equal(looksSecret('password: hunter2'), true)
  assert.equal(looksSecret('数据库密码设成 password = abc123'), true)
  assert.equal(looksSecret('存量密码已经迁移到密钥管理服务'), false)
  assert.equal(looksSecret('我们决定用 ClickHouse 替换 PostgreSQL'), false)
})
