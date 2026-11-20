/**
 * Engine tests: the host-independent half must be verifiable without DSH.
 * Run: node server/test/engine.test.js
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openEngine } from '../engine.js'

const cases = []
const test = (name, fn) => cases.push({ name, fn })

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmemory-engine-'))
  return { dir, engine: openEngine({ dbFile: join(dir, 'memory.db') }) }
}

test('same topicKey replaces the old value and keeps the chain', () => {
  const { dir, engine } = fresh()
  try {
    const first = engine.save({ content: '数据存储用 PostgreSQL', scope: 'project', cwd: dir, kind: 'decision', topicKey: 'tech.datastore', importance: 4 })
    assert.equal(first.result.status, 'added')
    const second = engine.save({ content: '数据存储用 ClickHouse', scope: 'project', cwd: dir, kind: 'decision', topicKey: 'tech.datastore', importance: 4 })
    assert.equal(second.result.status, 'superseded')
    assert.equal(second.result.replaced, first.result.id)
    const chain = engine.chain('tech.datastore', 'project')
    assert.deepEqual(chain.map((row) => row.status), ['superseded', 'active'])
    assert.deepEqual(chain.map((row) => row.content), ['数据存储用 PostgreSQL', '数据存储用 ClickHouse'])
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inject splits identity, project and retrieval without leaking cross-scope rows', () => {
  const { dir, engine } = fresh()
  try {
    engine.save({ content: '用户是计算机专业本科生', scope: 'global', cwd: dir, kind: 'profile', importance: 5 })
    engine.save({ content: '数据存储用 ClickHouse', scope: 'project', cwd: dir, kind: 'decision', importance: 4 })
    engine.save({ content: '行情数据用 FAKEPACA 脚本生成模拟盘口', scope: 'project', cwd: dir, kind: 'fact', importance: 2 })
    const parts = engine.inject({ cwd: dir, question: '行情数据是怎么模拟的' })
    assert.match(parts.identity.text, /计算机专业本科生/)
    assert.match(parts.project.text, /ClickHouse/)
    // importance 2 is below the project gate, so it can only arrive via retrieval.
    assert.doesNotMatch(parts.project.text, /FAKEPACA/)
    assert.match(parts.retrieval.text, /FAKEPACA/)
    assert.ok(parts.chars >= parts.identity.chars + parts.project.chars)
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retrieval never repeats a row that is already in the persistent blocks', () => {
  const { dir, engine } = fresh()
  try {
    engine.save({ content: '数据存储用 ClickHouse', scope: 'project', cwd: dir, kind: 'decision', importance: 4 })
    const parts = engine.inject({ cwd: dir, question: '我们的数据存储用什么' })
    assert.match(parts.project.text, /ClickHouse/)
    assert.equal(parts.retrieval.ids.length, 0)
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('project scope needs a cwd', () => {
  const { dir, engine } = fresh()
  try {
    assert.throws(() => engine.save({ content: 'x'.repeat(8), scope: 'project' }), /cwd/)
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('promptFor joins only the non-empty blocks', () => {
  const { dir, engine } = fresh()
  try {
    engine.save({ content: '用户偏好先给结论', scope: 'global', cwd: dir, kind: 'preference', importance: 4 })
    const prompt = engine.promptFor({ cwd: dir })
    assert.match(prompt, /先给结论/)
    assert.doesNotMatch(prompt, /\n\n\n/)
    assert.equal(engine.promptFor({ cwd: join(dir, 'nope') }), engine.inject({ cwd: join(dir, 'nope') }).identity.text)
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('forget tombstones a slot so the deleted value does not come back by itself', () => {
  const { dir, engine } = fresh()
  try {
    const { result } = engine.save({ content: '数据存储用 ClickHouse', scope: 'project', cwd: dir, kind: 'decision', topicKey: 'tech.datastore', importance: 4 })
    assert.equal(engine.forget(result.id), true)
    assert.equal(engine.get(result.id).status, 'deleted')
    const again = engine.save({ content: '数据存储用 ClickHouse', scope: 'project', cwd: dir, kind: 'decision', topicKey: 'tech.datastore', importance: 4 })
    assert.equal(again.result.status, 'tombstoned')
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

let passed = 0
for (const { name, fn } of cases) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}
console.log(`\n${passed}/${cases.length} engine tests passed`)
