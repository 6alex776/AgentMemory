import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { openStore } from '../lib/store.js'

/** Fresh store in a unique directory; caller must call dispose(). */
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmemory-test-'))
  const file = join(dir, 'memory.db')
  const store = openStore(file)
  return {
    store,
    file,
    dir,
    dispose() {
      try { store.close() } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function run(t, fn) {
  const ctx = makeStore()
  try {
    fn(ctx.store, ctx)
  } finally {
    ctx.dispose()
  }
  assert.ok(t)
}

test('add stores a memory and returns it as active', (t) => run(t, (store) => {
  const result = store.add({ scope: 'global', kind: 'profile', content: '用户是计算机专业本科生' })
  assert.equal(result.status, 'added')

  const active = store.list({})
  assert.equal(active.length, 1)
  assert.equal(active[0].content, '用户是计算机专业本科生')
  assert.equal(active[0].status, 'active')
  assert.equal(active[0].rev, 1)
}))

test('same content twice is a duplicate, not a second row', (t) => run(t, (store) => {
  const first = store.add({ scope: 'global', kind: 'fact', content: '项目使用 Docker' })
  const second = store.add({ scope: 'global', kind: 'fact', content: '项目使用 Docker' })

  assert.equal(second.status, 'duplicate')
  assert.equal(second.id, first.id)
  assert.equal(store.list({}).length, 1)
}))

test('normalization collapses whitespace and width when detecting duplicates', (t) => run(t, (store) => {
  store.add({ scope: 'global', kind: 'fact', content: '使用 SQLite  存储' })
  const again = store.add({ scope: 'global', kind: 'fact', content: '使用 SQLite 存储' })
  assert.equal(again.status, 'duplicate')
}))

test('a new value in the same slot supersedes the old one and keeps history', (t) => run(t, (store) => {
  const old = store.add({
    scope: 'global', kind: 'profile', topicKey: 'career.direction', content: '职业方向：Java 后端',
  })
  const next = store.add({
    scope: 'global', kind: 'profile', topicKey: 'career.direction', content: '职业方向：大数据平台',
  })

  assert.equal(next.status, 'superseded')
  assert.equal(next.replaced, old.id)

  const active = store.list({ statuses: ['active'] })
  assert.equal(active.length, 1)
  assert.equal(active[0].content, '职业方向：大数据平台')
  assert.equal(active[0].supersedes_id, old.id)

  const retired = store.list({ statuses: ['superseded'] })
  assert.equal(retired.length, 1)
  assert.equal(retired[0].content, '职业方向：Java 后端')

  const versions = store.history(old.id)
  assert.equal(versions[0].op, 'supersede')
  assert.equal(JSON.parse(versions[0].after_json).status, 'superseded')
}))

test('the same slot with identical content is idempotent', (t) => run(t, (store) => {
  const first = store.add({ scope: 'global', kind: 'fact', topicKey: 'k', content: '同一个值' })
  const second = store.add({ scope: 'global', kind: 'fact', topicKey: 'k', content: '同一个值' })
  assert.equal(second.status, 'duplicate')
  assert.equal(second.id, first.id)
  assert.equal(store.list({ statuses: ['active'] }).length, 1)
}))

test('a tombstone blocks silent resurrection unless forced', (t) => run(t, (store) => {
  const first = store.add({ scope: 'global', kind: 'fact', topicKey: 't', content: '会被删掉的记忆' })
  assert.equal(store.forget(first.id), true)

  const blocked = store.add({ scope: 'global', kind: 'fact', topicKey: 't', content: '会被删掉的记忆' })
  assert.equal(blocked.status, 'tombstoned')
  assert.equal(blocked.id, first.id)

  const forced = store.add({
    scope: 'global', kind: 'fact', topicKey: 't', content: '会被删掉的记忆', force: true,
  })
  assert.equal(forced.status, 'added')
  assert.notEqual(forced.id, first.id)
}))

test('project scope needs a project and stays isolated in search', (t) => run(t, (store) => {
  assert.throws(() => store.add({ scope: 'project', kind: 'fact', content: '没有项目的项目记忆' }))

  const a = store.ensureProject('C:/work/alpha')
  const b = store.ensureProject('C:/work/beta')
  assert.notEqual(a.id, b.id)

  store.add({ scope: 'project', projectId: a.id, kind: 'decision', content: 'Alpha 使用 Flink 处理实时行情' })
  store.add({ scope: 'project', projectId: b.id, kind: 'decision', content: 'Beta 使用 Spark 跑离线报表' })
  store.add({ scope: 'global', kind: 'preference', content: '偏好简洁的回答' })

  const inAlpha = store.search('使用', { projectId: a.id })
  assert.deepEqual(inAlpha.map((row) => row.content), ['Alpha 使用 Flink 处理实时行情'])

  const inBeta = store.search('使用', { projectId: b.id })
  assert.deepEqual(inBeta.map((row) => row.content), ['Beta 使用 Spark 跑离线报表'])
}))

test('two-character Chinese queries match through the bigram index', (t) => run(t, (store) => {
  store.add({ scope: 'global', kind: 'fact', content: '正在做金融湖仓一体的毕业设计' })
  assert.equal(store.search('湖仓').length, 1)
  assert.equal(store.search('毕业设计').length, 1)
  assert.equal(store.search('不存在').length, 0)
}))

test('single-character queries fall back to LIKE', (t) => run(t, (store) => {
  store.add({ scope: 'global', kind: 'fact', content: '用户喜欢用 Java 写后端' })
  const rows = store.search('J')
  assert.equal(rows.length, 1)
}))

test('update bumps rev, rewrites search text, and logs a version', (t) => run(t, (store) => {
  const { id } = store.add({ scope: 'global', kind: 'fact', content: '旧的内容：Kafka 消费行情' })
  assert.equal(store.update(id, { content: '新的内容：Flink 消费行情' }), true)

  const row = store.list({})[0]
  assert.equal(row.content, '新的内容：Flink 消费行情')
  assert.equal(row.rev, 2)
  assert.equal(store.search('Flink').length, 1)
  assert.equal(store.search('Kafka').length, 0, 'stale search text must be gone')

  const ops = store.history(id).map((version) => version.op)
  assert.deepEqual(ops, ['update', 'create'])
}))

test('rollback restores an earlier value and is itself recorded', (t) => run(t, (store) => {
  const { id } = store.add({ scope: 'global', kind: 'fact', content: 'V0' })
  store.update(id, { content: 'V1' })
  store.update(id, { content: 'V2' })

  const versions = store.history(id)
  const v1 = versions.find((version) => JSON.parse(version.after_json).content === 'V1')
  assert.ok(v1 !== undefined)

  assert.equal(store.rollback(id, v1.id), true)
  assert.equal(store.list({})[0].content, 'V1')

  const create = store.history(id).find((version) => version.op === 'create')
  assert.equal(store.rollback(id, create.id), true)
  assert.equal(store.list({})[0].content, 'V0')

  const ops = store.history(id).map((version) => version.op)
  assert.deepEqual(ops, ['rollback', 'rollback', 'update', 'update', 'create'])
}))

test('rollback cannot resurrect a deleted memory or use a foreign version', (t) => run(t, (store) => {
  const { id } = store.add({ scope: 'global', kind: 'fact', content: 'X' })
  const version = store.history(id)[0]
  store.forget(id)
  assert.equal(store.rollback(id, version.id), false)

  const other = store.add({ scope: 'global', kind: 'fact', content: 'Y' })
  assert.equal(store.rollback(other.id, version.id), false)
}))

test('forget is soft, restore brings it back, purge removes it for good', (t) => run(t, (store) => {
  const { id } = store.add({ scope: 'global', kind: 'fact', content: '可恢复的记忆' })

  assert.equal(store.forget(id), true)
  assert.equal(store.list({ statuses: ['active'] }).length, 0)
  assert.equal(store.list({ statuses: ['deleted'] }).length, 1)

  assert.equal(store.restore(id), true)
  assert.equal(store.list({ statuses: ['active'] }).length, 1)

  assert.equal(store.purge(id), true)
  assert.equal(store.list({ statuses: ['active'] }).length, 0)
  assert.equal(store.history(id).length, 0, 'purge removes version history too')
}))

test('restore supersedes a competing active value in the same slot', (t) => run(t, (store) => {
  const old = store.add({ scope: 'global', kind: 'profile', topicKey: 'k', content: '旧值' })
  store.forget(old.id)
  const fresh = store.add({ scope: 'global', kind: 'profile', topicKey: 'k', content: '新值' })

  assert.equal(store.restore(old.id), true)
  const active = store.list({ statuses: ['active'] })
  assert.equal(active.length, 1)
  assert.equal(active[0].content, '旧值')
  const retired = store.list({ statuses: ['superseded'] }).map((row) => row.id)
  assert.deepEqual(retired, [fresh.id])
}))

test('overview revision is stable, changes with the active set, and returns', (t) => run(t, (store) => {
  store.add({ scope: 'global', kind: 'fact', content: 'A' })
  const before = store.summarySourceRev()

  assert.equal(store.summarySourceRev(), before, 'unchanged set must hash the same')

  store.summarySave('一段概览', 'test/model')
  assert.equal(store.summaryGet().stale, false)
  assert.equal(store.summaryGet().content, '一段概览')

  const extra = store.add({ scope: 'global', kind: 'fact', content: 'B' })
  assert.equal(store.summaryGet().stale, true)
  assert.notEqual(store.summarySourceRev(), before)

  store.purge(extra.id)
  assert.equal(store.summaryGet().stale, false, 'undoing the change must make the overview fresh again')
  assert.equal(store.summarySourceRev(), before)
}))

test('state groups by kind and by project', (t) => run(t, (store) => {
  const project = store.ensureProject('C:/work/gamma')
  store.add({ scope: 'global', kind: 'profile', content: 'P' })
  store.add({ scope: 'global', kind: 'preference', content: 'R' })
  store.add({ scope: 'project', projectId: project.id, kind: 'decision', content: 'D' })

  const state = store.state()
  assert.equal(state.counts.total, 3)
  assert.equal(state.counts.project, 1)
  assert.deepEqual(state.groups.map((group) => group.title), ['用户背景', '偏好', '项目：gamma'])
  assert.equal(state.summary.currentRev, store.summarySourceRev())
}))

test('abstracts are short, deterministic, and refreshed on update', (t) => run(t, (store) => {
  const long = '用户正在做基于湖仓一体的金融实时与离线分析看板毕业设计，技术栈包括 Kafka、Flink 和 Iceberg'
  const { id } = store.add({ scope: 'global', kind: 'profile', content: long })

  const created = store.list({})[0]
  assert.ok(created.abstract.length <= 41, `abstract too long: ${created.abstract.length}`)
  assert.ok(long.startsWith(created.abstract.replace(/…$/, '')), 'abstract must be a prefix of the content')

  store.update(id, { content: '短内容' })
  assert.equal(store.list({})[0].abstract, '短内容')
}))

test('accepting a merge proposal creates one memory and retires the sources', (t) => run(t, (store) => {
  const a = store.add({ scope: 'global', kind: 'fact', content: '毕业设计做的是金融湖仓平台' })
  const b = store.add({ scope: 'global', kind: 'fact', content: '毕业设计方向是金融湖仓一体分析看板' })

  const proposalId = store.proposalInsert(
    'merge',
    { ids: [a.id, b.id], content: '毕业设计为金融湖仓一体的分析看板' },
    '两条描述同一件事',
  )
  assert.equal(store.proposalsPending().length, 1)

  const result = store.decideProposal(proposalId, true)
  assert.equal(result.ok, true)
  assert.equal(result.applied.ok, true)
  assert.equal(result.applied.merged, 2)

  const active = store.list({ statuses: ['active'] })
  assert.equal(active.length, 1)
  assert.equal(active[0].content, '毕业设计为金融湖仓一体的分析看板')
  assert.equal(store.list({ statuses: ['deleted'] }).length, 2)
  assert.equal(store.proposalsPending().length, 0)
}))

test('rejecting a proposal changes nothing', (t) => run(t, (store) => {
  const a = store.add({ scope: 'global', kind: 'fact', content: '甲' })
  const b = store.add({ scope: 'global', kind: 'fact', content: '乙' })
  const proposalId = store.proposalInsert('merge', { ids: [a.id, b.id], content: '丙' }, '测试')

  const result = store.decideProposal(proposalId, false)
  assert.equal(result.ok, true)
  assert.equal(store.list({ statuses: ['active'] }).length, 2)
  assert.equal(store.proposalsPending().length, 0)
}))

test('a merge proposal needs two live memories to apply', (t) => run(t, (store) => {
  const a = store.add({ scope: 'global', kind: 'fact', content: '甲' })
  store.forget(a.id)
  const proposalId = store.proposalInsert('merge', { ids: [a.id, 'm_deadbeef0000'], content: '丙' }, '测试')
  assert.equal(store.decideProposal(proposalId, true).applied.ok, false)
}))

test('an expire proposal soft-deletes its target', (t) => run(t, (store) => {
  const a = store.add({ scope: 'global', kind: 'fact', content: '会被整理掉的记忆' })
  const proposalId = store.proposalInsert('expire', { id: a.id }, '已过期')
  const result = store.decideProposal(proposalId, true)
  assert.equal(result.applied.ok, true)
  assert.equal(store.list({ statuses: ['active'] }).length, 0)
  assert.equal(store.list({ statuses: ['deleted'] }).length, 1)
}))

test('deciding an unknown proposal is refused', (t) => run(t, (store) => {
  assert.equal(store.decideProposal(999, true).ok, false)
}))

test('a Git checkout is one project even from a subdirectory', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmemory-git-'))
  const parent = makeStore()
  try {
    mkdirSync(join(dir, '.git'), { recursive: true })
    const nested = join(dir, 'packages', 'app')
    mkdirSync(nested, { recursive: true })

    const fromRoot = parent.store.ensureProject(dir)
    const fromNested = parent.store.ensureProject(nested)
    assert.equal(fromNested.id, fromRoot.id)
    assert.equal(parent.store.resolveProject(nested).id, fromRoot.id)
  } finally {
    parent.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('without Git, sibling directories stay separate projects', (t) => run(t, (store) => {
  const a = store.ensureProject('C:/work/alpha/src')
  const b = store.ensureProject('C:/work/beta/src')
  assert.notEqual(a.id, b.id)
}))

test('markUsed counts one exposure per memory', (t) => run(t, (store) => {
  const { id } = store.add({ scope: 'global', kind: 'fact', content: '会被注入的记忆' })
  assert.equal(store.markUsed([id]), 1)
  assert.equal(store.markUsed([id, 'm_missing000000']), 1)
  const row = store.list({})[0]
  assert.equal(row.use_count, 2)
  assert.ok(row.last_used_at > 0)
  assert.equal(store.markUsed([]), 0)
}))

test('session switch defaults to on and can be turned off', (t) => run(t, (store) => {
  const id = 'session-test-1'
  assert.equal(store.sessionAllowed(id), true)
  assert.equal(store.setSessionAllowed(id, false), true)
  assert.equal(store.sessionAllowed(id), false)
  store.setSessionAllowed(id, true)
  assert.equal(store.sessionAllowed(id), true)
  assert.equal(store.setSessionAllowed('', true), false)
}))

test('expiry is stored, and confirming clears it', (t) => run(t, (store) => {
  const future = Date.now() + 3 * 86_400_000
  const { id } = store.add({ scope: 'global', kind: 'fact', content: '下个月要答辩', expiresAt: future })
  const created = store.get(id)
  assert.equal(created.expires_at, future)
  assert.ok(created.last_verified_at > 0)

  assert.equal(store.verify(id), true)
  const verified = store.get(id)
  assert.equal(verified.expires_at, null)
  assert.ok(verified.last_verified_at >= created.last_verified_at)
  assert.equal(store.history(id)[0].op, 'verify')
}))

test('editing content re-confirms the memory', (t) => run(t, (store) => {
  const { id } = store.add({ scope: 'global', kind: 'fact', content: '旧内容' })
  const before = store.get(id).last_verified_at
  store.update(id, { content: '新内容' })
  assert.ok(store.get(id).last_verified_at >= before)
}))

test('a merge whose text equals one source keeps that source', (t) => run(t, (store) => {
  const longer = '更长更完整的那一条记忆内容，应该被保留下来'
  const a = store.add({ scope: 'global', kind: 'fact', content: '短句' })
  const b = store.add({ scope: 'global', kind: 'fact', content: longer })

  const proposalId = store.proposalInsert('merge', { ids: [a.id, b.id], content: longer }, '合并')
  const result = store.decideProposal(proposalId, true)
  assert.equal(result.applied.ok, true)
  assert.equal(result.applied.id, b.id)
  assert.equal(result.applied.merged, 1)

  const active = store.list({ statuses: ['active'] })
  assert.equal(active.length, 1)
  assert.equal(active[0].id, b.id, 'the surviving copy must not be retired')
}))

test('a turn trace records what the turn carried and expands the ids', (t) => run(t, (store) => {
  const core = store.add({ scope: 'global', kind: 'profile', content: '常驻记忆一条' })
  const hit = store.add({ scope: 'global', kind: 'fact', content: '本轮检索命中的记忆' })

  assert.equal(store.recordTurn('s1', 3, {
    question: '我的毕设做到哪了',
    coreIds: [core.id],
    retrievalIds: [hit.id, 'm_missing000000'],
    retrievalChars: 88,
    startedAt: 1000,
  }), true)

  const trace = store.readTurn('s1', 3)
  assert.equal(trace.question, '我的毕设做到哪了')
  assert.equal(trace.retrievalChars, 88)
  assert.equal(trace.core.length, 1)
  assert.equal(trace.core[0].abstract.length > 0, true)
  assert.equal(trace.retrieval.length, 2)
  assert.equal(trace.retrieval[1].missing, true)
}))

test('a second write for the same turn patches instead of duplicating', (t) => run(t, (store) => {
  const core = store.add({ scope: 'global', kind: 'profile', content: '只用于常驻的记忆' })
  store.recordTurn('s2', 1, { question: '第一版问题', coreIds: [core.id], startedAt: 2000 })
  store.recordTurn('s2', 1, { retrievalIds: [], retrievalChars: 0, startedAt: 9000 })

  const trace = store.readTurn('s2', 1)
  assert.equal(trace.question, '第一版问题', 'the later write must not erase the question')
  assert.equal(trace.core.length, 1)
  assert.equal(trace.startedAt, 2000, 'the first render fixes the turn window')
  assert.equal(store.readTurn('s2', 2), undefined)
  assert.equal(store.readTurn('', 1), undefined)
}))

test('added counts memories created inside the turn window only', (t) => run(t, (store) => {
  store.recordTurn('s3', 1, { startedAt: 10000 })
  store.recordTurn('s3', 2, { startedAt: 50000 })

  const inWindow = store.add({
    scope: 'global', kind: 'fact', content: '第一轮期间存入的记忆', sessionId: 's3',
  })
  const afterWindow = store.add({
    scope: 'global', kind: 'fact', content: '第二轮之后存入的记忆', sessionId: 's3',
  })
  const other = store.add({
    scope: 'global', kind: 'fact', content: '别的会话存入的记忆', sessionId: 's9',
  })
  const first = store.readTurn('s3', 1)
  assert.equal(first.added, 0, 'both writes happened after the window closed')

  // Backdate one row into the first turn to prove the boundary is used.
  store.db.prepare('UPDATE memory SET created_at = 20000 WHERE id = ?').run(inWindow.id)
  store.db.prepare('UPDATE memory SET created_at = 60000 WHERE id = ?').run(afterWindow.id)
  store.db.prepare('UPDATE memory SET created_at = 20000 WHERE id = ?').run(other.id)
  assert.equal(store.readTurn('s3', 1).added, 1, 'only memories from this session count')
  assert.equal(store.readTurn('s3', 2).added, 1, 'an open turn counts up to now')
}))

test('the dream clock survives a reopen', (t) => {
  const ctx = makeStore()
  try {
    assert.equal(ctx.store.dreamLastAt(), 0, 'a fresh library has never been consolidated')
    assert.deepEqual(ctx.store.state().dream, { at: 0, created: 0 })

    ctx.store.noteDream(1_700_000_000_000, 3)
    assert.equal(ctx.store.dreamLastAt(), 1_700_000_000_000)
    assert.deepEqual(ctx.store.state().dream, { at: 1_700_000_000_000, created: 3 })

    // A restart must not look like a week has passed.
    ctx.store.close()
    const reopened = openStore(ctx.file)
    try {
      assert.equal(reopened.dreamLastAt(), 1_700_000_000_000)
    } finally {
      reopened.close()
    }
  } finally {
    ctx.dispose()
  }
})

test('a database from a newer plugin is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmemory-version-'))
  const file = join(dir, 'memory.db')
  const raw = new DatabaseSync(file)
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT")
  raw.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '99')").run()
  raw.close()

  assert.throws(() => openStore(file), /schema v99/)
  rmSync(dir, { recursive: true, force: true })
})
