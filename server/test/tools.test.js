/**
 * MCP 工具层测试：密钥拦截必须在服务端强制，而不是只写在 instructions 里。
 * Run: node server/test/tools.test.js
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openEngine } from '../engine.js'
import { callTool } from '../tools.js'

const cases = []
const test = (name, fn) => cases.push({ name, fn })

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmemory-tools-'))
  return { dir, engine: openEngine({ dbFile: join(dir, 'memory.db') }) }
}

const isError = (response) => response.isError === true
const body = (response) => response.content?.[0]?.text ?? ''

test('memory_save rejects sk- keys and writes nothing', () => {
  const { dir, engine } = fresh()
  try {
    const response = callTool(engine, 'memory_save', {
      content: '我的 API key 是 sk-abcdefghijklmnop',
      cwd: dir,
    }, dir)
    assert.equal(isError(response), true)
    assert.match(body(response), /密钥/)
    assert.equal(engine.list().length, 0)
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory_save rejects password= and AWS keys', () => {
  const { dir, engine } = fresh()
  try {
    for (const content of ['数据库 password: hunter2', 'AWS 用 AKIAIOSFODNN7EXAMPLE 这个']) {
      assert.equal(isError(callTool(engine, 'memory_save', { content, cwd: dir }, dir)), true, content)
    }
    assert.equal(engine.list().length, 0)
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory_save still accepts ordinary text that mentions keys', () => {
  const { dir, engine } = fresh()
  try {
    const response = callTool(engine, 'memory_save', {
      content: '存量密码已经迁移到密钥管理服务，不再写在配置里',
      kind: 'decision',
      scope: 'project',
      cwd: dir,
    }, dir)
    assert.equal(isError(response), false)
    assert.match(body(response), /added/)
    assert.equal(engine.list().length, 1)
  } finally {
    engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory_update rejects a secret and leaves the row unchanged', () => {
  const { dir, engine } = fresh()
  try {
    const saved = callTool(engine, 'memory_save', { content: '数据存储用 ClickHouse', cwd: dir }, dir)
    const id = JSON.parse(body(saved)).id
    const response = callTool(engine, 'memory_update', { id, content: 'token = sk-abcdefghijklmnop' }, dir)
    assert.equal(isError(response), true)
    assert.equal(engine.get(id).content, '数据存储用 ClickHouse')
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
console.log(`\n${passed}/${cases.length} tool tests passed`)
