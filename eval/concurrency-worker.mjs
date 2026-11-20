/**
 * 压测工人：被 eval/concurrency.mjs 以子进程方式拉起。
 * 参数：dbFile workerIndex count repoRoot
 * 输出：最后一行 JSON（inserted / busy / other / ms）
 */

import { openStore } from '../plugin/lib/store.js'

const [dbFile, indexArg, countArg, repoRoot] = process.argv.slice(2)
const index = Number(indexArg)
const count = Number(countArg)

const startedAt = Date.now()
const store = openStore(dbFile)
const project = store.ensureProject(repoRoot)

let inserted = 0
let busy = 0
let other = 0
let sample = ''

for (let i = 0; i < count; i += 1) {
  try {
    const result = store.add({
      scope: 'project',
      projectId: project.id,
      kind: 'fact',
      // 每个进程独享槽位，冲突只可能来自 SQLite 锁，不会来自业务去重
      topicKey: `w${index}.t${i}`,
      content: `并发压测 进程${index} 第${i}条：数据存储用 ClickHouse，队列用 Kafka，调度用 DolphinScheduler。`,
      importance: 3,
      origin: 'agent',
    })
    if (result.status === 'added') inserted += 1
  } catch (error) {
    const message = String(error?.message ?? error)
    if (/SQLITE_BUSY|database is locked/i.test(message)) busy += 1
    else {
      other += 1
      if (sample === '') sample = message.slice(0, 160)
    }
  }
}

store.close()
console.log(JSON.stringify({ index, inserted, busy, other, sample, ms: Date.now() - startedAt }))
